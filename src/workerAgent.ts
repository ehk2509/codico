import * as fs from 'fs';
import * as vscode from 'vscode';
import * as nodeCrypto from 'crypto';
import { AgentTurn, TurnHost } from './agentTurn';
import { Approvals } from './approvals';
import { BackgroundAgent } from './backgroundTaskRunner';
import { BackgroundTask } from './backgroundTasks';
import { ExtensionMessage, DisplayMessage } from './chatProtocol';
import { listDirectoryTool } from './chatFiles';
import { CommandApprovalStore } from './commandApprovalStore';
import { Compaction } from './compaction';
import { projectHistoryForModel } from './contextProjection';
import { EditProposalManager } from './editProposalManager';
import { EvaluationToolTraceEvent } from './evaluationMetrics';
import { FileManager } from './fileManager';
import { messageText } from './historyCompaction';
import { ChatMessage } from './openRouterClient';
import { accoOptimizerFromConfiguration } from './accoProviderOptimizer';
import { PassportRecorder, PatchPassport } from './patchPassport';
import { loadRepoInstructions } from './projectMemoryStore';
import { readFileTool } from './readFileTool';
import { SubagentHost } from './subagent';
import { TaskUsage } from './taskUsage';
import { ToolCall } from './toolParser';
import { runInToolRoot } from './toolRoot';
import { resolveModelAccess, systemPrefix } from './turnSetup';
import { UndoRedoStack } from './undoRedoStack';
import { WorkspaceTools } from './workspaceTools';

/** What a worker may use: files and commands in its own worktree. Nothing that reaches the workspace, the editor or the web. */
export const WORKER_TOOLS: ReadonlySet<ToolCall['type']> = new Set(['read_file', 'list_directory', 'search_files', 'find_files', 'write_file', 'edit_file', 'run_terminal', 'update_todo']);

/** What a worker needs from the window it runs in. */
export interface WorkerDeps {
    readonly context: vscode.ExtensionContext;
    readonly editProposals: EditProposalManager;
    approvedCommands(): CommandApprovalStore;
    readonly evaluationMode: boolean;
    /** Where its conversation is kept between replies, so that it can be resumed after a reload. */
    readonly historyFile?: string;
    /**
     * It works from text other people wrote (an issue, a CI log, a review): its commands are not
     * covered by "allow all" unless they run in the command sandbox.
     */
    readonly untrusted?: () => boolean;
    /** Everything the worker shows: its steps and text, and the questions it asks. */
    post(message: ExtensionMessage): void;
}

/**
 * A team's worker running in the team's own window: a conversation of its own, the same agent
 * loop as the panel's, and tools that work in its git worktree (see toolRoot). It is driven
 * like a background task's window (runTask), so the orchestrator meets it the same way.
 */
export class WorkerAgent implements BackgroundAgent {
    readonly ready = true;
    backgroundPermissions: BackgroundTask['permissions'] = 'edits';
    backgroundListener?: (message: ExtensionMessage) => void;
    readonly approvals = new Approvals(message => this._emit(message));
    private _history: ChatMessage[] = [];
    private _display: DisplayMessage[] = [];
    private _steer = '';
    private _busy = false;
    private _queue: string[] = [];
    private _abort: AbortController | undefined;
    private _passport = new PassportRecorder();
    private _lastPassport: PatchPassport | undefined;
    private _lastInlineResult: string | undefined;
    private readonly _sessionAbort = new AbortController();
    private readonly _tools: WorkspaceTools;
    private readonly _turn: TurnHost;

