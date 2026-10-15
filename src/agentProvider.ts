import * as vscode from 'vscode';
import * as path from 'path';
import * as nodeCrypto from 'crypto';
import { ChatMessage, MessageContentPart } from './openRouterClient';
import { directSingleCompletion, parseDirectModelId, directSecretKey } from './directProviderClient';
import { ToolCall } from './toolParser';
import { FileManager } from './fileManager';
import { parseAgentMention, buildAgentContext } from './agentRouter';
import { expandSkillCommand, parseUserAgentMention, skillsPromptSection, userAgentPrefix, userExtensionsMessage } from './userExtensions';
import { UserExtensionsLoader } from './userExtensionsLoader';
import { passportMarkdown, PassportRecorder, PatchPassport } from './patchPassport';
import { McpManager, loadMcpConfigs, approveMcpServers } from './mcpManager';
import { handleMcpCatalogAction, mcpCatalogMessage } from './mcpCatalogCommands';
import { WorkspaceIndex } from './workspaceIndex';
import { CodeSearchService } from './codeSearchService';
import { HookRunner } from './hookRunner';
import { buildPrContext } from './prContextProvider';
import { UndoRedoStack } from './undoRedoStack';
import { Approvals } from './approvals';
import { WorkspaceTools } from './workspaceTools';
import { resolveModelAccess, systemPrefix } from './turnSetup';
import { AgentTurn, TurnHost } from './agentTurn';
import { Compaction, CompactionHost } from './compaction';
import { autoCommit, contextRequest, PanelHost, postSelectionBadge, reviewCode, runAndFixTests } from './panelCommands';
import { ThreadHost, ThreadManager, THREADS_INDEX_KEY, threadDisplayKey, threadKey } from './threads';
import { rewindFiles, turnsFrom, workspaceCheckpoints } from './rewind';
import { handleProposalMessage } from './editProposalMessages';
import { loadRepoInstructions, projectMemorySection, rememberTool } from './projectMemoryStore';
import { MEMORY_FILE } from './projectMemory';
import { untilStopped } from './stopRace';
import { CommandApprovalStore } from './commandApprovalStore';
import { MAX_STEER_CHARS } from './steering';
import { EditProposalManager } from './editProposalManager';
import { setStreamStallTimeout } from './streamCompletion';
import { runDelegate, SubagentHost, SUBAGENT_DEFAULT_MAX_STEPS } from './subagent';
import { TeamService } from './teamService';
import { DebugController } from './debugController';
import { debugLabel } from './debugTools';
import { TeamWorkers } from './teamWorkers';
import { VerifyRuntime } from './verifyRuntime';
import { teamLabel, teamPromptSection } from './teamTools';
import { repositoryRoot } from './backgroundGit';
import { countWorkspaceDiagnostics } from './workspaceDiagnostics';
import { ExternalToolRuntime, WEB_SEARCH_KEY } from './externalToolRuntime';
import { WebviewAssets } from './webviewAssets';
import { DisplayMessage, ExtensionMessage, ReplayEvent, REPLAY_BUDGET, REPLAY_DIFF_LIMIT, REPLAY_TYPES, ThreadEntry, WebviewMessage } from './chatProtocol';
import { buildEvaluationRunMetrics, EvaluationRunMetrics, EvaluationToolTraceEvent } from './evaluationMetrics';
import { projectHistoryForModel } from './contextProjection';
import { readFileTool } from './readFileTool';
import { accoOptimizerFromConfiguration } from './accoProviderOptimizer';
import { resolveWorkspaceToolPath } from './workspaceSecurity';
import { TaskUsage } from './taskUsage';
import { generateFollowUps } from './followUps';
import { approvedPlanExecution, isUserRequest, messageText, userRequestText, USER_REQUEST_MARKER } from './historyCompaction';
import { PLAN_PROMPT } from './agentPrompts';
import { cutAtTurn, lastTurnId } from './threadEditing';
import { openChangeDiff, openFileLink, readDroppedFile, registerChangeDiffProvider, exportMarkdown, insertCodeAtCursor, openCodeInNewFile, listDirectoryTool, openSettingsMenu } from './chatFiles';
import { exportFileName, threadMarkdown } from './threadExport';
import { buildContextPreamble } from './contextPreamble';
import { promptForMissingKey, providerStatusMessage, usableModel } from './modelFallback';
import { isCliModel } from './cliProviders';
import { noteAttention } from './attentionNotifier';
import { searchThreads } from './threadSearch';

// ─── Thread data types ────────────────────────────────────────────────────────

