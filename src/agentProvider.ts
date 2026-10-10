import * as vscode from 'vscode';
import * as path from 'path';
import * as https from 'https';
import * as nodeCrypto from 'crypto';
import { streamOpenRouter, testOpenRouterEndpoint, ChatMessage, MessageContentPart } from './openRouterClient';
import { streamOllama, ollamaChatCompletion } from './ollamaClient';
import { streamDirect, directSingleCompletion, parseDirectModelId, directSecretKey, getDirectProvider } from './directProviderClient';
import { parseToolBody, scanToolFences, ToolCall, WriteFileTool, ReadFileTool, ListDirectoryTool, RunTerminalTool, SearchFilesTool, FindFilesTool, EditFileTool, GetDiagnosticsTool, FetchUrlTool, BrowserNavigateTool, BrowserClickTool, BrowserTypeTool, BrowserGetTextTool, McpCallTool, LspSymbolTool, DebugGetVariablesTool } from './toolParser';
import { FileManager } from './fileManager';
import { parseAgentMention, buildAgentContext } from './agentRouter';
import { McpManager, McpServerConfig, loadMcpConfigs } from './mcpManager';
import { WorkspaceIndex } from './workspaceIndex';
import { buildPrContext } from './prContextProvider';
import { detectTestCommand, buildTestLoopPrompt } from './testOrchestrator';
import { UndoRedoStack } from './undoRedoStack';
import { EditProposalManager } from './editProposalManager';
import { runGit, fetchCommitMessage } from './commitMessageProvider';
import { isRecoverableStreamInterruption, isUnfulfilledActionAnnouncement, normalizeFinishReason, repeatedPrefixLength, RESUME_OVERLAP_WINDOW, setStreamStallTimeout } from './streamCompletion';
import { getNativeToolDefinitions, nativeToolCallToToolCall, nativeClarifyBlock, invalidNativeCallResult, NativeToolCall } from './nativeTools';
import { killProcessGroup, processGroupAlive, runTerminalProcess, clipTerminalOutput } from './terminalProcess';
import { countWorkspaceDiagnostics } from './workspaceDiagnostics';
import { appendAssistantIteration, NativeToolExecution } from './agentHistory';
import { ExternalToolRuntime } from './externalToolRuntime';
import { WebviewAssets } from './webviewAssets';
import { DisplayMessage, ExtensionMessage, ReplayEvent, REPLAY_BUDGET, REPLAY_DIFF_LIMIT, REPLAY_TYPES, ThreadEntry, WebviewMessage } from './chatProtocol';
import { buildEvaluationRunMetrics, EvaluationRunMetrics, EvaluationToolTraceEvent } from './evaluationMetrics';
import { projectHistoryForModel } from './contextProjection';
import { evaluationToolTarget } from './evaluationTrace';
import { ExplorationController } from './explorationController';
import { formatOutline, OUTLINE_HEAD_LINES, OUTLINE_MIN_LINES, sliceFileByLines } from './fileReadWindow';
import { fileOutlineSymbols } from './fileOutline';
import { buildLocalInvariantAudit } from './localInvariantAudit';
import { shouldRunAgentIteration } from './iterationBudget';
import { applyEditMatch, editFailureContext, resolveEditMatch } from './editMatcher';
import { accoOptimizerFromConfiguration } from './accoProviderOptimizer';
import { filterAllowedWorkspaceUris, isIgnoredDirectoryEntry, resolveWorkspaceToolPath } from './workspaceSecurity';
import { TaskUsage } from './taskUsage';
import { generateFollowUps } from './followUps';
import { planCompaction, summarizerPrompt, summaryProblem, buildCompactedHistory, approvedPlanExecution, isUserRequest, messageText, userRequestText, USER_REQUEST_MARKER } from './historyCompaction';
import { looksLikeIntendedRegex } from './agentEfficiency';
import { computeLineDiff } from './lineDiff';
import { appendPhaseNote, splitPhasePrompt } from './agentPhasePrompt';
import { PLAN_PROMPT, REVIEW_PROMPT } from './agentPrompts';
import { cutAtTurn, lastTurnId } from './threadEditing';
import { openChangeDiff, openFileLink, readDroppedFile, registerChangeDiffProvider } from './chatFiles';
import { buildContextPreamble } from './contextPreamble';
import { ToolLoopGuard } from './toolLoopGuard';
import { readCurrentBytes, readCurrentText, revealFile, sameBytes, writeCurrentBytes } from './workspaceText';

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
    private async _redoTurn(msg: Extract<WebviewMessage, { type: 'editMessage' | 'deleteMessage' | 'regenerate' }>): Promise<void> {
        if (this._busy) { this._post({ type: 'error', message: 'Wait for the current reply to finish, or stop it, first.' }); return; }
        const turnId = msg.type === 'regenerate' ? lastTurnId(this._displayMessages) : msg.turnId;
        const cut = turnId ? cutAtTurn(this._displayMessages, this._history, turnId) : { error: 'There is no message to regenerate.' };
        if ('error' in cut) { this._post({ type: 'error', message: cut.error }); return; }
        const { turn } = cut;
        if (msg.type === 'editMessage' && turn.shownAs) { this._post({ type: 'error', message: 'This message cannot be edited.' }); return; }
        this._history = cut.history;
        this._displayMessages = cut.display;
        this._planAwaitingAnswer = null;
        await this._historyStore.update(this._historyKey, this._history);
        await this._store.update(this._threadDisplayKey(this._activeThreadId), this._displayMessages);
        const text = msg.type === 'editMessage' ? msg.text : msg.type === 'regenerate' ? turn.plan ?? turn.text : undefined;
        const shown = text === undefined ? undefined : turn.plan !== undefined ? `\uD83D\uDCCB Plan: ${text}` : turn.shownAs ?? text;
        const name = this._store.get<ThreadEntry[]>(this._threadsIndexKey, []).find(t => t.id === this._activeThreadId)?.name ?? '';
        this._post({ type: 'threadLoaded', id: this._activeThreadId, name, displayMessages: this._displayMessages, pendingUserText: shown });
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
    private _mcpReady = false;
    private _watchersCreated = false;
    private readonly _workspaceIndex: WorkspaceIndex;
    private _history: ChatMessage[] = [];
    private _activeThreadId: string = '';
    private _displayMessages: DisplayMessage[] = [];
    /** Collects the events of the reply currently streaming, for replay on thread load. */
    private _recording: { msgId: string; events: ReplayEvent[]; size: number; truncated: boolean } | null = null;
    private _abortController: AbortController | null = null;
    private _followUpAbortController: AbortController | null = null;
    private _busy = false;
    // Medium by default: high effort costs noticeably more reasoning tokens on every step
    private _thinkingEffort: 'high' | 'medium' | 'low' = 'medium';
    private _repoInstructions: string | null | undefined = undefined; // undefined = not yet read
    /** Pending inline write-permission requests: permId → resolve fn */
    private _pendingWritePermissions = new Map<string, (result: { granted: boolean; editedContent?: string }) => void>();
    /** Resolves the pending step checkpoint: true = keep going, false = stop. */
    private _checkpointResolver: ((keepGoing: boolean) => void) | null = null;
    /** Messages sent while the previous turn was still finishing; run in order once free. */
    private readonly _pendingUserMessages: Array<{ text: string; contentParts?: MessageContentPart[]; injectActiveDiagnostics?: boolean; skipUserPush?: boolean; planGoal?: string; shownAs?: string }> = [];
    /** Resolved when the agent next becomes idle (used to stop a turn before switching threads). */
    private _idleWaiters: Array<() => void> = [];
    /** Process groups left running by run_terminal commands (POSIX only), keyed by pgid. */
    private readonly _bgProcesses = new Map<number, { command: string; startedAt: number }>();
    private _bgPollTimer: ReturnType<typeof setInterval> | undefined;
    /** Pending inline terminal-permission requests: permId → resolve fn */
    private _pendingTerminalPermissions = new Map<string, (granted: boolean) => void>();
    /** Set to true by "Allow All" for the current agent response; resets each user turn. */
    private _allowAllWrites = false;
    private _allowAllTerminal = false;
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
        this._initThreadsSync();
        // Pre-load webview assets so first render does not block the extension host.
        void this._webviewAssets.preload();
        // Abort in-flight requests when the extension deactivates.
        _context.subscriptions.push({ dispose: () => {
            this._followUpAbortController?.abort();
            this._sessionAbort.abort();
            this._killBackgroundProcesses();
        }});
        // Reload thread list when globalHistory setting is toggled so threads from the
        // newly-active store are immediately visible instead of appearing lost.
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('codico.globalHistory')) {
                this._initThreadsSync();
                this._post({ type: 'threadList', threads: this._getThreadListForWebview() });
            }
            if (e.affectsConfiguration('codico.chatDensity') || e.affectsConfiguration('codico.showReasoning')) { this._postUiSettings(); }
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
    private get _historyKey(): string { return this._threadKey(this._activeThreadId); }
    private _threadKey(id: string): string { return `codico.thread.${id}`; }
    private _threadDisplayKey(id: string): string { return `codico.threadDisplay.${id}`; }
    private get _threadsIndexKey(): string { return 'codico.threads'; }
    private get _activeThreadIdKey(): string { return 'codico.activeThreadId'; }
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
            this._postUiSettings();
            this._post({ type: 'threadList', threads: this._getThreadListForWebview() });
            // Show the active thread's full conversation (the panel starts empty after a reload)
            if (!this._busy && this._displayMessages.length > 0) {
                const active = this._store.get<ThreadEntry[]>(this._threadsIndexKey, []).find(t => t.id === this._activeThreadId);
                this._post({ type: 'threadLoaded', id: this._activeThreadId, name: active?.name ?? '', displayMessages: this._displayMessages });
            }
            // Offer to resume an interrupted agentic session from the previous run
            if (this._isSessionInterrupted()) {
                const summary = this._getInterruptedTaskSummary();
                this._post({ type: 'resumeOffer', summary });
            }
            // Sync initial selection state so the badge is correct on first load
            this._postSelectionBadge();
        }, 200);

        // Connect MCP servers asynchronously (non-blocking)
        if (!this._mcpReady) {
            this._connectMcpServers();
        }

        // Watch workspace files for incremental index updates — only once per session
        if (!this._watchersCreated) {
            this._watchersCreated = true;

            const watcher = vscode.workspace.createFileSystemWatcher('**/*');
            watcher.onDidChange(uri => { if (this._workspaceIndex.isIndexed) { void this._workspaceIndex.reindexFile(uri); } });
            watcher.onDidCreate(uri => { if (this._workspaceIndex.isIndexed) { void this._workspaceIndex.reindexFile(uri); } });
            watcher.onDidDelete(uri => this._workspaceIndex.removeFile(uri));
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
                this._postSelectionBadge();
            });
            const diagOfferWatcher = vscode.languages.onDidChangeDiagnostics(() => _checkProactiveOffer());
            let _selectionDebounce: ReturnType<typeof setTimeout> | undefined;
            const selectionWatcher = vscode.window.onDidChangeTextEditorSelection((e) => {
                if (e.textEditor === vscode.window.activeTextEditor) {
                    clearTimeout(_selectionDebounce);
                    _selectionDebounce = setTimeout(() => this._postSelectionBadge(), 150);
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
    public evaluationApprovals(require?: boolean): string[] {
        if (!this._evaluationMode) { throw new Error('Codico evaluation mode is only available from the VS Code test Extension Host.'); }
        if (require !== undefined) { this._evalRequireApproval = require; }
        return [...this._pendingWritePermissions.keys()];
    }

    /** Test-only: delivers a message as if the panel had sent it. */
    public async handleEvaluationWebviewMessage(msg: WebviewMessage): Promise<void> {
        if (!this._evaluationMode) { throw new Error('Codico evaluation mode is only available from the VS Code test Extension Host.'); }
        await this._onWebviewMessage(msg);
    }

    private async _onWebviewMessage(msg: WebviewMessage): Promise<void> {
        try {
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
                await this._store.update(this._threadDisplayKey(this._activeThreadId), []);
                await this._updateThreadMeta('');
                if (this._editsMode) {
                    this._editsMode = false;
                    this._editProposals.rejectAll();
                    this._post({ type: 'allProposalsResolved' });
                }
                this._post({ type: 'threadList', threads: this._getThreadListForWebview() });
                break;
            case 'setApiKey':
                await vscode.commands.executeCommand('codico.setApiKey');
                break;
            case 'openSettings': {
                const choice = await vscode.window.showQuickPick([
                    { label: '$(key) OpenRouter API Key', detail: 'Used for all OpenRouter models (free & premium)', cmd: 'codico.setApiKey' },
                    { label: '$(key) Direct Provider API Key', detail: 'Set a key for Anthropic, OpenAI, Google, Groq, DeepSeek…', cmd: 'codico.setDirectApiKey' },
                    { label: '$(server) Ollama Base URL', detail: 'Configure local Ollama server address', cmd: 'codico.setOllamaUrl' },
                    { label: '$(git-pull-request) GitHub Token', detail: 'Used for /pr PR review context', cmd: 'codico.setGithubToken' },
                ], { title: 'Codico Settings', placeHolder: 'Select a setting to configure' });
                if (choice) { await vscode.commands.executeCommand(choice.cmd); }
                break;
            }
            case 'closePanel':
                await vscode.commands.executeCommand('workbench.action.closeSidebar');
                break;
            case 'checkpointResponse':
                this._checkpointResolver?.(msg.continue === true);
                this._checkpointResolver = null;
                break;
            case 'killBackgroundProcesses':
                this._killBackgroundProcesses();
                break;
            case 'abortStream':
                this._abortController?.abort();
                // A message waiting for the previous turn to finish is cancelled too; the
                // panel already shows it as running, so end that state explicitly.
                if (this._pendingUserMessages.length > 0) {
                    this._pendingUserMessages.length = 0;
                    this._post({ type: 'endMessage', id: '' });
                }
                // Resolve all pending permission dialogs as denied so their Promises unblock
                this._cancelTurnPrompts();
                this._allowAllWrites = false;
                this._allowAllTerminal = false;
                this._external.resetTurnPermissions();
                break;
            case 'writePermissionResponse': {
                const resolve = this._pendingWritePermissions.get(msg.permId);
                if (resolve) {
                    this._pendingWritePermissions.delete(msg.permId);
                    resolve({ granted: msg.granted });
                }
                break;
            }
            case 'terminalPermissionResponse': {
                const resolve = this._pendingTerminalPermissions.get(msg.permId);
                if (resolve) {
                    this._pendingTerminalPermissions.delete(msg.permId);
                    resolve(msg.granted);
                }
                break;
            }
            case 'allowAllWrites': {
                this._allowAllWrites = true;
                const resolve = this._pendingWritePermissions.get(msg.permId);
                if (resolve) {
                    this._pendingWritePermissions.delete(msg.permId);
                    resolve({ granted: true });
                }
                break;
            }
            case 'writePermissionEdit': {
                const resolve = this._pendingWritePermissions.get(msg.permId);
                if (resolve) {
                    this._pendingWritePermissions.delete(msg.permId);
                    resolve({ granted: true, editedContent: msg.content });
                }
                break;
            }
            case 'allowAllTerminal': {
                this._allowAllTerminal = true;
                const resolve = this._pendingTerminalPermissions.get(msg.permId);
                if (resolve) {
                    this._pendingTerminalPermissions.delete(msg.permId);
                    resolve(true);
                }
                break;
            }
            case 'changeModel': {
                // Validate against known model IDs before persisting
                if (!this._webviewAssets.isValidModelId(msg.model)) {
                    this._post({ type: 'error', message: `Unknown model ID rejected: "${msg.model}"` });
                    break;
                }
                await vscode.workspace
                    .getConfiguration('codico')
                    .update('model', msg.model, vscode.ConfigurationTarget.Global);
                break;
            }
            case 'changeEffort':
                this._thinkingEffort = msg.effort;
                break;
            case 'requestContext':
                await this._handleContextRequest(msg.kind);
                break;
            case 'startReview':
                await this._handleReview(msg.target);
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
            case 'refreshMcp':
                // Not under a running task: it may be calling one of these servers
                await this._whenIdle();
                this._mcpReady = false;
                this._mcp.disconnectAll();
                await this._connectMcpServers();
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
            case 'previewEditDiff':
                await this._editProposals.openDiff(msg.filepath);
                break;
            case 'acceptEdit': {
                const applied = await this._editProposals.applyOne(msg.filepath, (before, after, fp, label, uri) => {
                    this._undoRedo.push({ filepath: fp, uri, before, after, label });
                }, message => this._confirmOverwrite(message));
                // Not applied: the file changed meanwhile and the user kept it; the proposal stays
                if (!applied) { break; }
                this._post({ type: 'proposalAccepted', filepath: msg.filepath });
                this._post({ type: 'undoRedoState', ...this._undoRedo.state });
                if (!this._editProposals.hasProposals) {
                    this._post({ type: 'allProposalsResolved' });
                }
                break;
            }
            case 'rejectEdit':
                this._editProposals.rejectOne(msg.filepath);
                this._post({ type: 'proposalRejected', filepath: msg.filepath });
                if (!this._editProposals.hasProposals) {
                    this._post({ type: 'allProposalsResolved' });
                }
                break;
            case 'acceptAllEdits': {
                await this._editProposals.applyAll((before, after, fp, label, uri) => {
                    this._undoRedo.push({ filepath: fp, uri, before, after, label });
                }, message => this._confirmOverwrite(message));
                this._post({ type: 'undoRedoState', ...this._undoRedo.state });
                // Proposals for files the user chose to keep stay open for review
                this._post(this._editProposals.hasProposals
                    ? { type: 'proposalsReady', proposals: this._editProposals.webviewState }
                    : { type: 'allProposalsResolved' });
                break;
            }
            case 'rejectAllEdits':
                this._editProposals.rejectAll();
                this._post({ type: 'allProposalsResolved' });
                break;
            case 'sendFollowUp':
                await this._handleUserMessage(msg.text);
                break;
            case 'generateTestsFromCoverage':
                await vscode.commands.executeCommand('codico.generateTestsFromCoverage');
                break;
            case 'runAndFixTests':
                await this._handleRunAndFixTests();
                break;
            case 'openProblems':
                await vscode.commands.executeCommand('workbench.actions.view.problems');
                break;
            case 'createThread':
                await this._stopTurnAndWait();
                await this._createThread(msg.name);
                break;
            case 'switchThread':
                await this._stopTurnAndWait();
                await this._switchThread(msg.id);
                break;
            case 'renameThread':
                await this._renameThread(msg.id, msg.name);
                break;
            case 'deleteThread':
                await this._stopTurnAndWait();
                await this._deleteThread(msg.id);
                break;
            case 'threadContextMenu':
                await this._handleThreadContextMenu(msg.id);
                break;
            case 'searchThreads':
                this._post({ type: 'threadSearchResults', query: msg.query, results: this._searchThreads(msg.query) });
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
                    const compactModel = compactCfg.get<string>('model', 'deepseek/deepseek-v4-flash');
                    const isCompactOllama = compactModel.startsWith('ollama/');
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
                            this._post({ type: 'error', message: 'No API key set. Click the ⚙ icon or run "Codico: Set OpenRouter API Key".' });
                            break;
                        }
                    }
                    await this._compactHistory(compactApiKey, compactModel, isCompactOllama, compactOllamaBaseUrl, compactOllamaModel, isCompactDirect, compactDirectKey, compactDirectParsed?.providerId ?? '', compactDirectParsed?.modelId ?? '');
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
            case 'pinThread': {
                const threads = this._store.get<ThreadEntry[]>(this._threadsIndexKey, []);
                const pinned = threads.find(t => t.id === msg.id);
                if (pinned) { pinned.pinned = !pinned.pinned; await this._store.update(this._threadsIndexKey, threads); }
                this._post({ type: 'threadList', threads: this._getThreadListForWebview() });
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

        const approved: McpServerConfig[] = [];
        const persisted = this._context.workspaceState.get<Record<string, true>>(
            'codico.approvedWorkspaceMcp.v1',
            {}
        );

        for (const cfg of configs) {
            if (cfg.source !== 'workspace') {
                approved.push(cfg);
                continue;
            }

            const fingerprint = nodeCrypto
                .createHash('sha256')
                .update(JSON.stringify({
                    name: cfg.name,
                    command: cfg.command,
                    args: cfg.args ?? [],
                    env: cfg.env ?? {},
                }))
                .digest('hex');

            if (persisted[fingerprint]) {
                approved.push(cfg);
                continue;
            }

            const choice = await vscode.window.showWarningMessage(
                `This workspace wants Codico to start MCP server "${cfg.name}".`,
                {
                    modal: true,
                    detail: `Command: ${cfg.command} ${(cfg.args ?? []).join(' ')}\n\nOnly allow MCP servers you trust. They run as local processes with a minimal runtime environment plus any variables explicitly configured for this server.`,
                },
                'Allow Once',
                'Always Allow for Workspace'
            );

            if (choice === 'Allow Once' || choice === 'Always Allow for Workspace') {
                approved.push(cfg);
            }
            if (choice === 'Always Allow for Workspace') {
                persisted[fingerprint] = true;
                await this._context.workspaceState.update('codico.approvedWorkspaceMcp.v1', persisted);
            }
        }

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
        this._allowAllWrites  = this._evaluationMode && !this._evalRequireApproval;
        this._allowAllTerminal = this._evaluationMode;
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

        const config = vscode.workspace.getConfiguration('codico');
        const model = config.get<string>('model', 'deepseek/deepseek-v4-flash');
        const isOllama = model.startsWith('ollama/');
        const isDirect = model.startsWith('direct:');
        const ollamaModel = model.slice('ollama/'.length);
        const ollamaBaseUrl = config.get<string>('ollamaBaseUrl', 'http://localhost:11434');
        const directParsed = isDirect ? parseDirectModelId(model) : null;

        let apiKey = '';
        let directApiKey = '';
        if (isOllama) {
            // no key needed for local Ollama
        } else if (isDirect) {
            if (!directParsed) {
                this._post({ type: 'error', message: `Invalid direct model ID: "${model}"` });
                return;
            }
            directApiKey = await this._context.secrets.get(directSecretKey(directParsed.providerId)) ?? '';
            if (!directApiKey) {
                const prov = getDirectProvider(directParsed.providerId);
                this._post({ type: 'error', message: `No API key for ${prov?.name ?? directParsed.providerId}. Run "Codico: Set Direct Provider API Key" from the command palette.` });
                return;
            }
        } else {
            apiKey = await this._context.secrets.get('openRouterApiKey') ?? '';
            if (!apiKey) {
                this._post({ type: 'error', message: 'No API key set. Click the ⚙ icon or run "Codico: Set OpenRouter API Key".' });
                return;
            }
            // Keep the index aware of the current API key for embedding calls
            this._workspaceIndex.setApiKey(apiKey);
        }
        const customPrefix = config.get<string>('systemPrompt', '') || undefined;
        const autoInject = config.get<boolean>('autoInjectContext', true);
        // 0 (the default) means no iteration limit
        const maxIterations = config.get<number>('maxIterations', 0);
        const verificationGraceIterations = config.get<number>('verificationGraceIterations', 4); const mutationGraceIterations = config.get<number>('mutationGraceIterations', 3);
        // Pause for confirmation every N steps (0 = never)
        const checkpointSteps = config.get<number>('checkpointSteps', 50);
        const taskUsage = new TaskUsage(config.get<number>('taskTokenBudget', 0));
        const nativeToolCalling = config.get<boolean>('nativeToolCalling', true);
        setStreamStallTimeout(config.get<number>('streamStallTimeoutSeconds', 300));
        const accoOptimizer = accoOptimizerFromConfiguration(config, !isOllama && !isDirect);

        // Load repo instructions once per session
        if (this._repoInstructions === undefined) {
            this._repoInstructions = await this._loadRepoInstructions();
        }

        // Build effective system prompt prefix (repo instructions + custom prefix + MCP tools)
        let effectivePrefix = this._repoInstructions
            ? `[Repository Instructions]\n${this._repoInstructions}`
            : undefined;
        if (customPrefix) {
            effectivePrefix = effectivePrefix ? `${effectivePrefix}\n\n${customPrefix}` : customPrefix;
        }
        // Append MCP tool documentation if any servers are connected
        const mcpSection = this._mcp.buildSystemPromptSection();
        if (mcpSection) {
            effectivePrefix = effectivePrefix ? `${effectivePrefix}\n\n${mcpSection}` : mcpSection;
        }
        // In Edits Mode: instruct the AI to emit ALL file mutations in one pass
        if (this._editsMode) {
            const editsNote = '[EDITS MODE] You are in multi-file edits mode. Use write_file and edit_file tools to propose changes across as many files as needed. All changes will be shown as diffs for user review before being applied. Emit every required file change in this single response — do not wait for confirmation between files.';
            effectivePrefix = effectivePrefix ? `${effectivePrefix}\n\n${editsNote}` : editsNote;
        }

        // Append response summary instruction if enabled
        const summaryEnabled = config.get<boolean>('responseSummaryEnabled', true);
        if (summaryEnabled) {
            const summaryNote = 'Only at the very end of the entire task — in your final reply when you have no more tool calls to make and the work is fully complete — add a single `---` horizontal rule followed by a **Summary** section (2–4 concise bullet points) and a one-sentence **Conclusion**. Never add this block mid-task, after individual tool calls, or in intermediate responses. Do NOT add it for single-sentence answers, tool-only responses, or clarifying questions.';
            effectivePrefix = effectivePrefix ? `${effectivePrefix}\n\n${summaryNote}` : summaryNote;
        }

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
            this._history.push({ role: 'user', content: userContent, turnId });
            // Saved as the panel showed it live (a plan goal, not the planner prompt); `prompt` keeps what was sent
            const shown = this._planGoal !== null ? `\uD83D\uDCCB Plan: ${this._planGoal}` : shownAs ?? rawText.slice(0, 20_000);
            this._displayMessages.push({ role: 'user', text: shown, id: turnId, at: Date.now(), plan: this._planGoal ?? undefined,
                prompt: this._planGoal === null && shown !== rawText ? rawText : undefined });
        }

        // Auto-name the thread immediately from the first user message so the sidebar updates right away
        void this._updateThreadMeta(this._planGoal !== null ? `Plan: ${this._planGoal}` : rawText).then(() => {
            this._post({ type: 'threadList', threads: this._getThreadListForWebview() });
        });

        const msgId = Date.now().toString();
        // planGoal marks this reply as a plan: the panel offers Approve only on it
        this._post({ type: 'startMessage', id: msgId, planGoal: this._planGoal ?? undefined, turnId, editable: turnId ? this._planGoal !== null || (!shownAs && rawText.length <= 20_000) : undefined });
        turnStarted = true;
        this._recording = { msgId, events: [], size: 0, truncated: false };

        // Abort any in-flight follow-up request from the previous message
        this._followUpAbortController?.abort();
        this._followUpAbortController = null;

        const MAX_STREAM_RECOVERY_ATTEMPTS = 5;
        let streamRecoveryAttempts = 0;
        // Visible text just before a cutoff; the resumed response is checked against it
        // so any restarted sentence is dropped and the seam stays invisible.
        let resumeTail: string | null = null;
        let recoveryStatusShown = false;
        const MAX_ACTION_NUDGES = 2; let actionNudges = 0;
        // Reminders answered without any tool call before the turn stops instead of
        // re-sending them (each reminder is another paid model request).
        const MAX_STALLED_VERIFICATION_NUDGES = 3;
        let verificationNudges = 0;
        // Iterations in a row in which no tool call could run (repeats, blocked calls): ends a stuck
        // model, since there is no iteration limit while a change awaits verification
        const MAX_BLOCKED_ONLY_ITERATIONS = 3;
        let blockedOnlyIterations = 0;
        let currentPhaseNote: string | undefined = ''; // undefined: compaction may have dropped the note
        const nativeTools = !isOllama && nativeToolCalling
            ? getNativeToolDefinitions(this._readOnly)
            : [];

        // Circuit breaker for a model repeating the same call while nothing changes
        const loopGuard = new ToolLoopGuard();
        // Read-only turns (Ask mode, planning) must not be nudged to "make the code change"
        const exploration = new ExplorationController(this._readOnly ? '' : rawText, maxIterations);
        try {
            for (let i = 0; shouldRunAgentIteration(i, maxIterations, exploration.verificationPending, verificationGraceIterations, exploration.mutationGracePending, mutationGraceIterations, exploration.lastMutationIteration); i++) {
                if (signal.aborted) { break; }
                if (this._evaluationMode && this._evaluationTokenBudget > 0 &&
                    this._evalPromptTokens + this._evalCompletionTokens >= this._evaluationTokenBudget) {
                    this._evalBudgetExceeded = true;
                    this._post({
                        type: 'appendContent',
                        id: msgId,
                        text: `\n\n⚠ Evaluation token budget reached (${this._evaluationTokenBudget.toLocaleString()} cumulative tokens).\n`,
                    });
                    break;
                }
                this._evalSteps = Math.max(this._evalSteps, i + 1);
                exploration.beginIteration();
                this._post({ type: 'stepProgress', id: msgId, step: i + 1 });

                let fullContent = '';
                let lastSentPos = 0;    // how far into fullContent we've sent as appendContent
                let dispatchedUpTo = 0; // how far into fullContent we've dispatched tool fences
                const inlineToolResults: string[] = [];
                const fencedToolResults: string[] = [];
                const nativeToolExecutions: NativeToolExecution[] = [];
                let recoverableStreamInterruption: string | null = null;
                let recoverableFinishReason: string | null = null;

                let resumeBuffer = '';
                let iterationReasoning = ''; // the reply's reasoning, when the provider needs it back (DeepSeek)

                // Large write_file/edit_file bodies are hidden until complete; show their
                // progress in the status bar so a long write never looks idle.
                let draftReported = false;
                let draftLines = 0;
                const reportDraftProgress = (fence: string) => {
                    const m = /^```(write_file|edit_file)\r?\nfilepath:\s*(.+)/.exec(fence);
                    if (!m) { return; }
                    const lines = fence.split('\n').length;
                    if (draftReported && lines - draftLines < 10) { return; }
                    draftReported = true;
                    draftLines = lines;
                    const name = path.basename(m[2].trim());
                    const verb = m[1] === 'write_file' ? 'Writing' : 'Editing';
                    this._post({ type: 'activity', text: `${verb} ${name}\u2026 ${lines} lines` });
                };

                // Once a loop is detected, the rest of this response is not executed either
                let loopDetected = false;
                let ranTool = false;
                const dispatchToolCall = async (tool: ToolCall): Promise<{ keepGoing: boolean; result: string }> => {
                    if (loopDetected) {
                        const skipped = `[System] Not executed: \`${tool.type}\` came after a repeated tool call in the same response. Change your approach first.`;
                        inlineToolResults.push(skipped);
                        return { keepGoing: false, result: skipped };
                    }
                    const { count: callCount, loop } = loopGuard.check(tool);
                    if (loop) {
                        loopDetected = true;
                        const nudge = `[System] The tool call \`${tool.type}\` with the same arguments has been issued ${callCount} times. You are in a loop. Stop repeating this call. Either the information you need does not exist, or you should try a completely different approach.`;
                        inlineToolResults.push(nudge);
                        this._post({ type: 'appendContent', id: msgId, text: `\n⚠️ Loop detected — same tool call issued ${callCount} times. Stopping repetition.\n` });
                        return { keepGoing: false, result: nudge };
                    }

                    const explorationCheck = exploration.before(tool, this._readOnly);
                    if (explorationCheck.block) {
                        if (this._evaluationMode) {
                            this._evalTrace.push({
                                step: this._evalSteps,
                                tool: 'exploration_block',
                                target: evaluationToolTarget(tool),
                            });
                        }
                        inlineToolResults.push(explorationCheck.block);
                        return { keepGoing: true, result: explorationCheck.block };
                    }

                    if (explorationCheck.isExploration) {
                        this._evalToolCalls++;
                        if (this._evaluationMode) {
                            this._evalTrace.push({
                                step: this._evalSteps,
                                tool: tool.type,
                                target: evaluationToolTarget(tool),
                            });
                        }
                        ranTool = true;
                        await this._dispatchTool(tool, msgId, signal);
                        loopGuard.ran(tool);
                        let result = this._lastInlineResult ?? `[${tool.type}] completed`;
                        this._lastInlineResult = undefined;
                        if (explorationCheck.guidance) { result += `\n\n${explorationCheck.guidance}`; }
                        inlineToolResults.push(result);
                        return { keepGoing: true, result };
                    }

                    if (exploration.blocksTerminal(tool)) {
                        const result = '[System] Source-inspection terminal commands are disabled in the current focused phase. ' +
                            'Use the edited-file read tool, edit/write tools, or tests/builds/diagnostics for verification.';
                        if (this._evaluationMode) {
                            this._evalTrace.push({
                                step: this._evalSteps,
                                tool: 'exploration_block',
                                target: evaluationToolTarget(tool),
                            });
                        }
                        inlineToolResults.push(result);
                        return { keepGoing: true, result };
                    }

                    this._evalToolCalls++;
                    if (this._evaluationMode) {
                        this._evalTrace.push({
                            step: this._evalSteps,
                            tool: tool.type,
                            target: evaluationToolTarget(tool),
                        });
                    }
                    ranTool = true;
                    await this._dispatchTool(tool, msgId, signal);
                    loopGuard.ran(tool);
                    let result = this._lastInlineResult ?? `[${tool.type}] completed`;
                    this._lastInlineResult = undefined;
                    const followThrough = exploration.after(tool, result);
                    if (tool.type === 'write_file' || tool.type === 'edit_file' || !exploration.verificationPending) { verificationNudges = 0; }
                    if (followThrough) { result += `\n\n${followThrough}`; }
                    inlineToolResults.push(result);
                    return { keepGoing: true, result };
                };

                // Dispatch every newly complete tool fence, sending the text before each first.
                // `final` accepts a closing line that is the last thing in the stream.
                const dispatchFences = async (final: boolean): Promise<void> => {
                    for (const fence of scanToolFences(fullContent, dispatchedUpTo, final).fences) {
                        const fenceStart = fence.start;
                        const fenceEnd = fence.end;

                        // Send text before this fence (strips the fence from display)
                        if (fenceStart > lastSentPos) {
                            this._post({ type: 'appendContent', id: msgId, text: fullContent.slice(lastSentPos, fenceStart) });
                        }
                        lastSentPos = fenceEnd;
                        dispatchedUpTo = fenceEnd;

                        // Dispatch tool — toolStart is posted inside _dispatchTool,
                        // which causes the webview to finalize the current text segment
                        // and create a new one after the pill
                        const tools = parseToolBody(fence.type, fence.body);
                        if (tools.length > 0) {
                            const dispatched = await dispatchToolCall(tools[0]);
                            fencedToolResults.push(dispatched.result);
                            if (!dispatched.keepGoing) { return; }
                        }
                    }
                };

                const processContent = async (text: string): Promise<void> => {
                    fullContent += text;

                    // Dispatch any newly complete tool fences, sending pre-fence text first
                    await dispatchFences(false);

                    // Determine safe send boundary: hold back only the last ``` if it could
                    // still become a tool fence (nothing after it, or a tool-name first letter
                    // with no newline yet). Once a newline is received after ```, the name is
                    // confirmed and we know whether it's a tool fence or not — no more holdback.
                    // This avoids freezing content during common language fences like ```bash,
                    // ```rust, ```shell, etc. for the entire duration of the code block.
                    const tail = fullContent.slice(dispatchedUpTo);
                    const lastTripleIdx = tail.lastIndexOf('```');
                    let safeEnd: number;
                    if (lastTripleIdx === -1) {
                        // No ``` at all — hold back 1-2 trailing backticks that could start one
                        const trailingTicks = tail.match(/`+$/)?.[0].length ?? 0;
                        safeEnd = trailingTicks > 0 && trailingTicks < 3
                            ? fullContent.length - trailingTicks
                            : fullContent.length;
                    } else {
                        const afterTriple = tail.slice(lastTripleIdx + 3);
                        // Unresolved if nothing follows, or a tool-name letter without a newline yet
                        const unresolved = afterTriple.length === 0 ||
                            (/^[wrslfesgbmdu]/.test(afterTriple) && !afterTriple.includes('\n'));
                        safeEnd = unresolved ? dispatchedUpTo + lastTripleIdx : fullContent.length;
                    }
                    // Never display the body of a tool fence that is still open: it is either
                    // dispatched once complete or dropped if the stream is cut off.
                    const openFence = scanToolFences(fullContent, dispatchedUpTo, false).unclosedStart;
                    if (openFence !== -1) {
                        safeEnd = Math.min(safeEnd, openFence);
                        reportDraftProgress(fullContent.slice(openFence));
                    } else if (draftReported) {
                        draftReported = false;
                        this._post({ type: 'activity', text: null });
                    }
                    if (safeEnd > lastSentPos) {
                        this._post({ type: 'appendContent', id: msgId, text: fullContent.slice(lastSentPos, safeEnd) });
                        lastSentPos = safeEnd;
                    }
                };

                // The system prompt and tool list stay the same for the whole task so providers can reuse
                // their prompt cache. A phase change is added to the conversation instead (append-only).
                const { systemPrompt: systemPromptOverride, phaseNote } = splitPhasePrompt(exploration.systemPrompt(this._readOnly));
                if (phaseNote !== currentPhaseNote && (phaseNote || currentPhaseNote)) { appendPhaseNote(this._history, phaseNote); currentPhaseNote = phaseNote; }
                const projectedHistory = projectHistoryForModel(this._history);
                const requestHistory = projectedHistory.history;
                if (this._evaluationMode) {
                    this._evalProjectedCharsOmitted += projectedHistory.omittedChars;
                }
                for await (const chunk of isOllama
                    ? streamOllama(ollamaBaseUrl, requestHistory, ollamaModel, effectivePrefix, signal, systemPromptOverride)
                    : isDirect && directParsed
                        ? streamDirect(directApiKey, requestHistory, directParsed.providerId, directParsed.modelId, effectivePrefix, signal, this._thinkingEffort, systemPromptOverride, nativeTools, this._evaluationMode ? testOpenRouterEndpoint(process.env.CODICO_TEST_DIRECT_URL) : undefined)
                        : streamOpenRouter(apiKey, requestHistory, model, effectivePrefix, signal, this._thinkingEffort, systemPromptOverride, nativeTools, this._evaluationMode ? testOpenRouterEndpoint(process.env.CODICO_TEST_OPENROUTER_URL) : undefined, accoOptimizer)) {
                    if (signal.aborted) { break; }
                    if (recoveryStatusShown) {
                        recoveryStatusShown = false;
                        this._post({ type: 'activity', text: null });
                    }
                    if (chunk.type === 'thinking') {
                        this._post({ type: 'appendThinking', id: msgId, text: chunk.text });
                    } else if (chunk.type === 'content') {
                        let text = chunk.text;
                        if (resumeTail !== null) {
                            // Buffer the start of a resumed response until it can be
                            // compared with the pre-cutoff text, then drop any repetition.
                            resumeBuffer += text;
                            if (resumeBuffer.length < resumeTail.length + 20) { continue; }
                            text = resumeBuffer.slice(repeatedPrefixLength(resumeTail, resumeBuffer));
                            resumeTail = null;
                            resumeBuffer = '';
                        }
                        if (text) { await processContent(text); }
                    } else if (chunk.type === 'native_tool') {
                        const call: NativeToolCall & { id: string } = {
                            ...chunk.call,
                            id: chunk.call.id ?? `codico_${nodeCrypto.randomBytes(8).toString('hex')}`,
                        };
                        // A native `clarify` call becomes the <clarify> block the panel renders.
                        // It is not recorded as a tool call: the turn ends waiting for the user.
                        const clarifyBlock = nativeClarifyBlock(call);
                        if (clarifyBlock) {
                            await processContent(`${fullContent.trim() ? '\n\n' : ''}${clarifyBlock}\n`);
                            continue;
                        }
                        const tool = nativeToolCallToToolCall(call);
                        if (!tool) {
                            // Unknown tool or unusable arguments: return the error as the tool
                            // result so the model can correct the call and the turn continues.
                            const result = invalidNativeCallResult(call);
                            nativeToolExecutions.push({ call, result });
                            inlineToolResults.push(result);
                            continue;
                        }
                        const dispatched = await dispatchToolCall(tool);
                        nativeToolExecutions.push({ call, result: dispatched.result });
                    } else if (chunk.type === 'reasoning') {
                        iterationReasoning = chunk.text;
                    } else if (chunk.type === 'usage') {
                        this._lastPromptTokens = chunk.promptTokens;
                        this._evalPromptTokens += chunk.promptTokens;
                        this._evalCompletionTokens += chunk.completionTokens;
                        if (this._evaluationMode && this._evaluationTokenBudget > 0 && this._evalPromptTokens + this._evalCompletionTokens >= this._evaluationTokenBudget) { this._evalBudgetExceeded = true; }
                        taskUsage.add(chunk.totalTokens, chunk.costUsd, chunk.cachedTokens);
                        this._post({ type: 'tokenUsage', promptTokens: chunk.promptTokens, completionTokens: chunk.completionTokens, totalTokens: chunk.totalTokens, taskTokens: taskUsage.tokens, taskCostUsd: taskUsage.costUsd, cachedTokens: chunk.cachedTokens, taskCachedTokens: taskUsage.cachedTokens });
                    } else if (chunk.type === 'finish') {
                        const reason = normalizeFinishReason(chunk.reason);
                        if (reason === 'length') {
                            recoverableFinishReason = reason;
                        } else {
                            this._post({ type: 'streamFinishReason', id: msgId, reason });
                        }
                    } else if (chunk.type === 'stream_error') {
                        if (isRecoverableStreamInterruption(chunk.message)) {
                            recoverableStreamInterruption = chunk.message;
                        } else {
                            this._post({ type: 'streamError', id: msgId, message: chunk.message });
                        }
                    }
                }

                if (draftReported) { this._post({ type: 'activity', text: null }); }

                // Stream ended while the start of a resumed response was still buffered
                if (resumeTail !== null && resumeBuffer) {
                    const text = resumeBuffer.slice(repeatedPrefixLength(resumeTail, resumeBuffer));
                    resumeTail = null;
                    resumeBuffer = '';
                    if (text && !signal.aborted) { await processContent(text); }
                }

                // On a cutoff, drop an incomplete trailing tool fence: it was never shown or
                // executed, and the model re-issues it in full when it resumes.
                const isCutoff = !signal.aborted && (recoverableStreamInterruption !== null || recoverableFinishReason === 'length');
                let droppedToolCall = false;
                if (isCutoff) {
                    const openFence = scanToolFences(fullContent, dispatchedUpTo, false).unclosedStart;
                    if (openFence !== -1) {
                        fullContent = fullContent.slice(0, Math.max(openFence, lastSentPos));
                        droppedToolCall = true;
                    }
                }

                // A model can end its response cleanly without writing the closing ``` of
                // its last tool fence. Close it and dispatch the call instead of silently
                // treating the turn as finished. Cut-off streams are left to recovery.
                const cleanEnd = !signal.aborted && !recoverableStreamInterruption && recoverableFinishReason !== 'length';
                // A closing fence line that is the very last thing in the stream
                if (cleanEnd) { await dispatchFences(true); }
                const unclosed = cleanEnd ? scanToolFences(fullContent, dispatchedUpTo, true) : null;
                const unclosedFenceStart = unclosed ? unclosed.unclosedStart : -1;
                if (unclosed && unclosedFenceStart !== -1) {
                    const ticks = /^`+/.exec(fullContent.slice(unclosedFenceStart))?.[0] ?? '```';
                    const tools = parseToolBody(unclosed.unclosedType ?? '', (unclosed.unclosedBody ?? '').replace(/\r?\n$/, ''));
                    if (!fullContent.endsWith('\n')) { fullContent += '\n'; }
                    fullContent += ticks;
                    if (tools.length > 0) {
                        if (unclosedFenceStart > lastSentPos) {
                            this._post({ type: 'appendContent', id: msgId, text: fullContent.slice(lastSentPos, unclosedFenceStart) });
                        }
                        lastSentPos = fullContent.length;
                        dispatchedUpTo = fullContent.length;
                        const dispatched = await dispatchToolCall(tools[0]);
                        fencedToolResults.push(dispatched.result);
                    }
                }

                // Flush any remaining content after stream ends
                if (lastSentPos < fullContent.length) {
                    this._post({ type: 'appendContent', id: msgId, text: fullContent.slice(lastSentPos) });
                }

                if (signal.aborted) {
                    // Preserve completed native tool calls/results even when the user stops
                    // the turn after a tool has already finished.
                    if (fullContent.trim() || inlineToolResults.length > 0) {
                        appendAssistantIteration(this._history, fullContent, nativeToolExecutions, '(interrupted)', iterationReasoning);
                    }
                    break;
                }

                appendAssistantIteration(
                    this._history,
                    fullContent,
                    nativeToolExecutions,
                    recoverableStreamInterruption
                        ? '[Stream interrupted before content]'
                        : '[Assistant turn completed without text]',
                    iterationReasoning
                );

                // Unexpected transport EOFs are recoverable: preserve the partial
                // assistant response and any tool results, then ask the model to
                // continue from the exact cutoff point. This avoids replaying tools or
                // discarding useful partial output. Recovery is deliberately bounded.
                if (recoverableStreamInterruption || recoverableFinishReason === 'length') {
                    if (streamRecoveryAttempts < MAX_STREAM_RECOVERY_ATTEMPTS) {
                        streamRecoveryAttempts++;

                        const recoveryParts: string[] = [];
                        if (fencedToolResults.length > 0) {
                            recoveryParts.push(`[Tool Results]\n\n${fencedToolResults.join('\n\n---\n\n')}`);
                        }

                        const cause = recoverableStreamInterruption
                            ? 'The previous assistant response was interrupted by the network/stream transport.'
                            : 'The previous assistant response reached the provider output-token limit.';

                        recoveryParts.push(
                            '[System Recovery]\n' +
                            cause + ' ' +
                            'Your output is appended directly after what was already shown to the user, so continue exactly ' +
                            'from where it stopped, even mid-sentence. Do not repeat text that was already produced, do not ' +
                            'mention the interruption, and do not repeat tool calls that already completed.' +
                            (droppedToolCall
                                ? ' Your last tool call was cut off before it was complete and was NOT executed: issue it again in full as one complete valid fence.'
                                : '')
                        );
                        this._history.push({ role: 'user', content: recoveryParts.join('\n\n') });

                        // Compare the resumed response against the text shown just before the cutoff
                        const visibleTail = fullContent.slice(dispatchedUpTo).slice(-RESUME_OVERLAP_WINDOW);
                        resumeTail = visibleTail.trim() ? visibleTail : null;

                        this._post({ type: 'activity', text: recoverableStreamInterruption ? 'Reconnecting\u2026' : 'Continuing\u2026' });
                        recoveryStatusShown = true;

                        // Give a dropped connection a moment before reconnecting
                        if (recoverableStreamInterruption) {
                            await new Promise(resolve => setTimeout(resolve, 1000 * streamRecoveryAttempts));
                        }

                        // Recovery should not consume an agentic tool iteration.
                        i--;
                        continue;
                    }

                    if (recoverableFinishReason === 'length') {
                        this._post({ type: 'streamFinishReason', id: msgId, reason: 'length' });
                    } else {
                        this._post({
                            type: 'streamError',
                            id: msgId,
                            message: `${recoverableStreamInterruption} Automatic recovery failed after ${MAX_STREAM_RECOVERY_ATTEMPTS} attempts.`,
                        });
                    }
                    break;
                }

                streamRecoveryAttempts = 0;
                if (inlineToolResults.length === 0) {
                    // A clarifying question ends the turn: wait for the user's answer
                    if (/<clarify>[\s\S]*?<\/clarify>/.test(fullContent)) { break; }
                    const verificationGuidance = exploration.completionGuidance();
                    if (verificationGuidance) {
                        if (verificationNudges >= MAX_STALLED_VERIFICATION_NUDGES) {
                            const pendingWork = verificationGuidance.startsWith('[System Action]')
                                ? 'make the code change this task requires'
                                : 'verify its change';
                            this._post({
                                type: 'appendContent',
                                id: msgId,
                                text: `\n\n> ⚠️ Stopped after ${verificationNudges} reminders: the model kept ending its turn without trying to ${pendingWork}, so this task is not verified as complete.`,
                            });
                            break;
                        }
                        verificationNudges++;
                        this._history.push({ role: 'user', content: verificationGuidance });
                        this._post({ type: 'appendContent', id: msgId, text: '\n\n' }); continue;
                    }
                    // Some models announce an action ("I'll locate the file.") and end the
                    // turn without emitting the tool fence. Ask them to issue it rather than
                    // treating the announcement as the final answer. Bounded per request.
                    if (isUnfulfilledActionAnnouncement(fullContent) && actionNudges < MAX_ACTION_NUDGES) {
                        actionNudges++;
                        this._history.push({
                            role: 'user',
                            content: '[System] Your previous response announced an action but contained no tool call, so nothing was executed. ' +
                                'Issue that tool call now as one complete tool fence. If no action is needed, give your final answer instead.',
                        });
                        this._post({ type: 'appendContent', id: msgId, text: '\n\n' });
                        continue;
                    }
                    break;
                }

                actionNudges = 0;
                // The model is calling tools again, so reminders are no longer "stalled"
                verificationNudges = 0;
                blockedOnlyIterations = ranTool ? 0 : blockedOnlyIterations + 1;
                if (blockedOnlyIterations >= MAX_BLOCKED_ONLY_ITERATIONS) {
                    this._post({ type: 'appendContent', id: msgId, text: '\n\n> ⚠️ Stopped: none of the model\'s tool calls could run (repeated or blocked) in several attempts in a row.' }); break;
                }

                // ── Mid-stream auto-compact ────────────────────────────────────────
                // Compact between iterations while the agent loop is still running so
                // the stream never terminates due to context overflow. The compact runs
                // silently between the current and next iteration; the UI stays in the
                // streaming state and continues as soon as compaction finishes.
                const autoCompactThresholdMid = config.get<number>('autoCompactThreshold', 60_000);
                if (this._autoCompact && this._lastPromptTokens > autoCompactThresholdMid && this._history.length >= this._compactRetryAt) {
                    await this._compactHistory(apiKey, model, isOllama, ollamaBaseUrl, ollamaModel, isDirect, directApiKey, directParsed?.providerId ?? '', directParsed?.modelId ?? '', signal);
                    currentPhaseNote = undefined; // a phase note may be in the summarised part: re-add it
                }

                // Fenced compatibility tools return results as a normal user message.
                // Native calls already have provider-native tool result turns above.
                if (fencedToolResults.length > 0) {
                    const resultText = `[Tool Results]\n\n${fencedToolResults.join('\n\n---\n\n')}`;
                    this._history.push({ role: 'user', content: resultText });
                }

                // Periodic checkpoint so a run that has gone off track does not spend
                // tokens indefinitely. Waits for the user; Stop also ends the wait.
                if (checkpointSteps > 0 && (i + 1) % checkpointSteps === 0 && shouldRunAgentIteration(i + 1, maxIterations, exploration.verificationPending, verificationGraceIterations, exploration.mutationGracePending, mutationGraceIterations, exploration.lastMutationIteration)) {
                    if (!await this._awaitCheckpoint(msgId, i + 1, signal)) { break; }
                }

                // Token budget: pause each time the task crosses another budget's worth
                if (taskUsage.budgetExceeded) {
                    if (!await this._awaitCheckpoint(msgId, i + 1, signal, taskUsage.budgetPrompt())) { break; }
                    taskUsage.extendBudget();
                }

            }
        } catch (err: unknown) {
            // Only roll back if no tool calls have completed yet.  If the history already
            // contains assistant replies (length > rollback+1), those iterations wrote files
            // that are now on disk — wiping them from history would make chat state diverge
            // from the file system.  Keep completed history; only trim an orphaned user message.
            // Only ever shorten: if mid-turn compaction already replaced the history it can be
            // shorter than historyRollbackLen, and assigning length would pad it with holes.
            if (this._history.length > historyRollbackLen && this._history.length <= historyRollbackLen + 1) {
                this._history.length = historyRollbackLen;
            }
            if (this._displayMessages.length > displayRollbackLen) {
                this._displayMessages.length = displayRollbackLen;
            }
            if (!signal.aborted) {
                const message = err instanceof Error ? err.message : String(err);
                this._post({ type: 'error', message });
            }
        }

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
                    .replace(/(`{3,})(?:write_file|read_file|edit_file|run_terminal|search_files|find_files|list_directory|get_diagnostics|fetch_url|browser_\w+|mcp_call|lsp_symbol|debug_\w+|update_todo)[\s\S]*?\1/g, '[tool call]')
                    .trim().slice(0, 300);
                summaryText = displayText;
            }
        }
        if (summaryText || (recording && recording.events.length > 0)) {
            this._displayMessages.push({ role: 'assistant', text: summaryText, events: recording?.events, at: Date.now() });
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
        await this._store.update(this._threadDisplayKey(this._activeThreadId), this._displayMessages);
        await this._updateThreadMeta(this._planGoal !== null ? `Plan: ${this._planGoal}` : rawText, taskUsage);
        this._post({ type: 'threadList', threads: this._getThreadListForWebview() });

        // Generate follow-up suggestions (non-blocking, best-effort)
        const followUpEnabled = vscode.workspace.getConfiguration('codico').get<boolean>('followUpSuggestionsEnabled', true);
        if (followUpEnabled && (isOllama || isDirect || apiKey) && !signal.aborted) {
            const followUpAbort = new AbortController();
            this._followUpAbortController = followUpAbort;
            void this._generateFollowUps(msgId, apiKey, model, isOllama, ollamaBaseUrl, ollamaModel, followUpAbort.signal, isDirect, directApiKey, directParsed?.providerId ?? '', directParsed?.modelId ?? '');
        }

        // ── Auto-commit ───────────────────────────────────────────────────────
        if (!signal.aborted && this._autoCommit && this._filesWrittenThisTurn > 0) {
            void this._runAutoCommit(apiKey, model, isOllama, ollamaBaseUrl, ollamaModel, rawText, isDirect, directApiKey, directParsed?.providerId ?? '', directParsed?.modelId ?? '');
        }

        // ── Auto-compact: summarize history when prompt tokens exceed threshold ──
        const autoCompactThreshold = config.get<number>('autoCompactThreshold', 60_000);
        if (!signal.aborted && this._autoCompact && this._lastPromptTokens > autoCompactThreshold && this._history.length >= this._compactRetryAt) {
            await this._compactHistory(apiKey, model, isOllama, ollamaBaseUrl, ollamaModel, isDirect, directApiKey, directParsed?.providerId ?? '', directParsed?.modelId ?? '', signal);
        }

        } finally {
            if (this._abortController === abortController) { this._abortController = null; }
            // The panel already shows this message: it started no turn, so it gets no actions
            if (!turnStarted && !_skipUserPush) { this._post({ type: 'turnSkipped' }); }
            this._releaseBusy();
        }
    }

    /** Shows a Continue / Stop prompt and resolves with the user's choice (Stop or abort = false). */
    private async _awaitCheckpoint(msgId: string, steps: number, signal: AbortSignal, reason?: string): Promise<boolean> {
        // An already-aborted signal never fires 'abort' again
        if (signal.aborted) { return false; }
        const keepGoing = await new Promise<boolean>((resolve) => {
            this._checkpointResolver = resolve;
            signal.addEventListener('abort', () => resolve(false), { once: true });
            this._post({ type: 'checkpoint', id: msgId, steps, reason });
        });
        this._checkpointResolver = null;
        return keepGoing;
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
        this._cancelTurnPrompts();
        await idle;
    }

    /** Resolves open permission prompts and checkpoints as declined so a stopped turn can end. */
    private _cancelTurnPrompts(): void {
        for (const resolve of this._pendingWritePermissions.values()) { resolve({ granted: false }); }
        this._pendingWritePermissions.clear();
        for (const resolve of this._pendingTerminalPermissions.values()) { resolve(false); }
        this._pendingTerminalPermissions.clear();
        this._checkpointResolver?.(false);
        this._checkpointResolver = null;
    }

    private async _generateFollowUps(msgId: string, apiKey: string, model: string, isOllama: boolean, ollamaBaseUrl: string, ollamaModel: string, signal: AbortSignal, isDirect = false, directKey = '', directProviderId = '', directModelId = ''): Promise<void> {
        const suggestions = await generateFollowUps(this._history,
            { apiKey, model, isOllama, ollamaBaseUrl, ollamaModel, isDirect, directKey, directProviderId, directModelId }, signal);
        if (suggestions.length > 0 && !signal.aborted) {
            this._post({ type: 'followUps', id: msgId, suggestions });
        }
    }

    private async _runAutoCommit(apiKey: string, model: string, isOllama: boolean, ollamaBaseUrl: string, ollamaModel: string, userPrompt: string, isDirect = false, directKey = '', directProviderId = '', directModelId = ''): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) { return; }
        const cwd = folders[0].uri.fsPath;

        try {
            // Stage all changes
            await runGit(['add', '-A'], cwd);

            // Check if there is actually anything staged
            const staged = await runGit(['diff', '--staged', '--name-only'], cwd).catch(() => '');
            if (!staged.trim()) { return; }

            // Generate commit message
            let commitMsg = '';
            try {
                const diff = await runGit(['diff', '--staged'], cwd);
                if (isOllama) {
                    const systemMsg = 'You are a commit message generator. Given a git diff, produce a concise conventional commit message. Format: type(scope): description — max 72 chars. Output ONLY the commit message, nothing else.';
                    commitMsg = await ollamaChatCompletion(
                        ollamaBaseUrl,
                        [{ role: 'system', content: systemMsg }, { role: 'user', content: `Git diff:\n\n${diff.slice(0, 8000)}` }],
                        ollamaModel,
                        100
                    );
                } else if (isDirect) {
                    const commitPrompt = `Generate a concise conventional commit message for this diff. Format: type(scope): description — max 72 chars. Output ONLY the commit message.\n\nGit diff:\n\n${diff.slice(0, 8000)}`;
                    commitMsg = await directSingleCompletion(directKey, directProviderId, directModelId, commitPrompt, 100, this._sessionAbort.signal);
                } else {
                    commitMsg = await fetchCommitMessage(apiKey, model, diff);
                }
            } catch { /* fall back to prompt-based message */ }

            if (!commitMsg) {
                const label = userPrompt.replace(/\s+/g, ' ').trim().slice(0, 60);
                commitMsg = `feat: ${label}${label.length < userPrompt.trim().length ? '…' : ''}`;
            }

            commitMsg = commitMsg.trim().replace(/^["']|["']$/g, '');
            await runGit(['commit', '-m', commitMsg], cwd);

            this._post({ type: 'autoCommitDone', message: commitMsg });
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'autoCommitError', message });
        }
    }

    private async _compactHistory(apiKey: string, model: string, isOllama: boolean, ollamaBaseUrl: string, ollamaModel: string, isDirect = false, directKey = '', directProviderId = '', directModelId = '', signal: AbortSignal = this._sessionAbort.signal): Promise<void> {
        if (signal.aborted) { this._post({ type: 'compactCancelled' }); return; }
        const plan = planCompaction(this._history);
        if (!plan) {
            this._post({ type: 'compactDone', messageCount: 0 });
            return;
        }

        this._post({ type: 'compactStart' });
        const prompt = summarizerPrompt(plan);
        // Room for the summary even when a reasoning model spends part of the budget thinking
        const SUMMARY_MAX_TOKENS = 4000;

        const ask = async (): Promise<string> => {
            if (isOllama) {
                return ollamaChatCompletion(ollamaBaseUrl, [{ role: 'user', content: prompt }], ollamaModel, SUMMARY_MAX_TOKENS, signal);
            } else if (isDirect) {
                return directSingleCompletion(directKey, directProviderId, directModelId, prompt, SUMMARY_MAX_TOKENS, signal);
            } else {
                const body = JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: SUMMARY_MAX_TOKENS,
                    temperature: 0.1,
                    reasoning: { effort: 'low' },
                });
                return new Promise<string>((resolve) => {
                    const req = https.request(
                        {
                            hostname: 'openrouter.ai',
                            path: '/api/v1/chat/completions',
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${apiKey}`,
                                'Content-Type': 'application/json',
                                'HTTP-Referer': 'vscode-codico',
                                'X-Title': 'Codico',
                                'Content-Length': Buffer.byteLength(body),
                            },
                        },
                        (res) => {
                            let data = '';
                            let totalBytes = 0;
                            res.setEncoding('utf8'); // keeps characters split across chunks intact
                            res.on('data', (c: string) => {
                                totalBytes += c.length;
                                if (totalBytes > 256 * 1024) { res.destroy(); resolve(''); return; }
                                data += c.toString();
                            });
                            res.on('end', () => {
                                try { resolve(JSON.parse(data)?.choices?.[0]?.message?.content ?? ''); }
                                catch { resolve(''); }
                            });
                            res.on('error', () => resolve(''));
                        }
                    );
                    req.setTimeout(30_000, () => { req.destroy(); resolve(''); });
                    req.on('error', () => resolve(''));
                    signal.addEventListener('abort', () => { req.destroy(); resolve(''); }, { once: true });
                    req.write(body);
                    req.end();
                });
            }
        };

        // A bad summary would replace the history and the agent would forget its work: check it,
        // retry once, and otherwise keep the history as it is
        let summary = '';
        let problem: string | null = null;
        try {
            for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
                summary = await ask();
                problem = summaryProblem(summary, plan);
                if (!problem) { break; }
            }
        } catch (err: unknown) {
            if (signal.aborted) { this._post({ type: 'compactCancelled' }); return; }
            problem = err instanceof Error ? err.message : String(err);
        }

        // Stopped while summarising: keep the history as it was, and don't bill another step
        if (signal.aborted) {
            this._post({ type: 'compactCancelled' });
            return;
        }

        if (problem) {
            // Not retried on every step: wait until the history has grown
            this._compactRetryAt = this._history.length + 10;
            this._post({ type: 'compactError', message: `History kept as it is: ${problem}.` });
            return;
        }
        this._compactRetryAt = 0;

        // The current request stays verbatim; the kept tail starts at a complete exchange
        this._history = buildCompactedHistory(summary, plan);
        this._lastPromptTokens = 0;

        await this._historyStore.update(this._historyKey, this._history);
        this._post({ type: 'compactDone', messageCount: this._history.length - 1 });
    }

    /** Dispatches a single tool call immediately, stores result in _lastInlineResult */
    private async _dispatchTool(tool: ToolCall, msgId: string, signal: AbortSignal): Promise<void> {
        if (signal.aborted) { return; }

        if (tool.type.startsWith('browser_')) {
            const allowPrivate = vscode.workspace.getConfiguration('codico')
                .get<boolean>('browserAllowPrivateNetwork', false);
            this._external.setAllowPrivateNetwork(allowPrivate);
        }

        // In chat (Ask) mode, block any tool that modifies the workspace or runs commands
        if (this._readOnly) {
            const writeTools = new Set(['write_file', 'edit_file', 'run_terminal', 'browser_navigate', 'browser_click', 'browser_type', 'browser_close', 'mcp_call']);
            if (writeTools.has(tool.type)) {
                this._post({ type: 'toolResult', id: msgId, tool: tool.type, label: tool.type, success: false, error: 'Not available in Ask mode' });
                this._lastInlineResult = `[${tool.type}] Not available in Ask mode — switch to Agent mode to use this tool.`;
                return;
            }
        }

        let result = '';
        switch (tool.type) {
            case 'write_file': {
                this._post({ type: 'toolStart', id: msgId, tool: 'write_file', label: tool.filepath });
                result = await this._handleWriteFile(tool, msgId);
                break;
            }
            case 'read_file': {
                this._post({ type: 'toolStart', id: msgId, tool: 'read_file', label: tool.filepath });
                result = await this._handleReadFile(tool, msgId);
                break;
            }
            case 'list_directory': {
                this._post({ type: 'toolStart', id: msgId, tool: 'list_directory', label: tool.dirpath });
                result = await this._handleListDirectory(tool, msgId);
                break;
            }
            case 'run_terminal': {
                this._post({ type: 'toolStart', id: msgId, tool: 'run_terminal', label: tool.command.slice(0, 72) });
                result = await this._handleRunTerminal(tool, msgId, signal);
                break;
            }
            case 'search_files': {
                // Use the same label format that _handleSearchFiles will use for toolResult
                // so showToolResult can find the pending pill and update it in-place.
                const searchLabel = tool.glob ? `"${tool.pattern}" in ${tool.glob}` : `"${tool.pattern}"`;
                this._post({ type: 'toolStart', id: msgId, tool: 'search_files', label: searchLabel });
                result = await this._handleSearchFiles(tool, msgId);
                break;
            }
            case 'find_files': {
                this._post({ type: 'toolStart', id: msgId, tool: 'find_files', label: tool.pattern });
                result = await this._handleFindFiles(tool, msgId);
                break;
            }
            case 'edit_file': {
                this._post({ type: 'toolStart', id: msgId, tool: 'edit_file', label: tool.filepath });
                result = await this._handleEditFile(tool, msgId);
                break;
            }
            case 'get_diagnostics': {
                this._post({ type: 'toolStart', id: msgId, tool: 'get_diagnostics', label: tool.filepath || 'workspace' });
                result = await this._external._handleGetDiagnostics(tool, msgId);
                break;
            }
            case 'fetch_url': {
                this._post({ type: 'toolStart', id: msgId, tool: 'fetch_url', label: tool.url });
                result = await this._external._handleFetchUrl(tool, msgId);
                break;
            }
            case 'browser_navigate': {
                this._post({ type: 'toolStart', id: msgId, tool: 'browser_navigate', label: tool.url });
                result = await this._external._handleBrowserNavigate(tool, msgId);
                break;
            }
            case 'browser_click': {
                this._post({ type: 'toolStart', id: msgId, tool: 'browser_click', label: tool.selector });
                result = await this._external._handleBrowserClick(tool, msgId);
                break;
            }
            case 'browser_type': {
                this._post({ type: 'toolStart', id: msgId, tool: 'browser_type', label: tool.selector });
                result = await this._external._handleBrowserType(tool, msgId);
                break;
            }
            case 'browser_get_text': {
                this._post({ type: 'toolStart', id: msgId, tool: 'browser_get_text', label: tool.selector ?? 'page' });
                result = await this._external._handleBrowserGetText(tool, msgId);
                break;
            }
            case 'browser_screenshot': {
                this._post({ type: 'toolStart', id: msgId, tool: 'browser_screenshot', label: 'screenshot' });
                result = await this._external._handleBrowserScreenshot(msgId);
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
                result = await this._external._handleLspSymbol(tool, msgId);
                break;
            }
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
        this._lastInlineResult = result;
    }

    private async _handleWriteFile(tool: WriteFileTool, msgId: string): Promise<string> {
        try {
            const target = await resolveWorkspaceToolPath(tool.filepath);
            const beforeBytes = await readCurrentBytes(target.uri);
            const beforeText = beforeBytes ? new TextDecoder().decode(beforeBytes) : '';

            if (this._editsMode) {
                this._editProposals.queue({ filepath: tool.filepath, uri: target.uri, originalContent: beforeBytes, proposedContent: tool.content, label: `write ${tool.filepath}` });
                this._post({ type: 'proposalQueued', filepath: tool.filepath });
                return `[write_file: ${tool.filepath}] Queued as edit proposal`;
            }

            const diff = this._computeLineDiff(beforeText, tool.content);
            let writeResult: { granted: boolean; editedContent?: string };
            if (this._allowAllWrites) {
                writeResult = { granted: true };
            } else {
                const permId = nodeCrypto.randomBytes(8).toString('hex');
                writeResult = await new Promise<{ granted: boolean; editedContent?: string }>((resolve) => {
                    this._pendingWritePermissions.set(permId, resolve);
                    this._post({ type: 'writePermissionRequest', id: msgId, permId, filepath: tool.filepath, preview: '', diff, editableContent: tool.content });
                });
            }

            if (!writeResult.granted) {
                this._post({ type: 'fileWriteResult', id: msgId, filepath: tool.filepath, granted: false });
                return `[write_file: ${tool.filepath}] Denied by user`;
            }

            // Approval can take a while: if the file changed meanwhile (the user edited it),
            // writing would silently replace those changes with content they never saw
            if (!sameBytes(await readCurrentBytes(target.uri), beforeBytes)) {
                this._post({ type: 'fileWriteResult', id: msgId, filepath: tool.filepath, granted: false, error: 'File changed while waiting for approval' });
                return `[write_file: ${tool.filepath}] Not written: the file changed while waiting for approval (probably edited by the user). Read it again and make your change on its current content.`;
            }

            const contentToWrite = writeResult.editedContent ?? tool.content;
            const finalDiff = writeResult.editedContent ? this._computeLineDiff(beforeText, contentToWrite) : diff;
            await this._fileManager.writeFile(tool.filepath, contentToWrite);

            const after = new TextEncoder().encode(contentToWrite);
            this._undoRedo.push({ filepath: tool.filepath, uri: target.uri, before: beforeBytes, after, label: `write_file ${tool.filepath}` });
            this._post({ type: 'undoRedoState', ...this._undoRedo.state });
            this._post({ type: 'fileWriteResult', id: msgId, filepath: tool.filepath, granted: true, diff: finalDiff });
            this._filesWrittenThisTurn++;
            const lineCount = contentToWrite.split('\n').length;
            return `[write_file: ${tool.filepath}] Written successfully (${lineCount} lines). File is on disk — no need to read it back to verify.${buildLocalInvariantAudit(contentToWrite, '')}`;
        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            this._post({ type: 'fileWriteResult', id: msgId, filepath: tool.filepath, granted: false, error: errorMsg });
            return `[write_file: ${tool.filepath}] Error: ${errorMsg}`;
        }
    }

    private async _handleReadFile(tool: ReadFileTool, msgId: string): Promise<string> {
        try {
            const fileUri = (await resolveWorkspaceToolPath(tool.filepath)).uri;
            // Unsaved editor changes included: that is the file the user sees
            const content = await readCurrentText(fileUri);
            // A large file read without a range: an outline and its first lines, not page after page
            const unranged = tool.startLine === undefined && tool.endLine === undefined;
            const outline = unranged && content.split('\n').length > OUTLINE_MIN_LINES ? await fileOutlineSymbols(fileUri) : [];
            const window = outline.length >= 3 ? sliceFileByLines(content, 1, OUTLINE_HEAD_LINES) : sliceFileByLines(content, tool.startLine, tool.endLine);
            const label = window.truncated
                ? `${tool.filepath} lines ${window.startLine}–${window.endLine} of ${window.totalLines}`
                : tool.filepath;
            this._post({ type: 'toolResult', id: msgId, tool: 'read_file', label, success: true });
            const continuation = window.endLine < window.totalLines
                ? `\n… (bounded read; use start_line: ${window.endLine + 1} and end_line to continue, or search_files to target a symbol)\n`
                : '';
            const outlineText = outline.length >= 3 ? `Outline of this ${window.totalLines}-line file (line ranges):\n${formatOutline(outline)}\n\nRead only the range you need with start_line/end_line.\n\n` : '';
            return `[read_file: ${tool.filepath} lines ${window.startLine}–${window.endLine} of ${window.totalLines}]\n${outlineText}\`\`\`\n${window.text}\n\`\`\`${continuation}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'read_file', label: tool.filepath, success: false, error: message });
            return `[read_file: ${tool.filepath}] ERROR: ${message}`;
        }
    }

    private async _handleListDirectory(tool: ListDirectoryTool, msgId: string): Promise<string> {
        try {
            const target = await resolveWorkspaceToolPath(tool.dirpath, true);
            const entries = (await vscode.workspace.fs.readDirectory(target.uri))
                .filter(([name]) => !isIgnoredDirectoryEntry(target, name));
            const lines = entries.map(([name, type]) =>
                type === vscode.FileType.Directory ? `[dir]  ${name}/` : `[file] ${name}`
            );
            this._post({ type: 'toolResult', id: msgId, tool: 'list_directory', label: tool.dirpath, success: true });
            return `[list_directory: ${tool.dirpath}]\n${lines.join('\n')}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'list_directory', label: tool.dirpath, success: false, error: message });
            return `[list_directory: ${tool.dirpath}] ERROR: ${message}`;
        }
    }

    private async _handleRunTerminal(tool: RunTerminalTool, msgId: string, signal: AbortSignal): Promise<string> {
        const shortCmd = tool.command.length > 80
            ? tool.command.slice(0, 80) + '\u2026'
            : tool.command;

        // After the agent has read external content this turn, Allow All no longer covers
        // commands: a prompt-injected page must not be able to run them unattended.
        const askAgain = this._allowAllTerminal && !this._evaluationMode && this._external.untrustedContentSeen;
        let granted: boolean;
        if (this._allowAllTerminal && !askAgain) {
            granted = true;
        } else {
            const permId = nodeCrypto.randomBytes(8).toString('hex');
            granted = await new Promise<boolean>((resolve) => {
                this._pendingTerminalPermissions.set(permId, resolve);
                this._post({ type: 'terminalPermissionRequest', id: msgId, permId, command: tool.command,
                    note: askAgain ? 'Asking again: the agent read web or MCP content in this turn, so Allow All does not cover commands.' : undefined });
            });
        }

        if (!granted) {
            this._post({ type: 'toolResult', id: msgId, tool: 'run_terminal', label: shortCmd, success: false, error: 'Denied' });
            return `[run_terminal] Denied by user:\n${tool.command}`;
        }

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const timeoutSec = Math.max(
            10,
            vscode.workspace.getConfiguration('codico').get<number>('terminalTimeoutSeconds', 300)
        );

        this._post({ type: 'terminalChunk', id: msgId, text: '' });
        const result = await runTerminalProcess({
            command: tool.command,
            cwd,
            timeoutMs: timeoutSec * 1000,
            signal,
            onChunk: (text) => this._post({ type: 'terminalChunk', id: msgId, text }),
        });

        if (result.stopped) {
            this._post({ type: 'toolResult', id: msgId, tool: 'run_terminal', label: shortCmd, success: false });
            return `[run_terminal: ${tool.command}] Stopped by user.\n${clipTerminalOutput(result.output)}`;
        }
        if (result.timedOut) {
            const message = `Timed out after ${timeoutSec}s`;
            this._post({ type: 'toolResult', id: msgId, tool: 'run_terminal', label: shortCmd, success: false, error: message });
            return `[run_terminal: ${tool.command}]\n(timed out after ${timeoutSec}s — the command and its child processes were killed. Long-running processes such as servers must not be started with run_terminal.)\n${clipTerminalOutput(result.output)}`;
        }
        if (result.error) {
            this._post({ type: 'toolResult', id: msgId, tool: 'run_terminal', label: shortCmd, success: false, error: result.error });
            return `[run_terminal: ${tool.command}] ERROR: ${result.error}`;
        }

        const bgNote = result.backgroundProcessGroup &&
            this._trackBackgroundGroup(result.backgroundProcessGroup, tool.command)
            ? '\n(background processes started by this command are still running; the user can stop them from the status bar)'
            : '';
        const success = result.exitCode === 0;
        this._post({
            type: 'toolResult',
            id: msgId,
            tool: 'run_terminal',
            label: shortCmd,
            success,
            error: success ? undefined : `Exit ${result.exitCode}`,
        });
        return `[run_terminal: ${tool.command}]\nExit: ${result.exitCode}\n${clipTerminalOutput(result.output)}${bgNote}`;
    }

    /** Records `pgid` if any process in that group is still alive. Returns true when tracked. */
    private _trackBackgroundGroup(pgid: number, command: string): boolean {
        if (!AgentProvider._groupAlive(pgid)) { return false; }
        this._bgProcesses.set(pgid, { command, startedAt: Date.now() });
        this._postBackgroundProcesses();
        if (!this._bgPollTimer) {
            this._bgPollTimer = setInterval(() => this._pruneBackgroundProcesses(), 5_000);
        }
        return true;
    }

    private static _groupAlive(pgid: number): boolean {
        return processGroupAlive(pgid);
    }

    private _pruneBackgroundProcesses(): void {
        let changed = false;
        for (const pgid of [...this._bgProcesses.keys()]) {
            if (!AgentProvider._groupAlive(pgid)) { this._bgProcesses.delete(pgid); changed = true; }
        }
        if (this._bgProcesses.size === 0 && this._bgPollTimer) {
            clearInterval(this._bgPollTimer);
            this._bgPollTimer = undefined;
        }
        if (changed) { this._postBackgroundProcesses(); }
    }

    private _killBackgroundProcesses(): void {
        for (const pgid of this._bgProcesses.keys()) {
            killProcessGroup(pgid, 'SIGTERM');
            setTimeout(() => killProcessGroup(pgid, 'SIGKILL'), 3_000);
        }
        this._bgProcesses.clear();
        if (this._bgPollTimer) { clearInterval(this._bgPollTimer); this._bgPollTimer = undefined; }
        this._postBackgroundProcesses();
    }

    private _postBackgroundProcesses(): void {
        this._post({
            type: 'backgroundProcesses',
            processes: [...this._bgProcesses.values()].map(p => ({ command: p.command, startedAt: p.startedAt })),
        });
    }

    private async _handleSearchFiles(tool: SearchFilesTool, msgId: string): Promise<string> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            this._post({ type: 'toolResult', id: msgId, tool: 'search_files', label: tool.pattern, success: false, error: 'No workspace folder open' });
            return '[search_files] ERROR: No workspace folder open';
        }

        let matcher: RegExp | null = null;
        if (tool.isRegex) {
            try {
                matcher = new RegExp(tool.pattern);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this._post({ type: 'toolResult', id: msgId, tool: 'search_files', label: tool.pattern, success: false, error: message });
                return `[search_files: ${tool.pattern}] ERROR: Invalid regular expression: ${message}`;
            }
        }

        const include = tool.glob?.trim() || '**/*';
        const exclude = '**/{node_modules,.git,out,dist,coverage,.next,target}/**';
        const uris = await filterAllowedWorkspaceUris(
            await vscode.workspace.findFiles(include, exclude, 600)
        );
        const scan = async (test: (line: string) => boolean): Promise<string[]> => {
            const found: string[] = [];
            for (const uri of uris) {
                if (found.length >= 100) { break; }
                try {
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    if (bytes.byteLength > 1_000_000) { continue; }
                    const text = new TextDecoder().decode(bytes);
                    if (text.includes('\x00')) { continue; }
                    const rel = vscode.workspace.asRelativePath(uri);
                    const lines = text.split('\n');
                    for (let i = 0; i < lines.length && found.length < 100; i++) {
                        if (test(lines[i])) { found.push(`${rel}:${i + 1}:${lines[i].slice(0, 500)}`); }
                    }
                } catch {
                    // Skip unreadable files; continue searching the rest of the workspace.
                }
            }
            return found;
        };
        let matches = await scan(matcher ? (line) => matcher!.test(line) : (line) => line.includes(tool.pattern));
        // Models often send "a|b" without regex mode; such a literal search finds nothing
        let note = '';
        if (matches.length === 0 && !matcher && looksLikeIntendedRegex(tool.pattern)) {
            const re = new RegExp(tool.pattern);
            matches = await scan((line) => re.test(line));
            note = ' (no literal matches; searched as a regular expression)';
        }

        const label = tool.glob ? `"${tool.pattern}" in ${tool.glob}` : `"${tool.pattern}"`;
        this._post({ type: 'toolResult', id: msgId, tool: 'search_files', label: `${label} — ${matches.length} matches`, success: true });
        return matches.length > 0
            ? `[search_files: ${label}]${note}\n${matches.join('\n')}${matches.length >= 100 ? '\n… (truncated at 100 matches)' : ''}\nUse read_file start_line/end_line around the most relevant matches instead of reading large files whole.`
            : `[search_files: ${label}] No matches found${note}`;
    }

    private async _handleFindFiles(tool: FindFilesTool, msgId: string): Promise<string> {
        try {
            const cleanPattern = tool.pattern.replace(/^\*\*\//, '');
            let include: vscode.GlobPattern = `**/${cleanPattern}`;
            const requestedDir = (tool.dirpath ?? '').trim();
            if (requestedDir && requestedDir !== '.') {
                const target = await resolveWorkspaceToolPath(requestedDir, true);
                const scopedPattern = target.relativePath
                    ? `${target.relativePath}/**/${cleanPattern}`
                    : `**/${cleanPattern}`;
                include = new vscode.RelativePattern(target.folder, scopedPattern);
            }

            const exclude = '**/{node_modules,.git,out,dist,coverage,.next,target}/**';
            const uris = await filterAllowedWorkspaceUris(
                await vscode.workspace.findFiles(include, exclude, 200)
            );
            const result = uris.map(uri => vscode.workspace.asRelativePath(uri));
            this._post({ type: 'toolResult', id: msgId, tool: 'find_files', label: `${tool.pattern} — ${result.length} file(s)`, success: true });
            return result.length > 0
                ? `[find_files: ${tool.pattern}]\n${result.join('\n')}${result.length >= 200 ? '\n… (truncated at 200)' : ''}`
                : `[find_files: ${tool.pattern}] No files found`;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'find_files', label: tool.pattern, success: false, error: message });
            return `[find_files: ${tool.pattern}] ERROR: ${message}`;
        }
    }

    private async _handleEditFile(tool: EditFileTool, msgId: string): Promise<string> {
        try {
            const fileUri = (await resolveWorkspaceToolPath(tool.filepath)).uri;
            // Edits mode: a file can have a queued (unwritten) proposal. Build on it, or earlier
            // edits to the same file are lost and edits to a file created by write_file fail.
            const pending = this._editsMode ? this._editProposals.pending(fileUri) : undefined;
            const bytes = pending ? pending.originalContent : await readCurrentBytes(fileUri);
            if (!pending && bytes === null) { throw new Error(`File not found: ${tool.filepath}`); }
            let rawContent = pending ? pending.proposedContent : new TextDecoder().decode(bytes!);

            // Normalize CRLF → LF for matching; oldStr from the parser is always LF-only.
            // Without this, edit_file fails with "old_str not found" on any CRLF file.
            let hasCRLF = rawContent.includes('\r\n');
            let content = hasCRLF ? rawContent.replace(/\r\n/g, '\n') : rawContent;

            const resolved = resolveEditMatch(content, tool.oldStr);
            if (!resolved.match) {
                const err = resolved.error === 'ambiguous'
                    ? `old_str matches ${resolved.candidates}+ locations after safe normalization — provide more context`
                    : 'old_str not found, including safe whitespace-tolerant matching';
                this._post({ type: 'toolResult', id: msgId, tool: 'edit_file', label: tool.filepath, success: false, error: err });
                const fresh = editFailureContext(content, tool.oldStr);
                return `[edit_file: ${tool.filepath}] ERROR: ${err}${fresh ? `\nCurrent source near the closest requested anchor:\n\`\`\`\n${fresh}\n\`\`\`` : ''}`;
            }
            let editMatch = resolved.match;

            const applyEdit = (replacement: string): string => {
                const replaced = applyEditMatch(content, editMatch, replacement);
                // Use a negative lookbehind so existing \r\n pairs in replacement are not
                // double-converted to \r\r\n when restoring the file's original line endings.
                return hasCRLF ? replaced.replace(/(?<!\r)\n/g, '\r\n') : replaced;
            };

            // ── Edits Mode: queue proposal instead of writing immediately ──────
            if (this._editsMode) {
                this._editProposals.queue({ filepath: tool.filepath, uri: fileUri, originalContent: bytes, proposedContent: applyEdit(tool.newStr), label: `edit ${tool.filepath}` });
                this._post({ type: 'proposalQueued', filepath: tool.filepath });
                return `[edit_file: ${tool.filepath}] Queued as edit proposal`;
            }

            // Full-file diff gives the reviewer complete context (before → proposed file)
            const proposedLF = applyEditMatch(content, editMatch, tool.newStr);
            const editDiff = this._computeLineDiff(content, proposedLF);

            let editResult: { granted: boolean; editedContent?: string };
            if (this._allowAllWrites) {
                editResult = { granted: true };
            } else {
                const permId = nodeCrypto.randomBytes(8).toString('hex');
                editResult = await new Promise<{ granted: boolean; editedContent?: string }>((resolve) => {
                    this._pendingWritePermissions.set(permId, resolve);
                    this._post({ type: 'writePermissionRequest', id: msgId, permId, filepath: tool.filepath, preview: '', diff: editDiff, editableContent: tool.newStr });
                });
            }
            if (!editResult.granted) {
                this._post({ type: 'toolResult', id: msgId, tool: 'edit_file', label: tool.filepath, success: false, error: 'Denied' });
                return `[edit_file: ${tool.filepath}] Denied by user`;
            }

            // Approval can take a while: if the file changed meanwhile (the user edited it),
            // apply the edit to the current content, or stop rather than overwrite those changes
            const nowBytes = await readCurrentBytes(fileUri);
            const nowRaw = nowBytes === null ? null : new TextDecoder().decode(nowBytes);
            if (nowRaw !== rawContent) {
                const nowContent = nowRaw?.replace(/\r\n/g, '\n') ?? '';
                const rematch = nowRaw === null ? null : resolveEditMatch(nowContent, tool.oldStr).match;
                if (!rematch) {
                    this._post({ type: 'toolResult', id: msgId, tool: 'edit_file', label: tool.filepath, success: false, error: 'File changed while waiting for approval' });
                    return `[edit_file: ${tool.filepath}] Not applied: the file changed while waiting for approval (probably edited by the user) and old_str no longer matches. Read it again and redo the edit on its current content.`;
                }
                rawContent = nowRaw!;
                hasCRLF = rawContent.includes('\r\n');
                content = nowContent;
                editMatch = rematch;
            }

            const effectiveNewStr = editResult.editedContent ?? tool.newStr;
            const newContentLF = applyEditMatch(content, editMatch, effectiveNewStr);
            // Recomputed when the user edited the replacement or the file changed during approval
            const finalEditDiff = this._computeLineDiff(content, newContentLF);
            const newContent = hasCRLF ? newContentLF.replace(/(?<!\r)\n/g, '\r\n') : newContentLF;
            const before = new TextEncoder().encode(rawContent);
            const after = new TextEncoder().encode(newContent);
            await writeCurrentBytes(fileUri, after);
            await revealFile(fileUri);

            this._undoRedo.push({ filepath: tool.filepath, uri: fileUri, before, after, label: `edit_file ${tool.filepath}` });
            this._post({ type: 'undoRedoState', ...this._undoRedo.state });
            this._post({ type: 'toolResult', id: msgId, tool: 'edit_file', label: tool.filepath, success: true, diff: finalEditDiff });
            this._filesWrittenThisTurn++;

            // Return a context window around the edited region so the model can
            // confirm the result without issuing a follow-up read_file call.
            const editedLines = newContentLF.split('\n');
            const insertedLines = effectiveNewStr.split('\n');
            const linesBefore = newContentLF.slice(0, editMatch.start).split('\n').length - 1;
            // Enough around the edit for the next nearby edit without reading the file again
            const CONTEXT = 10;
            const from = Math.max(0, linesBefore - CONTEXT);
            const to   = Math.min(editedLines.length, linesBefore + insertedLines.length + CONTEXT);
            const snippet = editedLines.slice(from, to).join('\n');
            const invariantAudit = buildLocalInvariantAudit(newContentLF, effectiveNewStr);
            const matchNote = editMatch.mode === 'exact' ? '' : ` (${editMatch.mode} unique match)`;
            return `[edit_file: ${tool.filepath}] Edit applied successfully${matchNote}.\nResult (lines ${from + 1}–${to}):\n\`\`\`\n${snippet}\n\`\`\`${invariantAudit}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'edit_file', label: tool.filepath, success: false, error: message });
            return `[edit_file: ${tool.filepath}] ERROR: ${message}`;
        }
    }

    // ── Line diff (LCS-based) ─────────────────────────────────────────────────
    /**
     * Produces a compact unified-style diff string (lines prefixed with +, -, or space).
     * Hunk separators are the literal string '@@'.
     * Input strings are split on '\n'; each side is capped at 500 lines so the
     * O(n×m) LCS stays fast even for large files.
     */
    private _computeLineDiff(before: string, after: string, maxOutputLines = 200): string {
        return computeLineDiff(before, after, maxOutputLines);
    }

    /** Read .codico-instructions.md (or .github/codico-instructions.md) once per session. */
    private async _loadRepoInstructions(): Promise<string | null> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) { return null; }
        const root = folders[0].uri;
        const candidates = [
            vscode.Uri.joinPath(root, '.codico-instructions.md'),
            vscode.Uri.joinPath(root, '.github', 'codico-instructions.md'),
            vscode.Uri.joinPath(root, '.github', 'copilot-instructions.md'),
        ];
        const parts: string[] = [];
        for (const uri of candidates) {
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                parts.push(new TextDecoder().decode(bytes).trim());
            } catch {
                // file doesn't exist — try next
            }
        }
        return parts.length > 0 ? parts.join('\n\n') : null;
    }

    private async _handleContextRequest(kind: 'file' | 'selection' | 'diagnostics' | 'files-pick'): Promise<void> {
        switch (kind) {
            case 'file': {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    this._post({ type: 'contextSnippet', kind: 'file', label: 'No active file', text: '' });
                    return;
                }
                const relPath = vscode.workspace.asRelativePath(editor.document.uri);
                const rawText = editor.document.getText();
                const text = `File: ${relPath}\n\`\`\`${editor.document.languageId}\n${rawText.slice(0, 20_000)}\n\`\`\`${rawText.length > 20_000 ? '\n… (truncated)' : ''}`;
                this._post({ type: 'contextSnippet', kind: 'file', label: relPath, text });
                break;
            }
            case 'selection': {
                const editor = vscode.window.activeTextEditor;
                if (!editor || editor.selection.isEmpty) {
                    this._post({ type: 'contextSnippet', kind: 'selection', label: 'No selection', text: '' });
                    return;
                }
                const relPath = vscode.workspace.asRelativePath(editor.document.uri);
                const selText = editor.document.getText(editor.selection);
                const { start, end } = editor.selection;
                const text = `Selection from ${relPath} (lines ${start.line + 1}–${end.line + 1}):\n\`\`\`${editor.document.languageId}\n${selText}\n\`\`\``;
                this._post({ type: 'contextSnippet', kind: 'selection', label: `${relPath}:${start.line + 1}-${end.line + 1}`, text });
                break;
            }
            case 'diagnostics': {
                const allDiags = vscode.languages.getDiagnostics();
                const lines: string[] = [];
                let count = 0;
                for (const [uri, diags] of allDiags) {
                    const relPath = vscode.workspace.asRelativePath(uri);
                    for (const d of diags) {
                        if (d.severity > vscode.DiagnosticSeverity.Warning) { continue; }
                        if (count >= 30) { lines.push('…'); break; }
                        const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARNING';
                        lines.push(`${relPath}:${d.range.start.line + 1}: ${sev}: ${d.message}`);
                        count++;
                    }
                    if (count >= 30) { break; }
                }
                const text = lines.length > 0
                    ? `Workspace diagnostics:\n${lines.join('\n')}`
                    : 'No errors or warnings in workspace.';
                this._post({ type: 'contextSnippet', kind: 'diagnostics', label: `${count} issue(s)`, text });
                break;
            }
            case 'files-pick': {
                const folders = vscode.workspace.workspaceFolders;
                if (!folders || folders.length === 0) { return; }
                const allFiles = await vscode.workspace.findFiles(
                    '**/*',
                    '{**/node_modules/**,**/.git/**,**/out/**,**/.vscode/**}',
                    800
                );
                const items = allFiles
                    .map(uri => ({ label: vscode.workspace.asRelativePath(uri), uri }))
                    .sort((a, b) => a.label.localeCompare(b.label));
                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select files to attach as context (Space to select, Enter to confirm)',
                    canPickMany: true,
                    matchOnDescription: true,
                });
                if (!selected || selected.length === 0) { return; }
                for (const item of selected) {
                    try {
                        const bytes = await vscode.workspace.fs.readFile(item.uri);
                        const rawText = new TextDecoder().decode(bytes);
                        let lang = 'text';
                        try {
                            const doc = await vscode.workspace.openTextDocument(item.uri);
                            lang = doc.languageId;
                        } catch { /* binary or unopenable */ }
                        const snippet = rawText.slice(0, 20_000);
                        const truncated = rawText.length > 20_000 ? '\n… (truncated at 20 000 chars)' : '';
                        const text = `File: ${item.label}\n\`\`\`${lang}\n${snippet}\n\`\`\`${truncated}`;
                        this._post({ type: 'contextSnippet', kind: 'file', label: item.label, text });
                    } catch {
                        // skip unreadable / binary files
                    }
                }
                break;
            }
        }
    }

    // ─── Code Review ─────────────────────────────────────────────────────────

    private async _handleRunAndFixTests(): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.length) {
            this._post({ type: 'error', message: 'No workspace folder open.' });
            return;
        }

        const detected = detectTestCommand(folders[0].uri.fsPath);

        const confirmed = await vscode.window.showInputBox({
            title: 'Codico: Run & Fix Tests',
            prompt: detected
                ? 'Detected test command — edit if needed or press Enter to confirm'
                : 'No test runner detected — enter the command to run your tests',
            value: detected ?? '',
            placeHolder: 'e.g. npm test, pytest, go test ./...',
            ignoreFocusOut: true,
        });

        if (!confirmed?.trim()) { return; }
        await this.sendMessage(buildTestLoopPrompt(confirmed.trim()));
    }

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

    private async _handleReview(target: 'file' | 'selection'): Promise<void> {
        if (!this._view) { return; }

        const editor = vscode.window.activeTextEditor;
        let codeContext = '';
        let displayLabel = '';

        if (target === 'selection') {
            if (!editor || editor.selection.isEmpty) {
                this._post({ type: 'reviewReady', label: '', error: 'No text selected. Select code first then click Review.' });
                return;
            }
            const relPath = vscode.workspace.asRelativePath(editor.document.uri);
            const { start, end } = editor.selection;
            displayLabel = `${relPath}:${start.line + 1}-${end.line + 1}`;
            const selText = editor.document.getText(editor.selection);
            codeContext = `Selection from ${displayLabel}:\n\`\`\`${editor.document.languageId}\n${selText}\n\`\`\``;
        } else {
            if (!editor) {
                this._post({ type: 'reviewReady', label: '', error: 'No active file open. Open a file and try again.' });
                return;
            }
            const relPath = vscode.workspace.asRelativePath(editor.document.uri);
            displayLabel = relPath;
            const rawText = editor.document.getText();
            const snippet = rawText.slice(0, 24_000);
            const truncated = rawText.length > 24_000 ? '\n… (truncated at 24 000 chars)' : '';
            codeContext = `File: ${relPath}\n\`\`\`${editor.document.languageId}\n${snippet}\n\`\`\`${truncated}`;
        }

        this._post({ type: 'reviewReady', label: displayLabel, error: undefined });

        const reviewMessage = `${codeContext}\n\n${REVIEW_PROMPT}`;
        await this._handleUserMessage(reviewMessage);
    }

    // ─── Thread management ───────────────────────────────────────────────────

    private _initThreadsSync(): void {
        const store = this._store;
        let threads = store.get<ThreadEntry[]>(this._threadsIndexKey, []);

        if (threads.length === 0) {
            // First launch: migrate old history or create fresh thread
            const oldWs = store.get<ChatMessage[]>('codico.history', []);
            const oldGlobal = store.get<ChatMessage[]>('codico.history.global', []);
            const oldHistory = oldWs.length > 0 ? oldWs : oldGlobal;
            const thread: ThreadEntry = {
                id: this._newId(),
                name: oldHistory.length > 0 ? 'Previous Chat' : 'New Chat',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                messageCount: oldHistory.length,
                preview: '',
            };
            threads = [thread];
            void store.update(this._threadsIndexKey, threads);
            void store.update(this._activeThreadIdKey, thread.id);
            void store.update(this._threadKey(thread.id), oldHistory);
            void store.update(this._threadDisplayKey(thread.id), []);
            // Remove old flat-history keys
            if (oldWs.length > 0) { void store.update('codico.history', undefined); }
            if (oldGlobal.length > 0) { void store.update('codico.history.global', undefined); }
            this._activeThreadId = thread.id;
            this._history = oldHistory;
            this._displayMessages = [];
        } else {
            const activeId = store.get<string>(this._activeThreadIdKey, threads[0].id);
            this._activeThreadId = threads.some(t => t.id === activeId) ? activeId : threads[0].id;
            this._history = store.get<ChatMessage[]>(this._threadKey(this._activeThreadId), []);
            this._displayMessages = store.get<DisplayMessage[]>(this._threadDisplayKey(this._activeThreadId), []);
        }
    }

    private _postUiSettings(): void {
        const cfg = vscode.workspace.getConfiguration('codico');
        this._post({ type: 'uiSettings', density: cfg.get<'comfortable' | 'compact'>('chatDensity', 'comfortable'), showReasoning: cfg.get<boolean>('showReasoning', true) });
    }

    private _getThreadListForWebview(): Array<ThreadEntry & { active: boolean }> {
        // Pinned first, then the most recently used
        return this._store.get<ThreadEntry[]>(this._threadsIndexKey, [])
            .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)
            .map(t => ({ ...t, active: t.id === this._activeThreadId }));
    }

    /** @param usage a finished task's tokens and cost, added to the thread's totals */
    private async _updateThreadMeta(userText: string, usage?: TaskUsage): Promise<void> {
        const store = this._store;
        const threads = store.get<ThreadEntry[]>(this._threadsIndexKey, []);
        const idx = threads.findIndex(t => t.id === this._activeThreadId);
        if (idx === -1) { return; }
        const userDisplayCount = this._displayMessages.filter(m => m.role === 'user').length;
        // Auto-name from first user message if this thread has never been explicitly named
        let name = threads[idx].name;
        let hasBeenNamed = threads[idx].hasBeenNamed ?? false;
        const isDefaultName = !hasBeenNamed && (
            name === 'New Chat' || name === 'New Session' || name === 'Previous Chat' || /^Thread \d+$/.test(name)
        );
        if (isDefaultName && userText.trim().length > 0) {
            const cleaned = userText.replace(/\n/g, ' ').trim();
            name = cleaned.length > 60 ? cleaned.slice(0, 60) + '\u2026' : cleaned;
            hasBeenNamed = true;
        }
        threads[idx] = {
            ...threads[idx],
            name,
            hasBeenNamed,
            updatedAt: Date.now(),
            messageCount: userDisplayCount,
            preview: userText.slice(0, 80).replace(/\n/g, ' '),
            tokens: (threads[idx].tokens ?? 0) + (usage?.tokens ?? 0),
            costUsd: usage?.costUsd !== undefined ? (threads[idx].costUsd ?? 0) + usage.costUsd : threads[idx].costUsd,
        };
        await store.update(this._threadsIndexKey, threads);
    }

    private async _createThread(name?: string): Promise<void> {
        // Save current thread first
        await this._store.update(this._threadKey(this._activeThreadId), this._history);
        await this._store.update(this._threadDisplayKey(this._activeThreadId), this._displayMessages);

        const threads = this._store.get<ThreadEntry[]>(this._threadsIndexKey, []);
        const threadName = name?.trim() || `Thread ${threads.length + 1}`;
        const thread: ThreadEntry = {
            id: this._newId(),
            name: threadName,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageCount: 0,
            preview: '',
        };
        threads.push(thread);
        await this._store.update(this._threadsIndexKey, threads);
        await this._store.update(this._activeThreadIdKey, thread.id);
        await this._store.update(this._threadKey(thread.id), []);
        await this._store.update(this._threadDisplayKey(thread.id), []);

        this._activeThreadId = thread.id;
        this._history = [];
        this._displayMessages = [];
        this._post({ type: 'threadLoaded', id: thread.id, name: thread.name, displayMessages: [] });
        this._post({ type: 'threadList', threads: this._getThreadListForWebview() });
    }

    private async _switchThread(id: string): Promise<void> {
        if (id === this._activeThreadId) { return; }
        const threads = this._store.get<ThreadEntry[]>(this._threadsIndexKey, []);
        const target = threads.find(t => t.id === id);
        if (!target) { return; }
        // Discard any pending proposals from the outgoing thread
        if (this._editsMode) {
            this._editsMode = false;
            this._editProposals.rejectAll();
            this._post({ type: 'allProposalsResolved' });
        }
        // Save current
        await this._store.update(this._threadKey(this._activeThreadId), this._history);
        await this._store.update(this._threadDisplayKey(this._activeThreadId), this._displayMessages);
        // Load target
        this._activeThreadId = id;
        this._history = this._store.get<ChatMessage[]>(this._threadKey(id), []);
        this._displayMessages = this._store.get<DisplayMessage[]>(this._threadDisplayKey(id), []);
        await this._store.update(this._activeThreadIdKey, id);
        this._post({ type: 'threadLoaded', id, name: target.name, displayMessages: this._displayMessages });
        this._post({ type: 'threadList', threads: this._getThreadListForWebview() });
    }

    private async _renameThread(id: string, name: string): Promise<void> {
        const store = this._store;
        const threads = store.get<ThreadEntry[]>(this._threadsIndexKey, []);
        const idx = threads.findIndex(t => t.id === id);
        if (idx === -1) { return; }
        threads[idx] = { ...threads[idx], name, hasBeenNamed: true };
        await store.update(this._threadsIndexKey, threads);
        this._post({ type: 'threadList', threads: this._getThreadListForWebview() });
    }

    private async _deleteThread(id: string): Promise<void> {
        const store = this._store;
        let threads = store.get<ThreadEntry[]>(this._threadsIndexKey, []);
        if (threads.length <= 1) {
            // Clear instead of delete — can't remove last thread; reset to a fresh session
            this._history = [];
            this._displayMessages = [];
            threads[0] = { ...threads[0], name: 'New Session', hasBeenNamed: false, messageCount: 0, preview: '', updatedAt: Date.now() };
            await store.update(this._threadsIndexKey, threads);
            await store.update(this._threadKey(id), []);
            await store.update(this._threadDisplayKey(id), []);
            this._post({ type: 'threadLoaded', id, name: 'New Session', displayMessages: [] });
            this._post({ type: 'threadList', threads: this._getThreadListForWebview() });
            return;
        }
        threads = threads.filter(t => t.id !== id);
        await store.update(this._threadsIndexKey, threads);
        await store.update(this._threadKey(id), undefined);
        await store.update(this._threadDisplayKey(id), undefined);
        // If deleted thread was active, switch to most recent remaining thread
        if (id === this._activeThreadId) {
            const next = threads.sort((a, b) => b.updatedAt - a.updatedAt)[0];
            this._activeThreadId = next.id;
            this._history = store.get<ChatMessage[]>(this._threadKey(next.id), []);
            this._displayMessages = store.get<DisplayMessage[]>(this._threadDisplayKey(next.id), []);
            await store.update(this._activeThreadIdKey, next.id);
            this._post({ type: 'threadLoaded', id: next.id, name: next.name, displayMessages: this._displayMessages });
        }
        this._post({ type: 'threadList', threads: this._getThreadListForWebview() });
    }

    private async _handleThreadContextMenu(id: string): Promise<void> {
        const threads = this._store.get<ThreadEntry[]>(this._threadsIndexKey, []);
        const thread = threads.find(t => t.id === id);
        if (!thread) { return; }
        // Show inline context menu in the webview (no VS Code modal)
        this._post({ type: 'threadContextMenuRequest', id, name: thread.name });
    }

    private _searchThreads(query: string): Array<{ threadId: string; threadName: string; snippets: Array<{ role: string; snippet: string }> }> {
        const q = query.trim().toLowerCase();
        if (!q) { return []; }
        const threads = this._store.get<ThreadEntry[]>(this._threadsIndexKey, []);
        const results: Array<{ threadId: string; threadName: string; snippets: Array<{ role: string; snippet: string }> }> = [];

        for (const thread of threads) {
            const displayMsgs = this._store.get<DisplayMessage[]>(this._threadDisplayKey(thread.id), []);
            const snippets: Array<{ role: string; snippet: string }> = [];

            for (const msg of displayMsgs) {
                const lower = msg.text.toLowerCase();
                let pos = lower.indexOf(q);
                while (pos !== -1 && snippets.length < 3) {
                    const start = Math.max(0, pos - 60);
                    const end = Math.min(msg.text.length, pos + q.length + 80);
                    const prefix = start > 0 ? '\u2026' : '';
                    const suffix = end < msg.text.length ? '\u2026' : '';
                    snippets.push({ role: msg.role, snippet: prefix + msg.text.slice(start, end) + suffix });
                    pos = lower.indexOf(q, pos + 1);
                }
                if (snippets.length >= 3) { break; }
            }

            // Also match on thread name
            const nameMatch = thread.name.toLowerCase().includes(q);
            if (snippets.length > 0 || nameMatch) {
                results.push({ threadId: thread.id, threadName: thread.name, snippets });
            }
        }

        return results;
    }

    private _post(msg: ExtensionMessage): void {
        this._view?.webview.postMessage(msg);
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

    private _postSelectionBadge(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
            this._post({ type: 'selectionBadge', label: '' });
            return;
        }
        const sel = editor.selection;
        const relPath = vscode.workspace.asRelativePath(editor.document.uri);
        this._post({ type: 'selectionBadge', label: `${relPath}:${sel.start.line + 1}–${sel.end.line + 1}` });
    }

    public focusInput(): void {
        void vscode.commands.executeCommand('workbench.view.extension.codico-container').then(() => {
            this._post({ type: 'focusInput' });
        });
    }

    // ─── HTML ────────────────────────────────────────────────────────────────



}