    constructor(private readonly _task: BackgroundTask, private readonly _deps: WorkerDeps) {
        const undo = new UndoRedoStack(async () => false);
        this._tools = new WorkspaceTools({
            post: message => this._emit(message), approvals: this.approvals, undo, passport: () => this._passport, editProposals: _deps.editProposals,
            fileManager: new FileManager(), approvedCommands: () => _deps.approvedCommands(), evaluationMode: () => _deps.evaluationMode,
            editsMode: () => false, untrustedContentSeen: () => _deps.untrusted?.() ?? false, fileWritten: () => undefined,
        });
        if (_deps.historyFile) {
            try { const saved = JSON.parse(fs.readFileSync(_deps.historyFile, 'utf8')); if (Array.isArray(saved)) { this._history = saved; } } catch { /* a new conversation */ }
        }
        const self = this;
        let compactRetryAt = 0; let lastPromptTokens = 0; let subagentHost: SubagentHost | undefined;
        let evalTrace: EvaluationToolTraceEvent[] = []; const counters = { budget: false, completion: 0, omitted: 0, prompt: 0, steps: 0, calls: 0 };
        const compaction = new Compaction({
            get history() { return self._history; }, set history(value) { self._history = value; },
            get compactRetryAt() { return compactRetryAt; }, set compactRetryAt(value) { compactRetryAt = value; },
            get lastPromptTokens() { return lastPromptTokens; }, set lastPromptTokens(value) { lastPromptTokens = value; },
            post: message => this._emit(message), save: async () => undefined, sessionSignal: () => this._sessionAbort.signal,
        });
        this._turn = {
            approvals: this.approvals, autoCompact: true, compaction, evaluationMode: _deps.evaluationMode, evaluationTokenBudget: 0,
            readOnly: false, team: false, allowedTools: WORKER_TOOLS, thinkingEffort: 'medium',
            get compactRetryAt() { return compactRetryAt; }, set compactRetryAt(value) { compactRetryAt = value; },
            get displayMessages() { return self._display; }, set displayMessages(value) { self._display = value; },
            get evalBudgetExceeded() { return counters.budget; }, set evalBudgetExceeded(value) { counters.budget = value; },
            get evalCompletionTokens() { return counters.completion; }, set evalCompletionTokens(value) { counters.completion = value; },
            get evalProjectedCharsOmitted() { return counters.omitted; }, set evalProjectedCharsOmitted(value) { counters.omitted = value; },
            get evalPromptTokens() { return counters.prompt; }, set evalPromptTokens(value) { counters.prompt = value; },
            get evalSteps() { return counters.steps; }, set evalSteps(value) { counters.steps = value; },
            get evalToolCalls() { return counters.calls; }, set evalToolCalls(value) { counters.calls = value; },
            get evalTrace() { return evalTrace; }, set evalTrace(value) { evalTrace = value; },
            get history() { return self._history; }, set history(value) { self._history = value; },
            get lastInlineResult() { return self._lastInlineResult; }, set lastInlineResult(value) { self._lastInlineResult = value; },
            get lastPromptTokens() { return lastPromptTokens; }, set lastPromptTokens(value) { lastPromptTokens = value; },
            get steer() { return self._steer; }, set steer(value) { self._steer = value; },
            get subagentHost() { return subagentHost; }, set subagentHost(value) { subagentHost = value; },
            post: message => this._emit(message), dispatchTool: (tool, msgId, signal) => this._dispatch(tool, msgId, signal),
        };
    }

    get busy(): boolean { return this._busy; }
    /** The change report of its last reply: what it changed and what it checked. */
    get passport(): PatchPassport | undefined { return this._lastPassport; }

    private _emit(message: ExtensionMessage): void {
        this._deps.post(message);
        this.backgroundListener?.(message);
    }

    lastReplyUsage(): DisplayMessage['usage'] { return this._display.filter(m => m.role === 'assistant').at(-1)?.usage; }