export class AgentProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'codico.chatView';

    /** Expose the index so extension.ts can register commands against it. */
    public get workspaceIndex(): WorkspaceIndex { return this._workspaceIndex; }
    /** Expose undo/redo stack so extension.ts can register commands against it. */
    /** Asks before overwriting a file that changed since Codico read it. Tests have no one to ask: keep the file. */
    private async _confirmOverwrite(message: string): Promise<boolean> {
        if (this._evaluationMode) { return false; }
        return await vscode.window.showWarningMessage(message, { modal: true }, 'Overwrite') === 'Overwrite';
    }

    /** Edit (and resend), delete, or regenerate a turn: the conversation is cut back to just before it. */
    private async _redoTurn(msg: Extract<WebviewMessage, { type: 'editMessage' | 'deleteMessage' | 'regenerate' | 'rewind' }>): Promise<void> {
        if (this._busy) { this._post({ type: 'error', message: 'Wait for the current reply to finish, or stop it, first.' }); return; }
        const turnId = msg.type === 'regenerate' ? lastTurnId(this._displayMessages) : msg.turnId;
        const cut = turnId ? cutAtTurn(this._displayMessages, this._history, turnId) : { error: 'There is no message to regenerate.' };
        if ('error' in cut) { this._post({ type: 'error', message: cut.error }); return; }
        const { turn } = cut;
        if (msg.type === 'editMessage' && turn.shownAs) { this._post({ type: 'error', message: 'This message cannot be edited.' }); return; }
        // A rewind also puts back the files these turns changed; cancelled there, nothing is cut
        if (msg.type === 'rewind' && !await rewindFiles(this._undoRedo, turnsFrom(this._displayMessages, msg.turnId), this._evaluationMode, this.checkpoints, turn.checkpoint)) { return; }
        this._history = cut.history;
        this._displayMessages = cut.display;
        this._planAwaitingAnswer = null;
        await this._historyStore.update(this._historyKey, this._history);
        await this._store.update(threadDisplayKey(this._activeThreadId), this._displayMessages);
        const text = msg.type === 'editMessage' ? msg.text : msg.type === 'regenerate' ? turn.plan ?? turn.text : undefined;
        const shown = text === undefined ? undefined : turn.plan !== undefined ? `\uD83D\uDCCB Plan: ${text}` : turn.shownAs ?? text;
        const name = this._store.get<ThreadEntry[]>(THREADS_INDEX_KEY, []).find(t => t.id === this._activeThreadId)?.name ?? '';
        this._post({ type: 'threadLoaded', id: this._activeThreadId, name, displayMessages: this._displayMessages, pendingUserText: shown, draftText: msg.type === 'rewind' && !turn.shownAs ? turn.plan ?? turn.text : undefined });
        if (msg.type === 'rewind') { this._post({ type: 'undoRedoState', ...this._undoRedo.state }); }
        if (text === undefined) { return; }
        await (turn.plan !== undefined ? this._handlePlan(text) : this._handleUserMessage(text, turn.parts, false, false, turn.shownAs));
    }

    /** Runs Undo or Redo and reports the outcome (shared by the panel and the commands). */
    public async undoRedoStep(kind: 'undo' | 'redo'): Promise<void> {
        const result = await (kind === 'undo' ? this._undoRedo.undo() : this._undoRedo.redo());
        if (!result) {
            void vscode.window.showInformationMessage(`Codico: nothing to ${kind}`);
        } else if (result.applied) {
            void vscode.window.showInformationMessage(`Codico: ${kind === 'undo' ? 'undid' : 'redid'} changes to ${result.filepath}`);
        }
        this._post({ type: 'undoRedoState', ...this._undoRedo.state });
    }
    /** Called by extension deactivate() to cleanly shut down the browser process. */
    public async closeBrowser(): Promise<void> { await this._external.closeBrowser(); }

    private _view?: vscode.WebviewView;
    private readonly _fileManager = new FileManager();
    private readonly _mcp = new McpManager();
    /** How the turn in progress reaches the model, for the subagents it starts. */
    private _subagentHost: SubagentHost | undefined;
    /** What the current turn changed and checked, for its change report. */
    private _passport = new PassportRecorder();
    private readonly _userExtensions = new UserExtensionsLoader(extensions => this._post(userExtensionsMessage(extensions)));
    private readonly _external = new ExternalToolRuntime(this._mcp, msg => this._post(msg));
    private readonly _webviewAssets: WebviewAssets;
    private readonly _undoRedo = new UndoRedoStack(message => this._confirmOverwrite(message));
    private readonly _editProposals = new EditProposalManager();
    private _editsMode = false;
    private _chatMode = false;
    /** Goal of the plan being generated; planning runs under Ask-mode (read-only) rules. */
    private _planGoal: string | null = null;
    /** Goal of a plan whose reply ended with a clarifying question; the answer continues that plan. */
    private _planAwaitingAnswer: string | null = null;
    private get _readOnly(): boolean { return this._chatMode || this._planGoal !== null; }
    /** Agent teams, when this window may lead one; the thread started with /team leads it. */
    public team?: TeamService; public workers?: TeamWorkers; public debug?: DebugController;
    private _teamThread: string | undefined;
    private get _teamMode(): boolean { return !!this.team && this._teamThread === this._activeThreadId && !this._readOnly; }
    private _mcpReady = false;
    private _watchersCreated = false;
    private readonly _workspaceIndex: WorkspaceIndex;
    private readonly _codeSearch = new CodeSearchService(() => this._workspaceIndex);
    private readonly _hooks = new HookRunner(() => this._context.workspaceState, () => this._evaluationMode);
    private _history: ChatMessage[] = [];
    private _activeThreadId: string = '';
    private _displayMessages: DisplayMessage[] = [];
    /** Collects the events of the reply currently streaming, for replay on thread load. */
    private _recording: { msgId: string; events: ReplayEvent[]; size: number; truncated: boolean } | null = null;
    private _abortController: AbortController | null = null;
    private _followUpAbortController: AbortController | null = null;
    private _busy = false;
    private _delegating = false;
    /** A message sent while the agent works: given to the model with its next request. */
    private _steer = '';
    // Medium by default: high effort costs noticeably more reasoning tokens on every step
    private _thinkingEffort: 'high' | 'medium' | 'low' = 'medium';
    private _repoInstructions: string | null | undefined = undefined; // undefined = not yet read
    /** Pending inline write-permission requests: permId → resolve fn */
    /** Resolves the pending step checkpoint: true = keep going, false = stop. */
    /** Messages sent while the previous turn was still finishing; run in order once free. */
    private readonly _pendingUserMessages: Array<{ text: string; contentParts?: MessageContentPart[]; injectActiveDiagnostics?: boolean; skipUserPush?: boolean; planGoal?: string; shownAs?: string }> = [];
    /** Resolved when the agent next becomes idle (used to stop a turn before switching threads). */
    private _idleWaiters: Array<() => void> = [];
    /** Process groups left running by run_terminal commands (POSIX only), keyed by pgid. */
    /** Pending inline terminal-permission requests: permId → resolve fn */
    /** Questions the agent waits on: file changes, commands, the token budget. */
    private readonly _approvals = new Approvals(message => this._post(message));
    /** What the panel's own commands (context, review, tests, commit) need from this conversation. */
    private readonly _panel: PanelHost = {
        post: message => this._post(message), send: text => this._handleUserMessage(text), sendShown: text => this.sendMessage(text),
        ready: () => !!this._view, sessionSignal: () => this._sessionAbort.signal,
    };
    /** Summarising the earlier part of a long conversation. */
    private readonly _compaction = new Compaction(AgentProvider._compactionHost(this));
    private static _compactionHost(provider: AgentProvider): CompactionHost {
        return {
            get history() { return provider._history; }, set history(history) { provider._history = history; },
            get compactRetryAt() { return provider._compactRetryAt; }, set compactRetryAt(at) { provider._compactRetryAt = at; },
            get lastPromptTokens() { return provider._lastPromptTokens; }, set lastPromptTokens(tokens) { provider._lastPromptTokens = tokens; },
            post: message => provider._post(message), save: history => provider._historyStore.update(provider._historyKey, history),
            sessionSignal: () => provider._sessionAbort.signal,
        };
    }
    /** What a turn of the agent needs from this conversation (a static method: it may reach this class's private state). */
    private static _turnHost(provider: AgentProvider): TurnHost {
        return {
            get compactRetryAt() { return provider._compactRetryAt; }, set compactRetryAt(value) { provider._compactRetryAt = value; },
            get displayMessages() { return provider._displayMessages; }, set displayMessages(value) { provider._displayMessages = value; },
            get evalBudgetExceeded() { return provider._evalBudgetExceeded; }, set evalBudgetExceeded(value) { provider._evalBudgetExceeded = value; },
            get evalCompletionTokens() { return provider._evalCompletionTokens; }, set evalCompletionTokens(value) { provider._evalCompletionTokens = value; },
            get evalProjectedCharsOmitted() { return provider._evalProjectedCharsOmitted; }, set evalProjectedCharsOmitted(value) { provider._evalProjectedCharsOmitted = value; },
            get evalPromptTokens() { return provider._evalPromptTokens; }, set evalPromptTokens(value) { provider._evalPromptTokens = value; },
            get evalSteps() { return provider._evalSteps; }, set evalSteps(value) { provider._evalSteps = value; },
            get evalToolCalls() { return provider._evalToolCalls; }, set evalToolCalls(value) { provider._evalToolCalls = value; },
            get evalTrace() { return provider._evalTrace; }, set evalTrace(value) { provider._evalTrace = value; },
            get history() { return provider._history; }, set history(value) { provider._history = value; },
            get lastInlineResult() { return provider._lastInlineResult; }, set lastInlineResult(value) { provider._lastInlineResult = value; },
            get lastPromptTokens() { return provider._lastPromptTokens; }, set lastPromptTokens(value) { provider._lastPromptTokens = value; },
            get steer() { return provider._steer; }, set steer(value) { provider._steer = value; },
            get subagentHost() { return provider._subagentHost; }, set subagentHost(value) { provider._subagentHost = value; },
            get approvals() { return provider._approvals; },
            get autoCompact() { return provider._autoCompact; },
            get compaction() { return provider._compaction; },
            get evaluationMode() { return provider._evaluationMode; },
            get evaluationTokenBudget() { return provider._evaluationTokenBudget; },
            get readOnly() { return provider._readOnly; },
            get team() { return provider._teamMode; }, acceptanceGuidance: () => provider._verify.guidance(),
            get thinkingEffort() { return provider._thinkingEffort; },
            post: message => provider._post(message), dispatchTool: (tool, msgId, signal) => provider._dispatchTool(tool, msgId, signal),
        };
    }
    /** The thread list and the open thread's saved state. */
    private readonly _threads = new ThreadManager(AgentProvider._threadHost(this));
    /** The open conversation as thread operations see it (a static method: it may reach this class's private state). */
    private static _threadHost(provider: AgentProvider): ThreadHost {
        return {
            get store() { return provider._store; }, get editProposals() { return provider._editProposals; },
            get activeThreadId() { return provider._activeThreadId; }, set activeThreadId(id) { provider._activeThreadId = id; },
            get history() { return provider._history; }, set history(history) { provider._history = history; },
            get displayMessages() { return provider._displayMessages; }, set displayMessages(display) { provider._displayMessages = display; },
            get editsMode() { return provider._editsMode; }, set editsMode(on) { provider._editsMode = on; },
            post: message => provider._post(message), newId: () => provider._newId(),
        };
    }
    /** Writing, editing, searching and commands, with what they need from this conversation. */
    private readonly _tools = new WorkspaceTools({
        post: message => this._post(message), approvals: this._approvals, undo: this._undoRedo, passport: () => this._passport, editProposals: this._editProposals,
        fileManager: this._fileManager, approvedCommands: () => this.approvedCommands, evaluationMode: () => this._evaluationMode,
        editsMode: () => this._editsMode, untrustedContentSeen: () => this._external.untrustedContentSeen, fileWritten: () => { this._filesWrittenThisTurn++; },
    });
    /** End-to-end verification: the app, browser assertions, acceptance criteria and their evidence. */
    private readonly _verify = new VerifyRuntime({ post: message => this._post(message), passport: () => this._passport, tools: this._tools, external: this._external });
    /** Set to true by "Allow All" for the current agent response; resets each user turn. */
    /** The workspace as it was at each message, kept on disk: what rewinding restores. */
    public readonly checkpoints = workspaceCheckpoints(this._context.globalStorageUri.fsPath);
    /** Commands the user always allows in this workspace. */
    public readonly approvedCommands = new CommandApprovalStore(() => this._context.workspaceState);
    /** Auto-commit: when true, stage+commit all changes after each agent turn */
    private _autoCommit = false;
    /** Count of files actually written/edited during the current agent turn */
    private _filesWrittenThisTurn = 0;
    /** Stores the result of the most recently dispatched inline tool */
    private _lastInlineResult: string | undefined = undefined;
    /** Whether auto-compact is enabled for this session (toggled via chat UI). */
    private _autoCompact = true;
    /** After a failed automatic compaction, the history length to reach before trying again. */
    private _compactRetryAt = 0;
    /** Prompt token count from the most recent API response; used for auto-compact threshold. */
    private _lastPromptTokens = 0;
    /** Test-only autonomous coding benchmark mode. Never enabled in production extension mode. */
    private readonly _evaluationMode: boolean;
    /** Test-only: ask for write approval as a user would see it. */
    private _evalRequireApproval = false;
    private _evalAskCommands = false;
    private _evalSteps = 0;
    private _evalToolCalls = 0;
    private _evalPromptTokens = 0;
    private _evalCompletionTokens = 0;
    private _evaluationTokenBudget = 0;
    private _evalBudgetExceeded = false;
    private _evalProjectedCharsOmitted = 0;
    private _evalTrace: EvaluationToolTraceEvent[] = [];
    private _evalTaskStartedAt = 0;

    // Cancelled on extension deactivation — passed to long-running directSingleCompletion calls
    // in fire-and-forget methods (_runAutoCommit, _compactHistory) that have no other cancel path.
    private readonly _sessionAbort = new AbortController();

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext,
        evaluationMode = false,
    ) {
        this._evaluationMode = evaluationMode;
        this._external.setEvaluationMode(evaluationMode);
        this._workspaceIndex = new WorkspaceIndex(_context);
        this._webviewAssets = new WebviewAssets(_extensionUri);
        this._editProposals.register(_context);
        registerChangeDiffProvider(_context);
        _context.secrets.onDidChange(() => providerStatusMessage(_context).then(status => this._post(status)), undefined, _context.subscriptions);
        this._threads.initSync();
        // Pre-load webview assets so first render does not block the extension host.
        void this._webviewAssets.preload();
        _context.subscriptions.push(this._userExtensions, this._hooks);
        this._external.searchKey = () => _context.secrets.get(WEB_SEARCH_KEY);
        // Abort in-flight requests when the extension deactivates.
        _context.subscriptions.push({ dispose: () => {
            this._followUpAbortController?.abort();
            this._sessionAbort.abort();
            this._tools.killBackgroundProcesses();
        }});
        // Reload thread list when globalHistory setting is toggled so threads from the
        // newly-active store are immediately visible instead of appearing lost.
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('codico.globalHistory')) {
                this._threads.initSync();
                this._post({ type: 'threadList', threads: this._threads.list() });
            }
            if (['chatDensity', 'showReasoning', 'autoCompactThreshold'].some(key => e.affectsConfiguration(`codico.${key}`))) { this._postUiSettings(); }
            // The header selector follows the setting (changed in Settings, or by the no-OpenRouter-key fallback)
            if (e.affectsConfiguration('codico.model')) { this._post({ type: 'setModel', model: vscode.workspace.getConfiguration('codico').get<string>('model', 'deepseek/deepseek-v4-flash') }); }
        }, undefined, _context.subscriptions);
    }

    // ── History / thread persistence helpers ─────────────────────────────────
    private get _useGlobalHistory(): boolean {
        return vscode.workspace.getConfiguration('codico').get<boolean>('globalHistory', false);
    }
    /** Single Memento source of truth; routes to global or workspace state. */
    private get _store(): vscode.Memento {
        return this._useGlobalHistory ? this._context.globalState : this._context.workspaceState;
    }
    /** Legacy alias — keeps existing call-sites unchanged. */
    private get _historyStore(): vscode.Memento { return this._store; }
    /** _historyKey now routes to the active thread's storage key. */
    private get _historyKey(): string { return threadKey(this._activeThreadId); }
    private _newId(): string { return nodeCrypto.randomBytes(8).toString('hex'); }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._webviewAssets.buildHtml(webviewView.webview);

        // Inform the webview of the currently configured model
        const currentModel = vscode.workspace
            .getConfiguration('codico')
            .get<string>('model', 'deepseek/deepseek-v4-flash');
        setTimeout(() => {
            this._post({ type: 'setModel', model: currentModel });
            this._post({ type: 'setEffort', effort: this._thinkingEffort });
            void providerStatusMessage(this._context).then(status => this._post(status));
            void this._userExtensions.get().then(extensions => this._post(userExtensionsMessage(extensions)));
            this._postUiSettings();
            this._post({ type: 'threadList', threads: this._threads.list() });
            // Show the active thread's full conversation (the panel starts empty after a reload)
            if (!this._busy && this._displayMessages.length > 0) {
                const active = this._store.get<ThreadEntry[]>(THREADS_INDEX_KEY, []).find(t => t.id === this._activeThreadId);
                this._post({ type: 'threadLoaded', id: this._activeThreadId, name: active?.name ?? '', displayMessages: this._displayMessages });
            }
            // Offer to resume an interrupted agentic session from the previous run
            if (this._isSessionInterrupted()) {
                const summary = this._getInterruptedTaskSummary();
                this._post({ type: 'resumeOffer', summary });
            }
            // Sync initial selection state so the badge is correct on first load
            postSelectionBadge(this._panel);
        }, 200);

        // Connect MCP servers asynchronously (non-blocking)
        if (!this._mcpReady) {
            this._connectMcpServers();
        }

        // Watch workspace files for incremental index updates — only once per session
        if (!this._watchersCreated) {
            this._watchersCreated = true;

            const watcher = vscode.workspace.createFileSystemWatcher('**/*');
            watcher.onDidChange(uri => { this._codeSearch.changed(uri); if (this._workspaceIndex.isIndexed) { void this._workspaceIndex.reindexFile(uri); } });
            watcher.onDidCreate(uri => { this._codeSearch.changed(uri); if (this._workspaceIndex.isIndexed) { void this._workspaceIndex.reindexFile(uri); } });
            watcher.onDidDelete(uri => { this._codeSearch.removed(uri); this._workspaceIndex.removeFile(uri); });
            this._context.subscriptions.push(watcher);

            // Watch Problems panel — push live error/warning counts to the webview badge
            const _postDiagCounts = (): void => {
                const { errorCount, warningCount } = countWorkspaceDiagnostics();
                this._post({ type: 'diagnosticsChanged', errorCount, warningCount });
            };
            const diagWatcher = vscode.languages.onDidChangeDiagnostics(() => _postDiagCounts());
            this._context.subscriptions.push(diagWatcher);
            // Initialise badge immediately
            setTimeout(_postDiagCounts, 300);

            // Proactive error detection — offer to fix errors when a file is opened
            let _proactiveTimer: ReturnType<typeof setTimeout> | undefined;
            const _checkProactiveOffer = (): void => {
                if (_proactiveTimer) { clearTimeout(_proactiveTimer); }
                _proactiveTimer = setTimeout(() => {
                    const cfg = vscode.workspace.getConfiguration('codico');
                    if (!cfg.get<boolean>('proactiveErrorDetection', true)) { return; }
                    if (this._busy) { return; }
                    const editor = vscode.window.activeTextEditor;
                    if (!editor || editor.document.uri.scheme !== 'file') { return; }
                    const diags = vscode.languages.getDiagnostics(editor.document.uri);
                    const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
                    const warnings = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;
                    if (errors === 0) { return; }
                    const rel = vscode.workspace.asRelativePath(editor.document.uri);
                    this._post({ type: 'proactiveOffer', filename: rel, errorCount: errors, warningCount: warnings });
                }, 1500);
            };
            const editorWatcher = vscode.window.onDidChangeActiveTextEditor(() => {
                _checkProactiveOffer();
                postSelectionBadge(this._panel);
            });
            const diagOfferWatcher = vscode.languages.onDidChangeDiagnostics(() => _checkProactiveOffer());
            let _selectionDebounce: ReturnType<typeof setTimeout> | undefined;
            const selectionWatcher = vscode.window.onDidChangeTextEditorSelection((e) => {
                if (e.textEditor === vscode.window.activeTextEditor) {
                    clearTimeout(_selectionDebounce);
                    _selectionDebounce = setTimeout(() => postSelectionBadge(this._panel), 150);
                }
            });
            this._context.subscriptions.push(editorWatcher, diagOfferWatcher, selectionWatcher);

            // Invalidate repo-instructions cache when the instruction files change
            const instrWatcher = vscode.workspace.createFileSystemWatcher(
                '**/{.codico-instructions.md,.github/codico-instructions.md,.github/copilot-instructions.md}'
            );
            const _invalidateInstr = (): void => { this._repoInstructions = undefined; };
            instrWatcher.onDidChange(_invalidateInstr);
            instrWatcher.onDidCreate(_invalidateInstr);
            instrWatcher.onDidDelete(_invalidateInstr);
            this._context.subscriptions.push(instrWatcher);
        }

        webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => this._onWebviewMessage(msg));
    }

    /** Test-only: whether writes wait for approval, and the approval prompts now open. */
    public evaluationApprovals(require?: boolean | 'commands'): string[] {
        if (!this._evaluationMode) { throw new Error('Codico evaluation mode is only available from the VS Code test Extension Host.'); }
        if (require !== undefined) { this._evalRequireApproval = require === true; this._evalAskCommands = require === 'commands'; }
        return this._approvals.pending;
    }

    /** Test-only: delivers a message as if the panel had sent it. */
    public async handleEvaluationWebviewMessage(msg: WebviewMessage): Promise<void> {
        if (!this._evaluationMode) { throw new Error('Codico evaluation mode is only available from the VS Code test Extension Host.'); }
        await this._onWebviewMessage(msg);
    }

    private async _onWebviewMessage(msg: WebviewMessage): Promise<void> {
        try {
        // A team worker's question, or a button of the Agents view
        if (await this.workers?.route(msg) || await this._verify.route(msg)) { return; }
        switch (msg.type) {
            case 'sendMessage':
                this._planAwaitingAnswer = null;
                await this._handleUserMessage(msg.text, msg.contentParts as MessageContentPart[] | undefined, msg.injectActiveDiagnostics);
                break;
            case 'clearChat':
                await this._stopTurnAndWait();
                this._history = [];
                this._displayMessages = [];
                await this._historyStore.update(this._historyKey, []);
                await this._store.update(threadDisplayKey(this._activeThreadId), []);
                await this._threads.updateMeta('');
                if (this._editsMode) {
                    this._editsMode = false;
                    this._editProposals.rejectAll();
                    this._post({ type: 'allProposalsResolved' });
                }
                this._post({ type: 'threadList', threads: this._threads.list() });
                break;
            case 'setApiKey':
                await vscode.commands.executeCommand(msg.direct ? 'codico.setDirectApiKey' : 'codico.setApiKey');
                break;
            case 'openSettings':
                await openSettingsMenu();
                break;
            case 'closePanel':
                await vscode.commands.executeCommand('workbench.action.closeSidebar');
                break;
            case 'checkpointResponse':
                this._approvals.answerCheckpoint(msg.continue === true);
                break;
            case 'killBackgroundProcesses':
                this._tools.killBackgroundProcesses();
                break;
            case 'queueMessage':
                this._steer = this._busy && msg.text.length <= MAX_STEER_CHARS ? msg.text : '';
                break;
            case 'abortStream':
                this._steer = ''; this._teamSteer = false;
                this._abortController?.abort();
                // A message waiting for the previous turn to finish is cancelled too; the
                // panel already shows it as running, so end that state explicitly.
                if (this._pendingUserMessages.length > 0) {
                    this._pendingUserMessages.length = 0;
                    this._post({ type: 'endMessage', id: '' });
                }
                // Resolve all pending permission dialogs as denied so their Promises unblock
                this._approvals.cancelAll();
                this._approvals.allowAllWrites = false;
                this._approvals.allowAllCommands = false;
                this._external.resetTurnPermissions();
                break;
            case 'writePermissionResponse':
                this._approvals.answerWrite(msg.permId, { granted: msg.granted });
                break;
            case 'terminalPermissionResponse':
                await this.approvedCommands.answered(msg.permId, msg.granted ? msg.remember : undefined);
                this._approvals.answerCommand(msg.permId, msg.granted);
                break;
            case 'allowAllWrites':
                this._approvals.answerWrite(msg.permId, { granted: true }, true);
                break;
            case 'writePermissionEdit':
                this._approvals.answerWrite(msg.permId, { granted: true, editedContent: msg.content });
                break;
            case 'allowAllTerminal':
                this._approvals.answerCommand(msg.permId, true, true);
                break;
            case 'changeModel': {
                // Validate against known model IDs before persisting
                if (!this._webviewAssets.isValidModelId(msg.model)) {
                    this._post({ type: 'error', message: `Unknown model ID rejected: "${msg.model}"` });
                    break;
                }
                await vscode.workspace
                    .getConfiguration('codico')
                    .update('model', msg.model, vscode.ConfigurationTarget.Global);
                void promptForMissingKey(this._context, msg.model); // picked a provider with no key yet
                break;
            }
            case 'changeEffort':
                this._thinkingEffort = msg.effort;
                break;
            case 'requestContext':
                await contextRequest(this._panel, msg.kind);
                break;
            case 'startReview':
                await reviewCode(this._panel, msg.target);
                break;
            case 'startPlan':
                await this._handlePlan(msg.goal);
                break;
            case 'approvePlan': {
                // The approved plan is what execution needs; the planning reads would be resent with every request
                const run = approvedPlanExecution(this._history, PLAN_PROMPT.slice(0, 40), msg.executionPrompt);
                if (!this._busy) { this._history = run.history; }
                await this._handleUserMessage(this._busy ? msg.executionPrompt : run.prompt, undefined, false, false, '\u2705 Plan approved \u2014 executing\u2026');
                break;
            }
            case 'clarifyResponse':
                await this._handleClarifyResponse(msg.text);
                break;
            case 'mcpCatalog':
            case 'refreshMcp':
                // The catalog: nothing to reconnect unless a server was added or removed
                if (msg.type === 'mcpCatalog' && !await handleMcpCatalogAction(msg, this._context, this._extensionUri)) { this._post(await mcpCatalogMessage(this._extensionUri)); break; }
                // Not under a running task: it may be calling one of these servers
                await this._whenIdle();
                this._mcpReady = false;
                this._mcp.disconnectAll();
                await this._connectMcpServers();
                if (msg.type === 'mcpCatalog') { this._post(await mcpCatalogMessage(this._extensionUri)); }
                break;
            case 'undo':
                await this.undoRedoStep('undo');
                break;
            case 'redo':
                await this.undoRedoStep('redo');
                break;
            case 'toggleEditsMode':
                // A running task keeps the mode it started in (its proposals would be lost)
                await this._whenIdle();
                this._editsMode = msg.enabled;
                if (!msg.enabled) {
                    // Discard any pending proposals when leaving edits mode
                    this._editProposals.rejectAll();
                    this._post({ type: 'allProposalsResolved' });
                }
                break;
            case 'toggleAutoCommit':
                this._autoCommit = msg.enabled;
                break;
            case 'previewEditDiff': case 'acceptEdit': case 'rejectEdit': case 'acceptAllEdits': case 'rejectAllEdits': case 'acceptHunk': case 'rejectHunk':
                await handleProposalMessage(msg, this._editProposals, this._undoRedo, message => this._post(message), message => this._confirmOverwrite(message));
                break;
            case 'sendFollowUp':
                await this._handleUserMessage(msg.text);
                break;
            case 'generateTestsFromCoverage':
                await vscode.commands.executeCommand('codico.generateTestsFromCoverage');
                break;
            case 'runAndFixTests':
                await runAndFixTests(this._panel);
                break;
            case 'openProblems':
                await vscode.commands.executeCommand('workbench.actions.view.problems');
                break;
            case 'createThread':
                await this._stopTurnAndWait();
                await this._threads.create(msg.name);
                break;
            case 'switchThread':
                await this._stopTurnAndWait();
                await this._threads.switchTo(msg.id);
                break;
            case 'renameThread':
                await this._threads.rename(msg.id, msg.name);
                break;
            case 'deleteThread':
                await this._stopTurnAndWait();
                await this._threads.remove(msg.id);
                break;
            case 'startBackgroundTask':
                this.onBackgroundRequest?.(msg.text);
                break;
            case 'openBackgroundTasks':
                void vscode.commands.executeCommand('codico.backgroundTasks');
                break;
            case 'duplicateThread':
                // Refused, not stopped: a copy of a half-finished reply would be wrong.
                if (this._busy) { this._post({ type: 'error', message: 'Cannot duplicate a thread while a reply is running. Wait for it to finish, or stop it, first.' }); break; }
                await this._threads.duplicate(msg.id);
                break;
            case 'threadContextMenu':
                await this._threads.contextMenu(msg.id);
                break;
            case 'searchThreads':
                this._post({ type: 'threadSearchResults', query: msg.query, results: searchThreads(this._store.get<ThreadEntry[]>(THREADS_INDEX_KEY, []), id => this._store.get<DisplayMessage[]>(threadDisplayKey(id), []), msg.query) });
                break;
            case 'resumeSession': {
                if (!this._busy) {
                    void this._resumeInterruptedSession().catch(err => this._postError(err));
                }
                break;
            }
            case 'compactChat': {
                if (this._busy) { break; }
                // Claim busy before any await, or a message sent meanwhile would run concurrently
                this._busy = true;
                try {
                    const compactCfg = vscode.workspace.getConfiguration('codico');
                    const compactModel = await usableModel(this._context, compactCfg.get<string>('model', 'deepseek/deepseek-v4-flash'));
                    const isCompactOllama = compactModel.startsWith('ollama/') || isCliModel(compactModel); // neither needs a key
                    const isCompactDirect = compactModel.startsWith('direct:');
                    const compactOllamaBaseUrl = compactCfg.get<string>('ollamaBaseUrl', 'http://localhost:11434');
                    const compactOllamaModel = compactModel.slice('ollama/'.length);
                    const compactDirectParsed = isCompactDirect ? parseDirectModelId(compactModel) : null;
                    let compactApiKey = '';
                    let compactDirectKey = '';
                    if (isCompactOllama) {
                        // no key needed
                    } else if (isCompactDirect) {
                        if (compactDirectParsed) {
                            compactDirectKey = await this._context.secrets.get(directSecretKey(compactDirectParsed.providerId)) ?? '';
                        }
                        if (!compactDirectKey) {
                            this._post({ type: 'error', message: 'No API key set for this provider. Run "Codico: Set Direct Provider API Key".' });
                            break;
                        }
                    } else {
                        compactApiKey = await this._context.secrets.get('openRouterApiKey') ?? '';
                        if (!compactApiKey) {
                            this._post({ type: 'error', message: 'No API key set. Click the ⚙ icon to add an OpenRouter key or a direct provider key (Anthropic, OpenAI, DeepSeek…).' });
                            break;
                        }
                    }
                    await this._compaction.run(compactApiKey, compactModel, isCompactOllama, compactOllamaBaseUrl, compactOllamaModel, isCompactDirect, compactDirectKey, compactDirectParsed?.providerId ?? '', compactDirectParsed?.modelId ?? '');
                } finally {
                    this._releaseBusy();
                }
                break;
            }
            case 'toggleAutoCompact':
                this._autoCompact = msg.enabled;
                break;
            case 'toggleChatMode':
                this._chatMode = msg.chatMode;
                break;
            case 'editMessage':
            case 'deleteMessage':
            case 'rewind':
            case 'regenerate':
                await this._redoTurn(msg);
                break;
            case 'openFile': {
                const problem = await openFileLink(msg.path, msg.line);
                if (problem) { this._post({ type: 'error', message: problem }); }
                break;
            }
            case 'openChangeDiff': {
                const target = await resolveWorkspaceToolPath(msg.path).catch(() => undefined);
                const change = target ? this._undoRedo.latestFor(target.uri) : undefined;
                if (target && change) { await openChangeDiff(target.uri, change.before); }
                else { this._post({ type: 'error', message: `No change by Codico to ${msg.path} can be shown (it may have been undone).` }); }
                break;
            }
            case 'codeBlock': {
                const problem = msg.action === 'insert' ? await insertCodeAtCursor(msg.code) : void await openCodeInNewFile(msg.code, msg.language ?? '');
                if (problem) { this._post({ type: 'error', message: problem }); }
                break;
            }
            case 'exportThread': {
                const thread = this._store.get<ThreadEntry[]>(THREADS_INDEX_KEY, []).find(t => t.id === msg.id);
                // The open thread's newest messages may not be saved yet
                const messages = msg.id === this._activeThreadId ? this._displayMessages : this._store.get<DisplayMessage[]>(threadDisplayKey(msg.id), []);
                if (thread) { await exportMarkdown(threadMarkdown(thread.name, messages), exportFileName(thread.name)); }
                break;
            }
            case 'pinThread': {
                const threads = this._store.get<ThreadEntry[]>(THREADS_INDEX_KEY, []);
                const pinned = threads.find(t => t.id === msg.id);
                if (pinned) { pinned.pinned = !pinned.pinned; await this._store.update(THREADS_INDEX_KEY, threads); }
                this._post({ type: 'threadList', threads: this._threads.list() });
                break;
            }
            case 'attachDroppedFiles':
                for (const uri of msg.uris.slice(0, 10)) {
                    const file = await readDroppedFile(uri);
                    this._post('error' in file ? { type: 'error', message: file.error }
                        : 'image' in file ? { type: 'droppedImage', dataUrl: file.image, name: file.name } : { type: 'contextSnippet', kind: 'file', ...file });
                }
                break;
        }
        } catch (err: unknown) {
            // Turns and Compact release the agent themselves. The failed action may be
            // unrelated to a task that is still running, so the busy state is left alone.
            this._postError(err);
        }
    }

    private _postError(err: unknown): void {
        this._post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }

    // ─── MCP connection ──────────────────────────────────────────────────────

    private async _connectMcpServers(): Promise<void> {
        this._mcpReady = true;

        // Codico is disabled in untrusted workspaces via package.json, but keep a
        // runtime guard as defence-in-depth for hosts that do not enforce it.
        if (!vscode.workspace.isTrusted) {
            this._post({ type: 'mcpStatus', servers: [] });
            return;
        }

        const configs = await loadMcpConfigs();
        if (configs.length === 0) {
            this._post({ type: 'mcpStatus', servers: [] });
            return;
        }

        const approved = await approveMcpServers(this._context, configs);
        const statuses = await this._mcp.connectAll(approved);
        this._post({ type: 'mcpStatus', servers: statuses });
    }

    // ─── Message handling ────────────────────────────────────────────────────

    /**
     * Send a chat message programmatically (e.g. from extension commands).
     * Focuses the sidebar first so the user sees the response stream.
     */
    public async sendMessage(text: string): Promise<void> {
        await vscode.commands.executeCommand('workbench.view.extension.codico-container');
        await this._handleUserMessage(text);
    }

    /**
     * Test-only entrypoint used by the frozen coding-task benchmark.
     * Production activation never enables evaluation mode.
     */
    public setEvaluationTokenBudget(maxTotalTokens: number): void {
        if (!this._evaluationMode) {
            throw new Error('Evaluation token budgets are test-only.');
        }
        this._evaluationTokenBudget = Math.max(0, Math.floor(maxTotalTokens));
    }

    /** Automated tests only: the change report of the last turn. */
    public evaluationPassport(): PatchPassport | undefined { return this._evaluationMode ? this._passport.build() : undefined; }

    public lastReplyUsage(): DisplayMessage['usage'] { return this._displayMessages.filter(m => m.role === 'assistant').at(-1)?.usage; }
    /** The text of the agent's last reply in full, without its tool calls: what a team's worker reports. */
    public lastReplyText(): string {
        const last = [...this._history].reverse().find(m => m.role === 'assistant' && messageText(m).trim());
        return last ? messageText(last).replace(/(`{3,})[a-z_]+\n[\s\S]*?\1/g, '').trim() : '';
    }
    /** A message from a team's orchestrator: given at the next step while working, otherwise answered as a new message. */
    public async teamMessage(text: string): Promise<'steered' | 'answered'> {
        if (this._busy) { this._steer = this._steer ? `${this._steer}\n\n${text}` : text; this._teamSteer = true; return 'steered'; }
        void this.sendMessage(text);
        return 'answered';
    }
    /** The message waiting for the next step came from a team's orchestrator: if the turn ends first, it is sent as a new message, not dropped. */
    private _teamSteer = false;
    /** Set in the window of a background task: its permissions, and a listener that follows what the agent does. */
    public backgroundPermissions: 'ask' | 'edits' | 'all' = 'ask'; public backgroundListener?: (msg: ExtensionMessage) => void;
    public get ready(): boolean { return !!this._view; }
    /** Declines whatever is waiting for an approval (a run with nobody to ask). */
    public denyPrompts(): void { this._approvals.cancelAll(); }
    public onBackgroundRequest?: (text: string) => void;
    /** Runs a subagent; its reads run like any other tool call, and show as steps under it. */
    private _delegate(tool: { type: 'delegate'; task: string; agent?: string }, msgId: string, signal: AbortSignal, agents: Array<{ name: string; instructions: string }>) {
        this._delegating = true; // a subagent has a conversation of its own: what this one has read says nothing about it
        return runDelegate(tool, this._subagentHost, agents, {
            signal, maxSteps: vscode.workspace.getConfiguration('codico').get<number>('subagentMaxSteps', SUBAGENT_DEFAULT_MAX_STEPS),
            runTool: async nested => { await this._dispatchTool(nested, msgId, signal); const text = this._lastInlineResult ?? ''; this._lastInlineResult = undefined; return text; },
        }).finally(() => { this._delegating = false; });
    }
    /** For a team's workers: their view and questions, and what their file tools share with this conversation. */
    public postToPanel(message: ExtensionMessage): void { this._post(message); }
    public get editProposals(): EditProposalManager { return this._editProposals; }
    public showBackgroundTasks(text: string, needsUser: boolean): void { this._post({ type: 'backgroundTasks', text, needsUser }); }
    public evaluationTurns(thread?: boolean): string[] { return thread ? [this._activeThreadId] : this._displayMessages.filter(m => m.role === 'user' && !!m.id).map(m => m.id as string); }
    public getEvaluationSnapshot(): EvaluationRunMetrics {
        if (!this._evaluationMode) { throw new Error('Codico evaluation mode is only available from the VS Code test Extension Host.'); }
        return buildEvaluationRunMetrics({
            startedAt: this._evalTaskStartedAt, steps: this._evalSteps, toolCalls: this._evalToolCalls,
            filesWritten: this._filesWrittenThisTurn, promptTokens: this._evalPromptTokens,
            completionTokens: this._evalCompletionTokens, historyMessages: this._history.length,
            budgetExceeded: this._evalBudgetExceeded, projectedCharsOmitted: this._evalProjectedCharsOmitted,
            trace: this._evalTrace,
        });
    }

    /** @param asPlan run the text as a Plan-mode goal (read-only, awaits approval) instead of a message */
    /** @param kind run the text as a normal message, a Plan-mode goal, or an answer to a clarifying question */
    public async runEvaluationTask(text: string, kind: 'message' | 'plan' | 'clarify' = 'message'): Promise<EvaluationRunMetrics> {
        if (!this._evaluationMode) { throw new Error('Codico evaluation mode is only available from the VS Code test Extension Host.'); }
        this._evalSteps = this._evalToolCalls = this._evalPromptTokens = this._evalCompletionTokens = 0;
        this._evalBudgetExceeded = false; this._evalProjectedCharsOmitted = 0; this._evalTrace = [];
        this._evalTaskStartedAt = Date.now();
        await vscode.commands.executeCommand('workbench.view.extension.codico-container');
        await (kind === 'plan' ? this._handlePlan(text) : kind === 'clarify' ? this._handleClarifyResponse(text) : this._handleUserMessage(text));
        return this.getEvaluationSnapshot();
    }

    // ── Session resume detection ──────────────────────────────────────────────

    private _isSessionInterrupted(): boolean {
        if (this._history.length < 2) { return false; }
        const last = this._history[this._history.length - 1];
        if (last.role !== 'user') { return false; }
        // Extract text whether content is a plain string or a MessageContentPart array,
        // so a tool-result message stored as parts is not silently missed.
        const content = typeof last.content === 'string'
            ? last.content
            : (last.content as MessageContentPart[])
                .filter(p => p.type === 'text')
                .map(p => (p as { type: 'text'; text: string }).text)
                .join('');
        return content.startsWith('[Tool Results]');
    }

    private _getInterruptedTaskSummary(): string {
        // The interrupted task is the latest request the user wrote (its own words, without [Context])
        for (let i = this._history.length - 1; i >= 0; i--) {
            if (isUserRequest(this._history[i])) {
                return userRequestText(this._history[i], 400).replace(/\s+/g, ' ').trim().slice(0, 80) || 'previous task';
            }
        }
        return 'previous task';
    }

    private async _resumeInterruptedSession(): Promise<void> {
        if (this._busy || !this._view || !this._isSessionInterrupted()) { return; }
        await this._handleUserMessage(this._getInterruptedTaskSummary(), undefined, false, true);
    }

    /** @param shownAs what the panel shows for this message when it is not rawText (an approved plan) */
    private async _handleUserMessage(rawText: string, contentParts?: MessageContentPart[], injectActiveDiagnostics?: boolean, _skipUserPush = false, shownAs?: string): Promise<void> {
        if (this._busy) {
            // The previous turn is still running or finishing (saving history, compacting…).
            // Queue rather than drop: Approve, follow-ups, clarify answers, Review and
            // editor commands all arrive here, not only the panel's Send button.
            this._pendingUserMessages.push({ text: rawText, contentParts, injectActiveDiagnostics, skipUserPush: _skipUserPush, shownAs });
            return;
        }
        this._busy = true;
        // Created before setup (keys, context, /pr, @agent lookups can take seconds) so
        // Stop, a thread switch or Clear can cancel the turn from its very start
        const abortController = new AbortController();
        let turnStarted = false;
        this._abortController = abortController;
        const { signal } = abortController;
        const _taskStartMs = Date.now();
        this._filesWrittenThisTurn = 0;
        this._evalSteps = 0;
        this._evalToolCalls = 0;
        this._evalPromptTokens = 0;
        this._evalCompletionTokens = 0;
        this._evalBudgetExceeded = false;
        this._evalProjectedCharsOmitted = 0;
        this._evalTrace = [];
        // Dismiss any pending proactive offer now that the user is sending a message
        this._post({ type: 'proactiveOffer', filename: '', errorCount: 0, warningCount: 0 });
        try {
        let text = rawText;
        if (!this._view) { return; }

        // ── /fix: prepend active-file diagnostics so the AI knows exactly what to fix ──
        if (injectActiveDiagnostics) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const diags = vscode.languages.getDiagnostics(editor.document.uri)
                    .filter(d => d.severity === vscode.DiagnosticSeverity.Error ||
                                 d.severity === vscode.DiagnosticSeverity.Warning);
                if (diags.length > 0) {
                    const fileName = path.basename(editor.document.fileName);
                    const diagBlock = diags
                        .map(d => `  Line ${d.range.start.line + 1} [${d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning'}]: ${d.message}`)
                        .join('\n');
                    text = `Diagnostics in ${fileName}:\n${diagBlock}\n\n${text}`;
                }
            }
        }

        // Reset per-response allow-all flags at the start of every new user turn
        this._approvals.allowAllWrites = (this._evaluationMode && !this._evalRequireApproval) || this.backgroundPermissions !== 'ask';
        this._approvals.allowAllCommands = (this._evaluationMode && !this._evalAskCommands) || this.backgroundPermissions === 'all';
        this._external.resetTurnPermissions();

        // ── /pr slash command: inject PR context then re-prompt as a review ──
        const prMatch = text.match(/^\/pr(?:\s+(.*))?$/is);
        if (prMatch) {
            const extra = (prMatch[1] ?? '').trim();
            const prCtx = await buildPrContext(this._context);
            if (!prCtx) {
                this._post({ type: 'error', message: 'No open PR found for the current branch, or GitHub token not set. Run "Codico: Set GitHub Token".' });
                return;
            }
            text = `You have been provided with the GitHub PR context below. Please review this PR: summarise the changes, identify potential issues, suggest improvements, and note anything that looks risky or incomplete.${extra ? `\n\nAdditional focus: ${extra}` : ''}\n\n${prCtx}`;
        }

        // ── /team <goal>: this thread leads a team of workers from now on ──
        const teamMatch = text.match(/^\/team(?:\s+([\s\S]*))?$/i);
        if (teamMatch) {
            if (!this.team) { this._post({ type: 'error', message: 'Agent teams are not available in this window.' }); return; }
            if (!(teamMatch[1] ?? '').trim()) { this._post({ type: 'error', message: 'Say what the team should do: /team <goal>.' }); return; }
            this._teamThread = this._activeThreadId; text = (teamMatch[1] ?? '').trim();
        }

        // The project's own skills and agents (.codico folder): "/name request" runs a skill
        const userExtensions = await this._userExtensions.get();
        text = expandSkillCommand(text, userExtensions.skills)?.text ?? text;

        const config = vscode.workspace.getConfiguration('codico');
        const access = await resolveModelAccess(this._context, config);
        if ('error' in access) { this._post({ type: 'error', message: access.error }); return; }
        const { model, isOllama, isCli, isDirect, ollamaModel, ollamaBaseUrl, directParsed, apiKey, directApiKey } = access;
        // Keep the index aware of the current API key for embedding calls
        if (apiKey) { this._workspaceIndex.setApiKey(apiKey); }
        const customPrefix = config.get<string>('systemPrompt', '') || undefined;
        const autoInject = config.get<boolean>('autoInjectContext', true);
        // 0 (the default) means no iteration limit
        const maxIterations = config.get<number>('maxIterations', 0);
        const verificationGraceIterations = config.get<number>('verificationGraceIterations', 4); const mutationGraceIterations = config.get<number>('mutationGraceIterations', 3);
        this._passport = new PassportRecorder(); this._verify.beginTurn(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
        const taskUsage = new TaskUsage(config.get<number>('taskTokenBudget', 0));
        const nativeToolCalling = config.get<boolean>('nativeToolCalling', true);
        setStreamStallTimeout(config.get<number>('streamStallTimeoutSeconds', 300));
        const accoOptimizer = accoOptimizerFromConfiguration(config, !isOllama && !isCli);

        // Load repo instructions once per session
        if (this._repoInstructions === undefined) {
            this._repoInstructions = await loadRepoInstructions();
        }

        // What goes before Codico's own system prompt. Project memory is read once per turn: a note saved during the task does not change the prompt under it
        let effectivePrefix = systemPrefix({ repoInstructions: this._repoInstructions, customPrefix, mcpSection: this._mcp.buildSystemPromptSection(), skillsSection: skillsPromptSection(userExtensions.skills),
            memorySection: await projectMemorySection(), editsMode: this._editsMode, summary: config.get<boolean>('responseSummaryEnabled', true), acceptance: !this._readOnly && config.get<boolean>('acceptanceChecks', true) });
        if (this._teamMode) { effectivePrefix = [effectivePrefix, teamPromptSection(Math.max(1, Math.min(6, config.get<number>('teamMaxWorkers', 3))))].filter(Boolean).join('\n\n'); }

        // Detect @agent mention and apply agent-specific context
        const { agent, strippedText } = parseAgentMention(text);
        let agentContextBlock = '';
        if (agent) {
            const agentCtx = await buildAgentContext(agent, { query: strippedText, index: this._workspaceIndex, extensionContext: this._context });
            const agentPrefix = agentCtx.systemPromptPrefix;
            effectivePrefix = effectivePrefix
                ? `${agentPrefix}\n\n${effectivePrefix}`
                : agentPrefix;
            agentContextBlock = agentCtx.contextBlock;
            text = strippedText;
            this._post({ type: 'agentActive', agent });
        }
        // "@name" for one of the project's own agents: its instructions lead the system prompt
        const userAgent = agent ? null : parseUserAgentMention(text, userExtensions.agents);
        if (userAgent) {
            effectivePrefix = [userAgentPrefix(userAgent.agent), effectivePrefix].filter(Boolean).join('\n\n');
            text = userAgent.strippedText;
            this._post({ type: 'agentActive', agent: userAgent.agent.name });
        }

        // Optionally prepend active editor context (invisible in chat, visible to AI)
        let userContent: string | MessageContentPart[] = text;
        if (autoInject || agentContextBlock) {
            const ctxPreamble = autoInject ? await buildContextPreamble() : '';
            const combined = [agentContextBlock, ctxPreamble].filter(Boolean).join('\n\n');
            const textWithCtx = combined ? `${combined}\n\n${USER_REQUEST_MARKER}\n${text}` : text;
            if (contentParts && contentParts.length > 0) {
                userContent = [
                    { type: 'text', text: textWithCtx },
                    ...contentParts.filter(p => p.type !== 'text'),
                ];
            } else {
                userContent = textWithCtx;
            }
        } else if (contentParts && contentParts.length > 0) {
            userContent = contentParts;
        }

        // Stopped during setup: nothing was sent or recorded yet; end the panel's busy state
        if (signal.aborted) { this._post({ type: 'endMessage', id: '' }); return; }

        const historyRollbackLen = this._history.length;
        const displayRollbackLen = this._displayMessages.length;

        // Ties the panel message, the saved transcript and the model history together (edit, delete, regenerate)
        const turnId = _skipUserPush ? undefined : this._newId();
        if (turnId) {
            this._undoRedo.turn = turnId; this._steer = '';
            this._history.push({ role: 'user', content: userContent, turnId });
            // Saved as the panel showed it live (a plan goal, not the planner prompt); `prompt` keeps what was sent
            const shown = this._planGoal !== null ? `\uD83D\uDCCB Plan: ${this._planGoal}` : shownAs ?? rawText.slice(0, 20_000);
            this._displayMessages.push({ role: 'user', text: shown, id: turnId, at: Date.now(), plan: this._planGoal ?? undefined,
                prompt: this._planGoal === null && shown !== rawText ? rawText : undefined });
            { const sent = this._displayMessages[this._displayMessages.length - 1]; void this.checkpoints.begin(shown.slice(0, 80)).then(taken => { sent.checkpoint = taken; }, () => undefined); }
        }

        // Auto-name the thread immediately from the first user message so the sidebar updates right away
        void this._threads.updateMeta(this._planGoal !== null ? `Plan: ${this._planGoal}` : rawText).then(() => {
            this._post({ type: 'threadList', threads: this._threads.list() });
        });

        const msgId = Date.now().toString();
        // planGoal marks this reply as a plan: the panel offers Approve only on it
        this._post({ type: 'startMessage', id: msgId, planGoal: this._planGoal ?? undefined, turnId, editable: turnId ? this._planGoal !== null || (!shownAs && rawText.length <= 20_000) : undefined });
        turnStarted = true;
        this._recording = { msgId, events: [], size: 0, truncated: false };

        // Abort any in-flight follow-up request from the previous message
        this._followUpAbortController?.abort();
        this._followUpAbortController = null;

        // The agent loop: requests, tools, recovery and stop rules, until the reply is complete
        await new AgentTurn(AgentProvider._turnHost(this)).run({ accoOptimizer, apiKey, config, directApiKey, directParsed, displayRollbackLen, effectivePrefix, historyRollbackLen, isCli, isDirect, isOllama, maxIterations, model, msgId, mutationGraceIterations, nativeToolCalling, ollamaBaseUrl, ollamaModel, rawText, taskUsage, verificationGraceIterations, signal });

        // The change report: what this turn changed, what was checked afterwards, and whether the request is met
        await this._verify.endTurn(this._subagentHost, config.get<boolean>('acceptanceReview', true), signal);
        const passport = config.get<boolean>('changeReport', true) ? this._passport.build() : undefined;
        if (passport) { const markdown = passportMarkdown(passport); this._post({ type: 'patchPassport', id: msgId, passport, markdown }); this._verify.finish(markdown); }
        if (this._teamSteer && this._steer) { this._pendingUserMessages.push({ text: this._steer }); }
        this._steer = ''; this._teamSteer = false;
        this._post({ type: 'endMessage', id: msgId });
        const recording = this._recording;
        this._recording = null;
        if (recording?.truncated) {
            recording.events.push({ type: 'appendContent', text: '\n\n*\u2026 (the rest of this response was too long to store)*' });
        }
        this._abortController = null;

        // ── Completion notification (fires when user has switched away) ───────────
        if (!signal.aborted) {
            const cfg = vscode.workspace.getConfiguration('codico');
            const notifyEnabled = cfg.get<boolean>('completionNotificationsEnabled', true);
            const thresholdMs = cfg.get<number>('completionNotificationThresholdMs', 5000);
            const elapsed = Date.now() - _taskStartMs;
            if (notifyEnabled && elapsed >= thresholdMs && !vscode.window.state.focused) {
                const shownText = this._planGoal !== null ? `Plan: ${this._planGoal}` : rawText;
                const label = shownText.replace(/\s+/g, ' ').trim().slice(0, 60);
                // Not awaited: the notification can stay open indefinitely, and the agent
                // must not stay busy (dropping queued messages) until it is dismissed.
                void vscode.window.showInformationMessage(
                    `Codico finished: "${label}${label.length < shownText.trim().length ? '…' : ''}"`,
                    'Open Chat'
                ).then(action => {
                    if (action === 'Open Chat') {
                        void vscode.commands.executeCommand('workbench.view.extension.codico-container');
                    }
                });
            }
        }

        // Track assistant response for thread resume display: the full recorded reply,
        // plus a short text summary used for thread search
        let summaryText = '';
        if (this._history.length > 0) {
            const lastMsg = this._history[this._history.length - 1];
            if (lastMsg.role === 'assistant') {
                const raw = typeof lastMsg.content === 'string'
                    ? lastMsg.content
                    : (lastMsg.content as MessageContentPart[]).filter(p => p.type === 'text').map(p => (p as { type: 'text'; text: string }).text).join('');
                const displayText = raw
                    .replace(/(`{3,})(?:write_file|read_file|edit_file|run_terminal|search_files|find_files|list_directory|get_diagnostics|fetch_url|web_search|remember|browser_\w+|mcp_call|lsp_symbol|debug_\w+|update_todo|delegate|search_code|team|app|browser_expect|acceptance)[\s\S]*?\1/g, '[tool call]')
                    .trim().slice(0, 300);
                summaryText = displayText;
            }
        }
        if (summaryText || (recording && recording.events.length > 0)) {
            this._displayMessages.push({ role: 'assistant', text: summaryText, events: recording?.events, at: Date.now(), usage: taskUsage.record() });
        }

        // In edits mode: surface queued proposals for review
        if (this._editsMode && this._editProposals.hasProposals) {
            if (this._editProposals.count <= 3) {
                void this._editProposals.openAllDiffs();
            }
            this._post({ type: 'proposalsReady', proposals: this._editProposals.webviewState });
        }

        // Before persisting: trim a dangling [Tool Results] user message. This can be
        // left by an aborted mid-iteration (deliberate Stop) or by hitting MAX_ITERATIONS
        // while tool results are still pending. In both cases the false resume-offer must
        // be suppressed.
        if (this._history.length > 0) {
            const last = this._history[this._history.length - 1];
            if (last.role === 'user' && typeof last.content === 'string' &&
                last.content.startsWith('[Tool Results]')) {
                this._history.pop();
            }
        }

        // Persist conversation history + display transcript
        await this._historyStore.update(this._historyKey, this._history);
        await this._store.update(threadDisplayKey(this._activeThreadId), this._displayMessages);
        await this._threads.updateMeta(this._planGoal !== null ? `Plan: ${this._planGoal}` : rawText, taskUsage);
        this._post({ type: 'threadList', threads: this._threads.list() });

        // Generate follow-up suggestions (non-blocking, best-effort)
        const followUpEnabled = vscode.workspace.getConfiguration('codico').get<boolean>('followUpSuggestionsEnabled', true);
        if (followUpEnabled && (isOllama || isDirect || apiKey) && !signal.aborted) {
            const followUpAbort = new AbortController();
            this._followUpAbortController = followUpAbort;
            void this._generateFollowUps(msgId, apiKey, model, isOllama, ollamaBaseUrl, ollamaModel, followUpAbort.signal, isDirect, directApiKey, directParsed?.providerId ?? '', directParsed?.modelId ?? '');
        }

        // ── Auto-commit ───────────────────────────────────────────────────────
        if (!signal.aborted && this._autoCommit && this._filesWrittenThisTurn > 0) {
            void autoCommit(this._panel, apiKey, model, isOllama, ollamaBaseUrl, ollamaModel, rawText, isDirect, directApiKey, directParsed?.providerId ?? '', directParsed?.modelId ?? '');
        }

        // ── Auto-compact: summarize history when prompt tokens exceed threshold ──
        const autoCompactThreshold = config.get<number>('autoCompactThreshold', 60_000);
        if (!signal.aborted && this._autoCompact && this._lastPromptTokens > autoCompactThreshold && this._history.length >= this._compactRetryAt) {
            await this._compaction.run(apiKey, model, isOllama, ollamaBaseUrl, ollamaModel, isDirect, directApiKey, directParsed?.providerId ?? '', directParsed?.modelId ?? '', signal);
        }

        } finally {
            if (this._abortController === abortController) { this._abortController = null; }
            // The panel already shows this message: it started no turn, so it gets no actions
            if (!turnStarted && !_skipUserPush) { this._post({ type: 'turnSkipped' }); }
            this._releaseBusy();
        }
    }


    /** Marks the agent free and runs the next message that arrived while it was busy. */
    private _releaseBusy(): void {
        this._busy = false;
        const waiters = this._idleWaiters;
        this._idleWaiters = [];
        waiters.forEach(resolve => resolve());
        // Deferred: callers (e.g. _handlePlan) still have cleanup to run after the turn
        // returns. Starting the next item synchronously let that cleanup clobber its state
        // (a queued plan lost its read-only mode).
        setTimeout(() => this._drainPending(), 0);
    }

    private _drainPending(): void {
        if (this._busy) { return; } // something started meanwhile; its release drains again
        const next = this._pendingUserMessages.shift();
        // Nobody awaits a queued item, so its errors are reported here
        if (next?.planGoal !== undefined) { this._handlePlan(next.planGoal).catch(err => this._postError(err)); }
        else if (next) { this._handleUserMessage(next.text, next.contentParts, next.injectActiveDiagnostics, next.skipUserPush, next.shownAs).catch(err => this._postError(err)); }
    }

    /** Resolves once no task is running (immediately when idle). */
    private _whenIdle(): Promise<void> {
        return this._busy ? new Promise<void>(resolve => this._idleWaiters.push(resolve)) : Promise.resolve();
    }

    /** Cancels the running turn (like Stop) and resolves once the agent is idle. */
    private async _stopTurnAndWait(): Promise<void> {
        this._pendingUserMessages.length = 0;
        if (!this._busy) { return; }
        const idle = this._whenIdle();
        this._abortController?.abort();
        this._approvals.cancelAll();
        await idle;
    }


    private async _generateFollowUps(msgId: string, apiKey: string, model: string, isOllama: boolean, ollamaBaseUrl: string, ollamaModel: string, signal: AbortSignal, isDirect = false, directKey = '', directProviderId = '', directModelId = ''): Promise<void> {
        const suggestions = await generateFollowUps(this._history,
            { apiKey, model, isOllama, ollamaBaseUrl, ollamaModel, isDirect, directKey, directProviderId, directModelId }, signal);
        if (suggestions.length > 0 && !signal.aborted) {
            this._post({ type: 'followUps', id: msgId, suggestions });
        }
    }



    /** Dispatches a single tool call immediately, stores result in _lastInlineResult */
    private async _dispatchTool(tool: ToolCall, msgId: string, signal: AbortSignal): Promise<void> {
        if (signal.aborted) { return; }
        await this.checkpoints.ready; // the turn's checkpoint is taken before anything can change a file

        if (tool.type.startsWith('browser_')) {
            const allowPrivate = vscode.workspace.getConfiguration('codico')
                .get<boolean>('browserAllowPrivateNetwork', false);
            this._external.setAllowPrivateNetwork(allowPrivate);
        }

        // In chat (Ask) mode, block any tool that modifies the workspace or runs commands
        if (this._readOnly) {
            const writeTools = new Set(['write_file', 'edit_file', 'run_terminal', 'browser_navigate', 'browser_click', 'browser_type', 'browser_close', 'mcp_call', 'debug']);
            if (writeTools.has(tool.type)) {
                this._post({ type: 'toolResult', id: msgId, tool: tool.type, label: tool.type, success: false, error: 'Not available in Ask mode' });
                this._lastInlineResult = `[${tool.type}] Not available in Ask mode — switch to Agent mode to use this tool.`;
                return;
            }
        }

        // The project's own rules first: a "before" hook that fails refuses the call
        // Stop does not wait for a page load, a web request or a search to finish
        const stopped = () => { this._post({ type: 'toolResult', id: msgId, tool: tool.type, label: 'stopped', success: false, error: 'Stopped' }); return `[${tool.type}] Stopped by the user before it finished.`; };
        const refused = await this._hooks.before(tool, signal);
        if (refused) {
            this._post({ type: 'toolResult', id: msgId, tool: tool.type, label: 'refused by a project hook', success: false, error: 'Refused by a project hook' });
            this._lastInlineResult = refused;
            return;
        }

        let result = '';
        switch (tool.type) {
            case 'write_file': {
                this._post({ type: 'toolStart', id: msgId, tool: 'write_file', label: tool.filepath });
                result = await this._tools.writeFile(tool, msgId);
                break;
            }
            case 'read_file': {
                this._post({ type: 'toolStart', id: msgId, tool: 'read_file', label: tool.filepath });
                result = await readFileTool(tool, this._delegating ? null : projectHistoryForModel(this._history).history, outcome => this._post({ type: 'toolResult', id: msgId, tool: 'read_file', ...outcome }));
                break;
            }
            case 'list_directory': {
                this._post({ type: 'toolStart', id: msgId, tool: 'list_directory', label: tool.dirpath });
                result = await listDirectoryTool(tool.dirpath, outcome => this._post({ type: 'toolResult', id: msgId, tool: 'list_directory', label: tool.dirpath, ...outcome }));
                break;
            }
            case 'run_terminal': {
                this._post({ type: 'toolStart', id: msgId, tool: 'run_terminal', label: tool.command.slice(0, 72) });
                result = await this._tools.runTerminal(tool, msgId, signal);
                break;
            }
            case 'search_code': {
                this._post({ type: 'toolStart', id: msgId, tool: 'search_code', label: tool.query.slice(0, 70) });
                const found = await this._codeSearch.run(tool, signal);
                this._post({ type: 'toolResult', id: msgId, tool: 'search_code', label: found.label, success: found.success, error: found.error });
                result = found.text;
                break;
            }
            case 'search_files': {
                // Use the same label format that _handleSearchFiles will use for toolResult
                // so showToolResult can find the pending pill and update it in-place.
                const searchLabel = tool.glob ? `"${tool.pattern}" in ${tool.glob}` : `"${tool.pattern}"`;
                this._post({ type: 'toolStart', id: msgId, tool: 'search_files', label: searchLabel });
                result = await untilStopped(this._tools.searchFiles(tool, msgId), signal, stopped);
                break;
            }
            case 'find_files': {
                this._post({ type: 'toolStart', id: msgId, tool: 'find_files', label: tool.pattern });
                result = await untilStopped(this._tools.findFiles(tool, msgId), signal, stopped);
                break;
            }
            case 'edit_file': {
                this._post({ type: 'toolStart', id: msgId, tool: 'edit_file', label: tool.filepath });
                result = await this._tools.editFile(tool, msgId);
                break;
            }
            case 'get_diagnostics': {
                this._post({ type: 'toolStart', id: msgId, tool: 'get_diagnostics', label: tool.filepath || 'workspace' });
                result = await untilStopped(this._external._handleGetDiagnostics(tool, msgId), signal, stopped);
                break;
            }
            case 'team': {
                this._post({ type: 'toolStart', id: msgId, tool: 'team', label: teamLabel(tool) });
                const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                result = !this.team || !this._teamMode ? '[team] ERROR: this thread does not lead a team. The user starts one with /team <goal>.'
                    : await this.team.run(tool, { team: this._activeThreadId || 'team', repoRoot: folder ? await repositoryRoot(folder) : undefined, signal,
                        // A merge changes the workspace like a command does: it is asked for like one
                        approveMerge: task => this._approvals.allowAllCommands ? Promise.resolve(true)
                            : this._approvals.askCommand(permId => ({ type: 'terminalPermissionRequest', id: msgId, permId, command: `git merge --no-ff ${task.branch}`, rules: [] })),
                        review: async task => (await this._delegate({ type: 'delegate', task }, msgId, signal, [])).text });
                this._post({ type: 'toolResult', id: msgId, tool: 'team', label: teamLabel(tool), success: !/^\[team(?: \w+)?\] ERROR/.test(result), error: /^\[team(?: \w+)?\] ERROR: (.{0,120})/.exec(result)?.[1] });
                break;
            }
            case 'delegate': {
                this._post({ type: 'toolStart', id: msgId, tool: 'delegate', label: tool.task.split('\n')[0].slice(0, 80) });
                const delegated = await this._delegate(tool, msgId, signal, (await this._userExtensions.get()).agents);
                this._post({ type: 'activity', text: null });
                this._post({ type: 'toolResult', id: msgId, tool: 'delegate', label: delegated.label, success: delegated.success, error: delegated.error });
                result = delegated.text;
                break;
            }
            case 'remember': {
                // After web or MCP content was read, a note is never saved without being shown: it would be read as fact by every later session
                if (this._external.untrustedContentSeen) { this._approvals.allowAllWrites = false; }
                result = await rememberTool(tool, content => this._tools.writeFile({ type: 'write_file', filepath: MEMORY_FILE, content }, msgId));
                break;
            }
            case 'fetch_url': {
                this._post({ type: 'toolStart', id: msgId, tool: 'fetch_url', label: tool.url });
                result = await untilStopped(this._external._handleFetchUrl(tool, msgId), signal, stopped);
                break;
            }
            case 'web_search': {
                this._post({ type: 'toolStart', id: msgId, tool: 'web_search', label: tool.query.slice(0, 80) });
                result = await untilStopped(this._external._handleWebSearch(tool, msgId), signal, stopped);
                break;
            }
            case 'browser_navigate': {
                this._post({ type: 'toolStart', id: msgId, tool: 'browser_navigate', label: tool.url });
                result = await untilStopped(this._external._handleBrowserNavigate(tool, msgId), signal, stopped);
                break;
            }
            case 'browser_click': {
                this._post({ type: 'toolStart', id: msgId, tool: 'browser_click', label: tool.selector });
                result = await untilStopped(this._external._handleBrowserClick(tool, msgId), signal, stopped);
                break;
            }
            case 'browser_type': {
                this._post({ type: 'toolStart', id: msgId, tool: 'browser_type', label: tool.selector });
                result = await untilStopped(this._external._handleBrowserType(tool, msgId), signal, stopped);
                break;
            }
            case 'app': case 'browser_expect': case 'acceptance':
                result = await this._verify.run(tool, msgId, signal);
                break;
            case 'browser_get_text': {
                this._post({ type: 'toolStart', id: msgId, tool: 'browser_get_text', label: tool.selector ?? 'page' });
                result = await untilStopped(this._external._handleBrowserGetText(tool, msgId), signal, stopped);
                break;
            }
            case 'browser_screenshot': {
                this._post({ type: 'toolStart', id: msgId, tool: 'browser_screenshot', label: 'screenshot' });
                result = await untilStopped(this._external._handleBrowserScreenshot(msgId), signal, stopped);
                break;
            }
            case 'browser_close': {
                this._post({ type: 'toolStart', id: msgId, tool: 'browser_close', label: 'browser' });
                await this._external.closeBrowser();
                this._post({ type: 'toolResult', id: msgId, tool: 'browser_close', label: 'Browser closed', success: true });
                result = '[browser_close] Browser closed.';
                break;
            }
            case 'mcp_call': {
                this._post({ type: 'toolStart', id: msgId, tool: 'mcp_call', label: `${tool.server}/${tool.tool}` });
                result = await this._external._handleMcpCall(tool, msgId, signal);
                break;
            }
            case 'lsp_symbol': {
                this._post({ type: 'toolStart', id: msgId, tool: 'lsp_symbol', label: tool.query });
                result = await untilStopped(this._external._handleLspSymbol(tool, msgId), signal, stopped);
                break;
            }
            case 'debug':
                this._post({ type: 'toolStart', id: msgId, tool: 'debug', label: debugLabel(tool) });
                result = this.debug ? await this.debug.run(tool, { signal, askToRun: what => this._tools.askToRun(what, msgId) }) : '[debug] ERROR: debugging is not available here.';
                this._post({ type: 'toolResult', id: msgId, tool: 'debug', label: debugLabel(tool), success: !/^\[debug \w+\] ERROR/.test(result), error: /^\[debug \w+\] ERROR: (.{0,120})/.exec(result)?.[1] });
                break;
            case 'debug_get_variables': {
                this._post({ type: 'toolStart', id: msgId, tool: 'debug_get_variables', label: `frame ${tool.frameId ?? 0}` });
                result = await this._external._handleDebugGetVariables(tool, msgId);
                break;
            }
            case 'debug_get_callstack': {
                this._post({ type: 'toolStart', id: msgId, tool: 'debug_get_callstack', label: 'call stack' });
                result = await this._external._handleDebugGetCallstack(msgId);
                break;
            }
            case 'debug_list_breakpoints': {
                this._post({ type: 'toolStart', id: msgId, tool: 'debug_list_breakpoints', label: 'breakpoints' });
                result = await this._external._handleDebugListBreakpoints(msgId);
                break;
            }
            case 'update_todo': {
                // Silent UI update — no pill, just posts to webview and returns empty string to continue
                this._post({ type: 'todoUpdate', id: msgId, items: tool.items });
                result = '[update_todo] Task list updated.';
                break;
            }
        }
        // The agent's own edit is searchable at once, without waiting for the file watcher
        if (tool.type === 'write_file' || tool.type === 'edit_file') { this._codeSearch.changedPath(tool.filepath); }
        this._lastInlineResult = result + await this._hooks.after(tool, result, signal);
    }


    // ─── Code Review ─────────────────────────────────────────────────────────


    private async _handlePlan(goal: string): Promise<void> {
        if (!this._view) { return; }
        if (this._busy) {
            // The previous turn is still finishing: run the plan once the agent is free
            this._pendingUserMessages.push({ text: goal, planGoal: goal });
            return;
        }
        // The plan is generated with read-only tools (enforced in code, not just asked of the
        // model); changes are only made after the user approves it.
        this._planGoal = goal;
        this._planAwaitingAnswer = null;
        try {
            await this._handleUserMessage(PLAN_PROMPT + goal);
        } finally {
            this._planGoal = null;
        }
        // The planner asked a clarifying question instead of planning: the answer must
        // continue this plan (read-only), not start a normal agent turn that edits files
        const last = this._history[this._history.length - 1];
        if (last?.role === 'assistant' && /<clarify>[\s\S]*?<\/clarify>/.test(messageText(last))) {
            this._planAwaitingAnswer = goal;
        }
    }

    private async _handleClarifyResponse(answer: string): Promise<void> {
        const goal = this._planAwaitingAnswer;
        this._planAwaitingAnswer = null;
        if (goal !== null) {
            await this._handlePlan(`${goal}\n\nThe user's answer to your clarifying question: ${answer}`);
        } else {
            await this._handleUserMessage(answer);
        }
    }


    // ─── Thread management ───────────────────────────────────────────────────


    private _postUiSettings(): void {
        const cfg = vscode.workspace.getConfiguration('codico');
        this._post({ type: 'uiSettings', density: cfg.get<'comfortable' | 'compact'>('chatDensity', 'comfortable'), showReasoning: cfg.get<boolean>('showReasoning', true),
            compactAt: cfg.get<number>('autoCompactThreshold', 60_000) });
    }









    private _post(msg: ExtensionMessage): void {
        this._view?.webview.postMessage(msg);
        this.backgroundListener?.(msg);
        noteAttention(msg, !!this._view?.visible);
        if (this._recording && (msg as { id?: unknown }).id === this._recording.msgId) {
            this._recordEvent(msg);
        }
    }

    private _recordEvent(msg: ExtensionMessage): void {
        const rec = this._recording;
        if (!rec || !REPLAY_TYPES.has(msg.type)) { return; }
        const { id: _id, ...rest } = msg as ExtensionMessage & { id: string };
        const ev = rest as ReplayEvent;
        if (typeof ev.diff === 'string' && ev.diff.length > REPLAY_DIFF_LIMIT) {
            ev.diff = ev.diff.slice(0, REPLAY_DIFF_LIMIT) + '\n\u2026 (diff truncated)';
        }
        const streamed = ev.type === 'appendContent' || ev.type === 'appendThinking' || ev.type === 'terminalChunk';
        const size = streamed ? (ev.text ?? '').length : JSON.stringify(ev).length;
        if (streamed && rec.size + size > REPLAY_BUDGET) { rec.truncated = true; return; }
        rec.size += size;
        // Merge consecutive chunks of the same stream into one event
        const last = rec.events[rec.events.length - 1];
        if (streamed && last && last.type === ev.type) {
            last.text = (last.text ?? '') + (ev.text ?? '');
            return;
        }
        rec.events.push({ ...ev });
    }


    public focusInput(): void {
        void vscode.commands.executeCommand('workbench.view.extension.codico-container').then(() => {
            this._post({ type: 'focusInput' });
        });
    }

    // ─── HTML ────────────────────────────────────────────────────────────────



}