    lastReplyText(): string {
        const last = [...this._history].reverse().find(m => m.role === 'assistant' && messageText(m).trim());
        return last ? messageText(last).replace(/(`{3,})[a-z_]+\n[\s\S]*?\1/g, '').trim() : '';
    }

    async teamMessage(text: string): Promise<'steered' | 'answered'> {
        if (this._busy) { this._steer = this._steer ? `${this._steer}\n\n${text}` : text; return 'steered'; }
        void this.sendMessage(text);
        return 'answered';
    }

    /** Stops what it is doing; its open questions are answered no. */
    stop(): void { this._queue = []; this._steer = ''; this._abort?.abort(); this.approvals.cancelAll(); }

    /** Ends it for good: nothing it started goes on. */
    dispose(): void { this.stop(); this._sessionAbort.abort(); this._tools.killBackgroundProcesses(); }

    /** Runs one turn of its conversation, in its worktree. A message sent meanwhile waits for it. */
    async sendMessage(text: string): Promise<void> {
        if (this._busy) { this._queue.push(text); return; }
        this._busy = true;
        const abort = new AbortController(); this._abort = abort;
        const msgId = nodeCrypto.randomBytes(6).toString('hex');
        try {
            await runInToolRoot(this._task.worktree, () => this._turnOnce(text, msgId, abort.signal));
        } finally {
            this._busy = false; this._abort = undefined;
            // A message from the orchestrator that came after the last step is not lost
            if (this._steer) { this._queue.push(this._steer); this._steer = ''; }
            const next = this._queue.shift();
            if (next !== undefined && !this._sessionAbort.signal.aborted) { void this.sendMessage(next); }
        }
    }

    private async _turnOnce(text: string, msgId: string, signal: AbortSignal): Promise<void> {
        const config = vscode.workspace.getConfiguration('codico');
        const access = await resolveModelAccess(this._deps.context, config);
        if ('error' in access) { this._emit({ type: 'error', message: access.error }); this._emit({ type: 'endMessage', id: msgId }); return; }
        const { model, isOllama, isCli, isDirect, ollamaModel, ollamaBaseUrl, directParsed, apiKey, directApiKey } = access;
        // What it may do without asking; in automated tests nobody is there to ask
        this.approvals.allowAllWrites = this._deps.evaluationMode || this.backgroundPermissions !== 'ask';
        this.approvals.allowAllCommands = this._deps.evaluationMode || this.backgroundPermissions === 'all';
        const effectivePrefix = systemPrefix({ repoInstructions: await loadRepoInstructions(), customPrefix: config.get<string>('systemPrompt', '') || undefined, summary: false });
        const historyRollbackLen = this._history.length; const displayRollbackLen = this._display.length;
        this._history.push({ role: 'user', content: text });
        this._display.push({ role: 'user', text: text.slice(0, 20_000), at: Date.now() });
        this._passport = new PassportRecorder();
        const taskUsage = new TaskUsage(config.get<number>('taskTokenBudget', 0));
        this._emit({ type: 'startMessage', id: msgId });
        await new AgentTurn(this._turn).run({
            accoOptimizer: accoOptimizerFromConfiguration(config, !isOllama && !isCli), apiKey, config, directApiKey, directParsed, displayRollbackLen, effectivePrefix,
            historyRollbackLen, isCli, isDirect, isOllama, maxIterations: config.get<number>('maxIterations', 0), model, msgId,
            mutationGraceIterations: config.get<number>('mutationGraceIterations', 3), nativeToolCalling: config.get<boolean>('nativeToolCalling', true),
            ollamaBaseUrl, ollamaModel, rawText: text, taskUsage, verificationGraceIterations: config.get<number>('verificationGraceIterations', 4), signal,
        });
        this._lastPassport = this._passport.build();
        this._display.push({ role: 'assistant', text: this.lastReplyText().slice(0, 300), at: Date.now(), usage: taskUsage.record() });
        // Kept before it is reported finished: whoever resumes it next finds the whole conversation
        if (this._deps.historyFile) { try { fs.writeFileSync(this._deps.historyFile, JSON.stringify(this._history), { mode: 0o600 }); } catch { /* resumable only while the window is open */ } }
        this._emit({ type: 'endMessage', id: msgId });
    }

    private async _dispatch(tool: ToolCall, msgId: string, signal: AbortSignal): Promise<void> {
        if (signal.aborted) { return; }
        const post = (message: ExtensionMessage) => this._emit(message);
        let result: string;
        switch (tool.type) {
            case 'write_file': post({ type: 'toolStart', id: msgId, tool: tool.type, label: tool.filepath }); result = await this._tools.writeFile(tool, msgId); break;
            case 'edit_file': post({ type: 'toolStart', id: msgId, tool: tool.type, label: tool.filepath }); result = await this._tools.editFile(tool, msgId); break;
            case 'run_terminal': post({ type: 'toolStart', id: msgId, tool: tool.type, label: tool.command.slice(0, 72) }); result = await this._tools.runTerminal(tool, msgId, signal); break;
            case 'search_files': post({ type: 'toolStart', id: msgId, tool: tool.type, label: tool.pattern }); result = await this._tools.searchFiles(tool, msgId); break;
            case 'find_files': post({ type: 'toolStart', id: msgId, tool: tool.type, label: tool.pattern }); result = await this._tools.findFiles(tool, msgId); break;
            case 'read_file':
                post({ type: 'toolStart', id: msgId, tool: tool.type, label: tool.filepath });
                result = await readFileTool(tool, projectHistoryForModel(this._history).history, outcome => post({ type: 'toolResult', id: msgId, tool: 'read_file', ...outcome }));
                break;
            case 'list_directory':
                post({ type: 'toolStart', id: msgId, tool: tool.type, label: tool.dirpath });
                result = await listDirectoryTool(tool.dirpath, outcome => post({ type: 'toolResult', id: msgId, tool: 'list_directory', label: tool.dirpath, ...outcome }));
                break;
            case 'update_todo': post({ type: 'todoUpdate', id: msgId, items: tool.items }); result = '[update_todo] Task list updated.'; break;
            default:
                post({ type: 'toolResult', id: msgId, tool: tool.type, label: tool.type, success: false, error: 'Not available to a team worker' });
                result = `[${tool.type}] Not available to a team worker: you work with the files and commands of your own worktree only. Do without it, or say in your report what you needed.`;
        }
        this._lastInlineResult = result;
    }
}
