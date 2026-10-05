import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as nodeCrypto from 'crypto';
import { streamOpenRouter, ChatMessage, MessageContentPart, CHAT_SYSTEM_PROMPT } from './openRouterClient';
import { streamOllama, ollamaChatCompletion } from './ollamaClient';
import { streamDirect, directSingleCompletion, parseDirectModelId, directSecretKey, getDirectProvider } from './directProviderClient';
import { parseToolBody, scanToolFences, toolFingerprint, ToolCall, WriteFileTool, ReadFileTool, ListDirectoryTool, RunTerminalTool, SearchFilesTool, FindFilesTool, EditFileTool, GetDiagnosticsTool, FetchUrlTool, BrowserNavigateTool, BrowserClickTool, BrowserTypeTool, BrowserGetTextTool, McpCallTool, LspSymbolTool, DebugGetVariablesTool } from './toolParser';
import { FileManager } from './fileManager';
import { BrowserManager } from './browserManager';
import { parseAgentMention, buildAgentContext } from './agentRouter';
import { McpManager, McpServerConfig, loadMcpConfigs } from './mcpManager';
import { WorkspaceIndex } from './workspaceIndex';
import { buildSymbolContext, resolveSymbol } from './symbolProvider';
import { buildPrContext } from './prContextProvider';
import { detectTestCommand, buildTestLoopPrompt } from './testOrchestrator';
import { UndoRedoStack } from './undoRedoStack';
import { EditProposalManager } from './editProposalManager';
import { runGit, fetchCommitMessage } from './commitMessageProvider';
import { isRecoverableStreamInterruption, isUnfulfilledActionAnnouncement, normalizeFinishReason, repeatedPrefixLength, RESUME_OVERLAP_WINDOW } from './streamCompletion';
import { fetchPublicText } from './urlFetcher';
import { getNativeToolDefinitions, nativeToolCallToToolCall } from './nativeTools';

function getNonce(): string {
    return nodeCrypto.randomBytes(24).toString('base64url');
}

// ─── Workspace diagnostics helpers (module-level, no class dependency) ────────

/**
 * Count errors and warnings across the entire workspace.
 */
function _countDiagnostics(): { errorCount: number; warningCount: number } {
    let errorCount = 0;
    let warningCount = 0;
    for (const [, diags] of vscode.languages.getDiagnostics()) {
        for (const d of diags) {
            if (d.severity === vscode.DiagnosticSeverity.Error) { errorCount++; }
            else if (d.severity === vscode.DiagnosticSeverity.Warning) { warningCount++; }
        }
    }
    return { errorCount, warningCount };
}

/**
 * Build a compact, token-efficient summary of all workspace diagnostics
 * (errors first, then warnings). Returns null when the workspace is clean.
 *
 * - Capped at 60 entries to avoid prompt bloat.
 * - Groups by relative file path for readability.
 */
function _buildWorkspaceDiagnosticsSummary(): string | null {
    const CAP = 60;
    type Entry = { rel: string; line: number; sev: 'ERROR' | 'WARNING'; msg: string; source?: string };
    const entries: Entry[] = [];

    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
        const rel = vscode.workspace.asRelativePath(uri);
        for (const d of diags) {
            if (d.severity !== vscode.DiagnosticSeverity.Error &&
                d.severity !== vscode.DiagnosticSeverity.Warning) {
                continue;
            }
            entries.push({
                rel,
                line: d.range.start.line + 1,
                sev: d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARNING',
                msg: d.message.replace(/\n/g, ' ').slice(0, 200),
                source: d.source ?? undefined,
            });
            if (entries.length >= CAP) { break; }
        }
        if (entries.length >= CAP) { break; }
    }

    if (entries.length === 0) { return null; }

    // Errors first, then warnings; within each group sort by file then line
    entries.sort((a, b) => {
        if (a.sev !== b.sev) { return a.sev === 'ERROR' ? -1 : 1; }
        if (a.rel !== b.rel) { return a.rel.localeCompare(b.rel); }
        return a.line - b.line;
    });

    const errorCount = entries.filter(e => e.sev === 'ERROR').length;
    const warnCount = entries.length - errorCount;
    const truncated = entries.length >= CAP;

    const lines = entries.map(e => {
        const src = e.source ? `[${e.source}] ` : '';
        return `${e.sev}  ${e.rel}:${e.line}  ${src}${e.msg}`;
    });
    if (truncated) { lines.push(`… (capped at ${CAP} — run get_diagnostics for the full list)`); }

    const header = `Workspace Problems panel (${errorCount} error${errorCount !== 1 ? 's' : ''}, ${warnCount} warning${warnCount !== 1 ? 's' : ''}):`;
    return `${header}\n${lines.join('\n')}`;
}

// ─── Thread data types ────────────────────────────────────────────────────────

interface ThreadEntry {
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    preview: string;
    hasBeenNamed?: boolean;
}

/** A webview event recorded while an assistant reply streamed, without its message id. */
type ReplayEvent = { type: string; text?: string; diff?: string; [key: string]: unknown };

interface DisplayMessage {
    role: 'user' | 'assistant';
    /** Plain-text summary, used for search and for threads saved before events were recorded. */
    text: string;
    /** Events that rebuild the full reply (text, reasoning, tool steps, terminal output). */
    events?: ReplayEvent[];
}

/** Events replayed to rebuild a reply when a thread is reopened. Interactive ones are excluded. */
const REPLAY_TYPES = new Set([
    'appendThinking', 'appendContent', 'toolStart', 'toolResult', 'fileWriteResult',
    'terminalChunk', 'todoUpdate', 'streamFinishReason', 'streamError',
]);
/** Approximate characters of streamed text stored per reply. */
const REPLAY_BUDGET = 400_000;
const REPLAY_DIFF_LIMIT = 20_000;

export class AgentProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'codico.chatView';

    /** Expose the index so extension.ts can register commands against it. */
    public get workspaceIndex(): WorkspaceIndex { return this._workspaceIndex; }
    /** Expose undo/redo stack so extension.ts can register commands against it. */
    public get undoRedo(): UndoRedoStack { return this._undoRedo; }
    /** Called by extension deactivate() to cleanly shut down the browser process. */
    public async closeBrowser(): Promise<void> { await this._browser.close(); }

    private _view?: vscode.WebviewView;
    private readonly _fileManager = new FileManager();
    private readonly _browser = new BrowserManager();
    private readonly _mcp = new McpManager();
    private readonly _undoRedo = new UndoRedoStack();
    private readonly _editProposals = new EditProposalManager();
    private _editsMode = false;
    private _chatMode = false;
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
    private _thinkingEffort: 'high' | 'medium' | 'low' = 'high';
    private _repoInstructions: string | null | undefined = undefined; // undefined = not yet read
    /** Pending inline write-permission requests: permId → resolve fn */
    private _pendingWritePermissions = new Map<string, (result: { granted: boolean; editedContent?: string }) => void>();
    /** Resolves the pending step checkpoint: true = keep going, false = stop. */
    private _checkpointResolver: ((keepGoing: boolean) => void) | null = null;
    /** Process groups left running by run_terminal commands (POSIX only), keyed by pgid. */
    private readonly _bgProcesses = new Map<number, { command: string; startedAt: number }>();
    private _bgPollTimer: ReturnType<typeof setInterval> | undefined;
    /** Pending inline terminal-permission requests: permId → resolve fn */
    private _pendingTerminalPermissions = new Map<string, (granted: boolean) => void>();
    /** Set to true by "Allow All" for the current agent response; resets each user turn. */
    private _allowAllWrites = false;
    private _allowAllTerminal = false;
    /** External/MCP side effects approved for the current user turn only. */
    private _allowAllExternal = false;
    /** Auto-commit: when true, stage+commit all changes after each agent turn */
    private _autoCommit = false;
    /** Count of files actually written/edited during the current agent turn */
    private _filesWrittenThisTurn = 0;
    /** Stores the result of the most recently dispatched inline tool */
    private _lastInlineResult: string | undefined = undefined;
    /** Whether auto-compact is enabled for this session (toggled via chat UI). */
    private _autoCompact = true;
    /** Prompt token count from the most recent API response; used for auto-compact threshold. */
    private _lastPromptTokens = 0;

    /** Allowlist of valid model IDs sourced from models.json at build time. */
    private _validModelIds: Set<string> | null = null;
    /** Raw models.json content cached for injection into the webview HTML. */
    private _cachedModelsJson: string | null = null;
    /** Rendered chat.html template cached so _buildHtml never blocks the UI thread. */
    private _cachedHtml: string | null = null;

    // Cancelled on extension deactivation — passed to long-running directSingleCompletion calls
    // in fire-and-forget methods (_runAutoCommit, _compactHistory) that have no other cancel path.
    private readonly _sessionAbort = new AbortController();

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        this._workspaceIndex = new WorkspaceIndex(_context);
        this._editProposals.register(_context);
        this._initThreadsSync();
        // Pre-load bundled media files async so _buildHtml and _isValidModelId
        // never need to call readFileSync on the extension host's UI thread.
        void this._preloadMediaFiles();
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
        }, undefined, _context.subscriptions);
    }

    private async _preloadMediaFiles(): Promise<void> {
        const media = this._extensionUri.fsPath + '/media';
        try {
            this._cachedModelsJson = await fs.promises.readFile(media + '/models.json', 'utf8');
            const groups = JSON.parse(this._cachedModelsJson) as Array<{
                models?: Array<{ id?: string }>;
            }>;
            this._validModelIds = new Set(
                groups
                    .flatMap(group => group.models ?? [])
                    .map(model => model.id)
                    .filter((id): id is string => Boolean(id))
            );
        } catch { /* models.json missing — _validModelIds stays null → skip validation */ }
        try {
            this._cachedHtml = await fs.promises.readFile(media + '/chat.html', 'utf8');
        } catch { /* chat.html missing — _buildHtml falls back to sync read */ }
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

        webviewView.webview.html = this._buildHtml(webviewView.webview);

        // Inform the webview of the currently configured model
        const currentModel = vscode.workspace
            .getConfiguration('codico')
            .get<string>('model', 'deepseek/deepseek-v4-flash');
        setTimeout(() => {
            this._post({ type: 'setModel', model: currentModel });
            this._post({ type: 'setEffort', effort: this._thinkingEffort });
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
                const { errorCount, warningCount } = _countDiagnostics();
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

        webviewView.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
            try {
            switch (msg.type) {
                case 'sendMessage':
                    await this._handleUserMessage(msg.text, msg.contentParts as MessageContentPart[] | undefined, msg.injectActiveDiagnostics);
                    break;
                case 'clearChat':
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
                    // Resolve all pending permission dialogs as denied so their Promises unblock
                    for (const resolve of this._pendingWritePermissions.values()) { resolve({ granted: false }); }
                    this._pendingWritePermissions.clear();
                    for (const resolve of this._pendingTerminalPermissions.values()) { resolve(false); }
                    this._pendingTerminalPermissions.clear();
                    this._allowAllWrites = false;
                    this._allowAllTerminal = false;
                    this._allowAllExternal = false;
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
                    if (!this._isValidModelId(msg.model)) {
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
                case 'approvePlan':
                    await this._handleUserMessage(msg.executionPrompt);
                    break;
                case 'clarifyResponse':
                    await this._handleUserMessage(msg.text);
                    break;
                case 'refreshMcp':
                    this._mcpReady = false;
                    this._mcp.disconnectAll();
                    await this._connectMcpServers();
                    break;
                case 'undo': {
                    const fp = await this._undoRedo.undo();
                    if (fp) {
                        vscode.window.showInformationMessage(`Codico: undid changes to ${fp}`);
                    } else {
                        vscode.window.showInformationMessage('Codico: nothing to undo');
                    }
                    this._post({ type: 'undoRedoState', ...this._undoRedo.state });
                    break;
                }
                case 'redo': {
                    const fp = await this._undoRedo.redo();
                    if (fp) {
                        vscode.window.showInformationMessage(`Codico: redid changes to ${fp}`);
                    } else {
                        vscode.window.showInformationMessage('Codico: nothing to redo');
                    }
                    this._post({ type: 'undoRedoState', ...this._undoRedo.state });
                    break;
                }
                case 'toggleEditsMode':
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
                    await this._editProposals.applyOne(msg.filepath, (before, after, fp, label) => {
                        this._undoRedo.push({ filepath: fp, before, after, label });
                    });
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
                    await this._editProposals.applyAll((before, after, fp, label) => {
                        this._undoRedo.push({ filepath: fp, before, after, label });
                    });
                    this._post({ type: 'undoRedoState', ...this._undoRedo.state });
                    this._post({ type: 'allProposalsResolved' });
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
                    await this._createThread(msg.name);
                    break;
                case 'switchThread':
                    await this._switchThread(msg.id);
                    break;
                case 'renameThread':
                    await this._renameThread(msg.id, msg.name);
                    break;
                case 'deleteThread':
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
                        void this._resumeInterruptedSession();
                    }
                    break;
                }
                case 'compactChat': {
                    if (this._busy) { break; }
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
                    this._busy = true;
                    try {
                        await this._compactHistory(compactApiKey, compactModel, isCompactOllama, compactOllamaBaseUrl, compactOllamaModel, isCompactDirect, compactDirectKey, compactDirectParsed?.providerId ?? '', compactDirectParsed?.modelId ?? '');
                    } finally {
                        this._busy = false;
                    }
                    break;
                }
                case 'toggleAutoCompact':
                    this._autoCompact = msg.enabled;
                    break;
                case 'toggleChatMode':
                    this._chatMode = msg.chatMode;
                    break;
            }
            } catch (err: unknown) {
                // Prevent unhandled promise rejections from silently killing the handler.
                // If _busy was set before the error escaped, clear it so the UI isn't locked.
                if (this._busy) {
                    this._busy = false;
                    this._post({ type: 'endMessage', id: '' });
                }
                const message = err instanceof Error ? err.message : String(err);
                this._post({ type: 'error', message });
            }
        });
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
                    detail: `Command: ${cfg.command} ${(cfg.args ?? []).join(' ')}\n\nOnly allow MCP servers you trust. They run as local processes and inherit your environment.`,
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
        for (const msg of this._history) {
            if (msg.role !== 'user') { continue; }
            const content = typeof msg.content === 'string'
                ? msg.content
                : (msg.content as MessageContentPart[])
                    .filter(p => p.type === 'text')
                    .map(p => (p as { type: 'text'; text: string }).text)
                    .join('');
            if (content.startsWith('[Tool Results]') ||
                content.startsWith('[Context]') ||
                content.startsWith('[Repository Instructions]') ||
                content.startsWith('[Conversation Summary')) {
                continue;
            }
            const preambleEnd = content.lastIndexOf('\n\n');
            const candidate = (preambleEnd > 80 && content.startsWith('[')) ? content.slice(preambleEnd + 2) : content;
            return candidate.replace(/\s+/g, ' ').trim().slice(0, 80);
        }
        return 'previous task';
    }

    private async _resumeInterruptedSession(): Promise<void> {
        if (this._busy || !this._view || !this._isSessionInterrupted()) { return; }
        await this._handleUserMessage(this._getInterruptedTaskSummary(), undefined, false, true);
    }

    private async _handleUserMessage(rawText: string, contentParts?: MessageContentPart[], injectActiveDiagnostics?: boolean, _skipUserPush = false): Promise<void> {
        if (this._busy) { return; }
        this._busy = true;
        const _taskStartMs = Date.now();
        this._filesWrittenThisTurn = 0;
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
        this._allowAllWrites  = false;
        this._allowAllTerminal = false;
        this._allowAllExternal = false;

        // Cancel any ongoing stream
        this._abortController?.abort();

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
        // Pause for confirmation every N steps (0 = never)
        const checkpointSteps = config.get<number>('checkpointSteps', 50);
        const nativeToolCalling = config.get<boolean>('nativeToolCalling', true);

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
            const ctxPreamble = autoInject ? await this._buildContextPreamble() : '';
            const combined = [agentContextBlock, ctxPreamble].filter(Boolean).join('\n\n');
            const textWithCtx = combined ? `${combined}\n\n${text}` : text;
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

        const historyRollbackLen = this._history.length;
        const displayRollbackLen = this._displayMessages.length;

        if (!_skipUserPush) {
            this._history.push({ role: 'user', content: userContent });
            // Track for thread display (resume view when switching threads)
            this._displayMessages.push({ role: 'user', text: rawText.slice(0, 20_000) });
        }

        // Auto-name the thread immediately from the first user message so the sidebar updates right away
        void this._updateThreadMeta(rawText).then(() => {
            this._post({ type: 'threadList', threads: this._getThreadListForWebview() });
        });

        const msgId = Date.now().toString();
        this._post({ type: 'startMessage', id: msgId });
        this._recording = { msgId, events: [], size: 0, truncated: false };

        this._abortController = new AbortController();
        const { signal } = this._abortController;

        // Abort any in-flight follow-up request from the previous message
        this._followUpAbortController?.abort();
        this._followUpAbortController = null;

        const MAX_ITERATIONS = maxIterations > 0 ? maxIterations : Infinity;
        const MAX_STREAM_RECOVERY_ATTEMPTS = 5;
        let streamRecoveryAttempts = 0;
        // Visible text just before a cutoff; the resumed response is checked against it
        // so any restarted sentence is dropped and the seam stays invisible.
        let resumeTail: string | null = null;
        let recoveryStatusShown = false;
        const MAX_ACTION_NUDGES = 2;
        let actionNudges = 0;
        const nativeTools = !isOllama && nativeToolCalling
            ? getNativeToolDefinitions(this._chatMode)
            : [];


        // Circuit breaker: track how many times each unique tool call has been issued
        // across all iterations. If the same call fires 3 times the model is looping —
        // inject a hard nudge into history and stop the current iteration.
        const _toolCallCounts = new Map<string, number>();
        const MAX_IDENTICAL_CALLS = 3;

        try {
            for (let i = 0; i < MAX_ITERATIONS; i++) {
                if (signal.aborted) { break; }
                this._post({ type: 'stepProgress', id: msgId, step: i + 1 });

                let fullContent = '';
                let lastSentPos = 0;    // how far into fullContent we've sent as appendContent
                let dispatchedUpTo = 0; // how far into fullContent we've dispatched tool fences
                const inlineToolResults: string[] = [];
                const nativeToolHistory: string[] = [];
                let recoverableStreamInterruption: string | null = null;
                let recoverableFinishReason: string | null = null;

                let resumeBuffer = '';

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

                const dispatchToolCall = async (tool: ToolCall): Promise<boolean> => {
                    const fp = toolFingerprint(tool);
                    const callCount = (_toolCallCounts.get(fp) ?? 0) + 1;
                    _toolCallCounts.set(fp, callCount);

                    if (callCount > MAX_IDENTICAL_CALLS) {
                        const nudge = `[System] The tool call \`${tool.type}\` with the same arguments has been issued ${callCount} times. You are in a loop. Stop repeating this call. Either the information you need does not exist, or you should try a completely different approach.`;
                        inlineToolResults.push(nudge);
                        this._post({ type: 'appendContent', id: msgId, text: `\n⚠️ Loop detected — same tool call issued ${callCount} times. Stopping repetition.\n` });
                        return false;
                    }

                    await this._dispatchTool(tool, msgId, signal);
                    if (this._lastInlineResult !== undefined) {
                        inlineToolResults.push(this._lastInlineResult);
                        this._lastInlineResult = undefined;
                    }
                    return true;
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
                            const keepGoing = await dispatchToolCall(tools[0]);
                            if (!keepGoing) { return; }
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

                const chatModeOverride = this._chatMode ? CHAT_SYSTEM_PROMPT : undefined;
                for await (const chunk of isOllama
                    ? streamOllama(ollamaBaseUrl, this._history, ollamaModel, effectivePrefix, signal, chatModeOverride)
                    : isDirect && directParsed
                        ? streamDirect(directApiKey, this._history, directParsed.providerId, directParsed.modelId, effectivePrefix, signal, this._thinkingEffort, chatModeOverride, nativeTools)
                        : streamOpenRouter(apiKey, this._history, model, effectivePrefix, signal, this._thinkingEffort, chatModeOverride, nativeTools)) {
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
                        const tool = nativeToolCallToToolCall(chunk.call);
                        if (!tool) {
                            this._post({
                                type: 'streamError',
                                id: msgId,
                                message: `Provider returned invalid arguments for native tool ${chunk.call.name}.`,
                            });
                            continue;
                        }
                        nativeToolHistory.push(tool.type);
                        await dispatchToolCall(tool);
                    } else if (chunk.type === 'usage') {
                        this._lastPromptTokens = chunk.promptTokens;
                        this._post({ type: 'tokenUsage', promptTokens: chunk.promptTokens, completionTokens: chunk.completionTokens, totalTokens: chunk.totalTokens });
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
                        await dispatchToolCall(tools[0]);
                    }
                }

                // Flush any remaining content after stream ends
                if (lastSentPos < fullContent.length) {
                    this._post({ type: 'appendContent', id: msgId, text: fullContent.slice(lastSentPos) });
                }

                if (signal.aborted) {
                    // Avoid leaving history with a trailing 'user' message (from the previous
                    // iteration's tool results) and no assistant reply — _isSessionInterrupted
                    // would treat that as a resumable task on the next session load.
                    if (fullContent.trim() || inlineToolResults.length > 0) {
                        this._history.push({ role: 'assistant', content: fullContent || '(interrupted)' });
                    }
                    break;
                }

                const assistantHistoryContent = fullContent ||
                    (nativeToolHistory.length > 0
                        ? `[Native tool calls executed: ${nativeToolHistory.join(', ')}]`
                        : recoverableStreamInterruption
                            ? '[Stream interrupted before content]'
                            : '[Assistant turn completed without text]');
                this._history.push({
                    role: 'assistant',
                    content: assistantHistoryContent,
                });

                // Unexpected transport EOFs are recoverable: preserve the partial
                // assistant response and any tool results, then ask the model to
                // continue from the exact cutoff point. This avoids replaying tools or
                // discarding useful partial output. Recovery is deliberately bounded.
                if (recoverableStreamInterruption || recoverableFinishReason === 'length') {
                    if (streamRecoveryAttempts < MAX_STREAM_RECOVERY_ATTEMPTS) {
                        streamRecoveryAttempts++;

                        const recoveryParts: string[] = [];
                        if (inlineToolResults.length > 0) {
                            recoveryParts.push(`[Tool Results]\n\n${inlineToolResults.join('\n\n---\n\n')}`);
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

                // ── Mid-stream auto-compact ────────────────────────────────────────
                // Compact between iterations while the agent loop is still running so
                // the stream never terminates due to context overflow. The compact runs
                // silently between the current and next iteration; the UI stays in the
                // streaming state and continues as soon as compaction finishes.
                const autoCompactThresholdMid = config.get<number>('autoCompactThreshold', 100_000);
                if (this._autoCompact && this._lastPromptTokens > autoCompactThresholdMid) {
                    await this._compactHistory(apiKey, model, isOllama, ollamaBaseUrl, ollamaModel, isDirect, directApiKey, directParsed?.providerId ?? '', directParsed?.modelId ?? '');
                }

                // Inject tool results so the AI can continue
                const resultText = `[Tool Results]\n\n${inlineToolResults.join('\n\n---\n\n')}`;
                this._history.push({ role: 'user', content: resultText });

                // Periodic checkpoint so a run that has gone off track does not spend
                // tokens indefinitely. Waits for the user; Stop also ends the wait.
                if (checkpointSteps > 0 && (i + 1) % checkpointSteps === 0 && i < MAX_ITERATIONS - 1) {
                    const keepGoing = await new Promise<boolean>((resolve) => {
                        this._checkpointResolver = resolve;
                        signal.addEventListener('abort', () => resolve(false), { once: true });
                        this._post({ type: 'checkpoint', id: msgId, steps: i + 1 });
                    });
                    this._checkpointResolver = null;
                    if (!keepGoing) { break; }
                }

                // Warn the user when the iteration cap is about to be hit on the last loop
                if (i === MAX_ITERATIONS - 1) {
                    this._post({ type: 'iterationLimit', id: msgId, limit: MAX_ITERATIONS });
                }
            }
        } catch (err: unknown) {
            // Only roll back if no tool calls have completed yet.  If the history already
            // contains assistant replies (length > rollback+1), those iterations wrote files
            // that are now on disk — wiping them from history would make chat state diverge
            // from the file system.  Keep completed history; only trim an orphaned user message.
            if (this._history.length <= historyRollbackLen + 1) {
                this._history.length = historyRollbackLen;
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
                const label = rawText.replace(/\s+/g, ' ').trim().slice(0, 60);
                const action = await vscode.window.showInformationMessage(
                    `Codico finished: "${label}${label.length < rawText.trim().length ? '…' : ''}"`,
                    'Open Chat'
                );
                if (action === 'Open Chat') {
                    await vscode.commands.executeCommand('workbench.view.extension.codico-container');
                }
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
            this._displayMessages.push({ role: 'assistant', text: summaryText, events: recording?.events });
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
        await this._updateThreadMeta(rawText);
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
        const autoCompactThreshold = config.get<number>('autoCompactThreshold', 100_000);
        if (!signal.aborted && this._autoCompact && this._lastPromptTokens > autoCompactThreshold) {
            await this._compactHistory(apiKey, model, isOllama, ollamaBaseUrl, ollamaModel, isDirect, directApiKey, directParsed?.providerId ?? '', directParsed?.modelId ?? '');
        }

        } finally {
            this._busy = false;
        }
    }

    private async _generateFollowUps(msgId: string, apiKey: string, model: string, isOllama: boolean, ollamaBaseUrl: string, ollamaModel: string, signal: AbortSignal, isDirect = false, directKey = '', directProviderId = '', directModelId = ''): Promise<void> {
        try {
            // Take last 6 turns, filtering out injected tool-result messages so the model
            // sees the actual conversation, not raw terminal/file output.
            const recent = this._history.slice(-6).filter(m => {
                if (typeof m.content !== 'string') { return true; }
                return !m.content.startsWith('[Tool Results]');
            });
            if (recent.length === 0) { return; }

            const contextStr = recent.map(m => {
                const text = typeof m.content === 'string'
                    ? m.content.slice(0, 500)
                    : (m.content as { type: string; text?: string }[])
                        .filter(p => p.type === 'text').map(p => p.text ?? '').join('').slice(0, 500);
                return `${m.role}: ${text}`;
            }).join('\n');

            const prompt = `Given this conversation, suggest exactly 3 short, distinct follow-up questions or requests the user might make next. Output ONLY a JSON array of 3 strings. No explanation, no markdown fences.\n\nConversation:\n${contextStr}`;

            let raw = '';
            if (isOllama) {
                raw = await ollamaChatCompletion(
                    ollamaBaseUrl,
                    [{ role: 'user', content: prompt }],
                    ollamaModel,
                    300,
                    signal
                );
            } else if (isDirect) {
                raw = await directSingleCompletion(directKey, directProviderId, directModelId, prompt, 300, signal);
            } else {
                const body = JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 300,
                    temperature: 0.3,
                });

                raw = await new Promise<string>((resolve) => {
                    if (signal.aborted) { resolve(''); return; }
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
                            res.on('data', (c: Buffer) => {
                                totalBytes += c.length;
                                if (totalBytes > 64 * 1024) { res.destroy(); resolve(''); return; }
                                data += c.toString();
                            });
                            res.on('end', () => {
                                try {
                                    resolve(JSON.parse(data)?.choices?.[0]?.message?.content ?? '');
                                } catch { resolve(''); }
                            });
                            res.on('error', () => resolve(''));
                        }
                    );
                    req.setTimeout(15_000, () => { req.destroy(); resolve(''); });
                    signal.addEventListener('abort', () => { req.destroy(); resolve(''); }, { once: true });
                    req.on('error', () => resolve(''));
                    req.write(body);
                    req.end();
                });
            }

            const cleaned = raw.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim();
            let suggestions: string[] = [];
            try {
                const arr = JSON.parse(cleaned);
                if (Array.isArray(arr)) {
                    suggestions = (arr as unknown[]).slice(0, 3).map(String);
                }
            } catch { /* ignore */ }

            if (suggestions.length > 0 && !signal.aborted) {
                this._post({ type: 'followUps', id: msgId, suggestions });
            }
        } catch { /* best-effort */ }
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

    private async _compactHistory(apiKey: string, model: string, isOllama: boolean, ollamaBaseUrl: string, ollamaModel: string, isDirect = false, directKey = '', directProviderId = '', directModelId = ''): Promise<void> {
        if (this._history.length < 4) {
            this._post({ type: 'compactDone', messageCount: 0 });
            return;
        }

        this._post({ type: 'compactStart' });

        // Build flat text of all history for the summariser, capping each message at 3000 chars
        const historyText = this._history.map(m => {
            const content = typeof m.content === 'string'
                ? m.content.slice(0, 3000)
                : (m.content as MessageContentPart[])
                    .filter(p => p.type === 'text')
                    .map(p => (p as { type: 'text'; text: string }).text)
                    .join('')
                    .slice(0, 3000);
            return `### ${m.role.toUpperCase()}\n${content}`;
        }).join('\n\n---\n\n').slice(0, 40000);

        const prompt =
            'You are summarising a coding assistant conversation. Produce a detailed summary preserving:\n' +
            '- All files created, modified, or deleted (with their paths)\n' +
            '- Key decisions, trade-offs, and constraints\n' +
            '- Code patterns, functions, and structures introduced\n' +
            '- Errors encountered and how they were resolved\n' +
            '- The current state of the work and any outstanding tasks\n\n' +
            'Write in past tense. Be comprehensive — the assistant will use this summary to continue working seamlessly.\n\n' +
            'Conversation to summarise:\n\n' + historyText;

        let summary = '';
        try {
            if (isOllama) {
                summary = await ollamaChatCompletion(
                    ollamaBaseUrl,
                    [{ role: 'user', content: prompt }],
                    ollamaModel,
                    1500
                );
            } else if (isDirect) {
                summary = await directSingleCompletion(directKey, directProviderId, directModelId, prompt, 1500, this._sessionAbort.signal);
            } else {
                const body = JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 1500,
                    temperature: 0.1,
                });
                summary = await new Promise<string>((resolve) => {
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
                            res.on('data', (c: Buffer) => {
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
                    req.write(body);
                    req.end();
                });
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'compactError', message });
            return;
        }

        if (!summary.trim()) {
            this._post({ type: 'compactError', message: 'Summary generation returned empty result' });
            return;
        }

        // Keep the last 4 messages (≤ 2 complete turns) for immediate context continuity
        const KEEP = Math.min(4, this._history.length - 1);
        const recentTurns = this._history.slice(-KEEP);

        this._history = [
            { role: 'user', content: `[Conversation Summary]\n\n${summary}` },
            ...recentTurns,
        ];
        this._lastPromptTokens = 0;

        await this._historyStore.update(this._historyKey, this._history);
        this._post({ type: 'compactDone', messageCount: this._history.length - 1 });
    }

    /** Dispatches a single tool call immediately, stores result in _lastInlineResult */
    private async _dispatchTool(tool: ToolCall, msgId: string, signal: AbortSignal): Promise<void> {
        if (signal.aborted) { return; }

        // In chat (Ask) mode, block any tool that modifies the workspace or runs commands
        if (this._chatMode) {
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
                result = await this._handleGetDiagnostics(tool, msgId);
                break;
            }
            case 'fetch_url': {
                this._post({ type: 'toolStart', id: msgId, tool: 'fetch_url', label: tool.url });
                result = await this._handleFetchUrl(tool, msgId);
                break;
            }
            case 'browser_navigate': {
                this._post({ type: 'toolStart', id: msgId, tool: 'browser_navigate', label: tool.url });
                result = await this._handleBrowserNavigate(tool, msgId);
                break;
            }
            case 'browser_click': {
                this._post({ type: 'toolStart', id: msgId, tool: 'browser_click', label: tool.selector });
                result = await this._handleBrowserClick(tool, msgId);
                break;
            }
            case 'browser_type': {
                this._post({ type: 'toolStart', id: msgId, tool: 'browser_type', label: tool.selector });
                result = await this._handleBrowserType(tool, msgId);
                break;
            }
            case 'browser_get_text': {
                this._post({ type: 'toolStart', id: msgId, tool: 'browser_get_text', label: tool.selector ?? 'page' });
                result = await this._handleBrowserGetText(tool, msgId);
                break;
            }
            case 'browser_screenshot': {
                this._post({ type: 'toolStart', id: msgId, tool: 'browser_screenshot', label: 'screenshot' });
                result = await this._handleBrowserScreenshot(msgId);
                break;
            }
            case 'browser_close': {
                this._post({ type: 'toolStart', id: msgId, tool: 'browser_close', label: 'browser' });
                await this._browser.close();
                this._post({ type: 'toolResult', id: msgId, tool: 'browser_close', label: 'Browser closed', success: true });
                result = '[browser_close] Browser closed.';
                break;
            }
            case 'mcp_call': {
                this._post({ type: 'toolStart', id: msgId, tool: 'mcp_call', label: `${tool.server}/${tool.tool}` });
                result = await this._handleMcpCall(tool, msgId);
                break;
            }
            case 'lsp_symbol': {
                this._post({ type: 'toolStart', id: msgId, tool: 'lsp_symbol', label: tool.query });
                result = await this._handleLspSymbol(tool, msgId);
                break;
            }
            case 'debug_get_variables': {
                this._post({ type: 'toolStart', id: msgId, tool: 'debug_get_variables', label: `frame ${tool.frameId ?? 0}` });
                result = await this._handleDebugGetVariables(tool, msgId);
                break;
            }
            case 'debug_get_callstack': {
                this._post({ type: 'toolStart', id: msgId, tool: 'debug_get_callstack', label: 'call stack' });
                result = await this._handleDebugGetCallstack(msgId);
                break;
            }
            case 'debug_list_breakpoints': {
                this._post({ type: 'toolStart', id: msgId, tool: 'debug_list_breakpoints', label: 'breakpoints' });
                result = await this._handleDebugListBreakpoints(msgId);
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
        // ── Edits Mode: queue proposal instead of writing immediately ──────────
        if (this._editsMode) {
            const norm = path.posix.normalize(tool.filepath.replace(/\\/g, '/'));
            if (norm.startsWith('..') || path.isAbsolute(norm)) {
                this._post({ type: 'toolResult', id: msgId, tool: 'write_file', label: tool.filepath, success: false, error: 'Unsafe path rejected' });
                return `[write_file: ${tool.filepath}] ERROR: Unsafe path rejected`;
            }
            let before: Uint8Array | null = null;
            try {
                const folders = vscode.workspace.workspaceFolders;
                if (folders?.length) {
                    before = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folders[0].uri, norm));
                }
            } catch { /* new file */ }
            this._editProposals.queue({ filepath: tool.filepath, originalContent: before, proposedContent: tool.content, label: `write ${tool.filepath}` });
            this._post({ type: 'proposalQueued', filepath: tool.filepath });
            return `[write_file: ${tool.filepath}] Queued as edit proposal`;
        }

        // ── Read existing content once (used for both diff preview and undo) ──
        let beforeBytes: Uint8Array | null = null;
        let beforeText = '';
        try {
            const folders = vscode.workspace.workspaceFolders;
            if (folders?.length) {
                const normalized = path.posix.normalize(tool.filepath.replace(/\\/g, '/'));
                if (!normalized.startsWith('..') && !path.isAbsolute(normalized)) {
                    const uri = vscode.Uri.joinPath(folders[0].uri, normalized);
                    beforeBytes = await vscode.workspace.fs.readFile(uri);
                    beforeText = new TextDecoder().decode(beforeBytes);
                }
            }
        } catch { /* new file — beforeText stays '' */ }

        // Pre-compute diff to show in the permission card preview
        const diff = this._computeLineDiff(beforeText, tool.content);

        let writeResult: { granted: boolean; editedContent?: string } = { granted: false };
        let errorMsg: string | undefined;

        try {
            if (this._allowAllWrites) {
                writeResult = { granted: true };
            } else {
                const permId = nodeCrypto.randomBytes(8).toString('hex');
                writeResult = await new Promise<{ granted: boolean; editedContent?: string }>((resolve) => {
                    this._pendingWritePermissions.set(permId, resolve);
                    this._post({ type: 'writePermissionRequest', id: msgId, permId, filepath: tool.filepath, preview: '', diff, editableContent: tool.content });
                });
            }
            if (writeResult.granted) {
                const contentToWrite = writeResult.editedContent ?? tool.content;
                const finalDiff = writeResult.editedContent ? this._computeLineDiff(beforeText, writeResult.editedContent) : diff;
                await this._fileManager.writeFile(tool.filepath, contentToWrite);

                const after = new TextEncoder().encode(contentToWrite);
                this._undoRedo.push({ filepath: tool.filepath, before: beforeBytes, after, label: `write_file ${tool.filepath}` });
                this._post({ type: 'undoRedoState', ...this._undoRedo.state });
                this._post({ type: 'fileWriteResult', id: msgId, filepath: tool.filepath, granted: true, diff: finalDiff });
                this._filesWrittenThisTurn++;
                const lineCount = contentToWrite.split('\n').length;
                return `[write_file: ${tool.filepath}] Written successfully (${lineCount} lines). File is on disk — no need to read it back to verify.`;
            }
        } catch (err: unknown) {
            errorMsg = err instanceof Error ? err.message : String(err);
        }

        this._post({ type: 'fileWriteResult', id: msgId, filepath: tool.filepath, granted: false, error: errorMsg });
        return `[write_file: ${tool.filepath}] ${errorMsg ? `Error: ${errorMsg}` : 'Denied by user'}`;
    }

    private async _handleReadFile(tool: ReadFileTool, msgId: string): Promise<string> {
        try {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders || folders.length === 0) {
                const err = 'No workspace folder open';
                this._post({ type: 'toolResult', id: msgId, tool: 'read_file', label: tool.filepath, success: false, error: err });
                return `[read_file: ${tool.filepath}] ERROR: ${err}`;
            }
            // Trim whitespace and normalise to posix separators
            let fp = tool.filepath.trim().replace(/\\/g, '/');
            // Strip leading workspace-root prefix that models sometimes emit (e.g. "/src/foo.ts")
            const wsRoot = folders[0].uri.fsPath.replace(/\\/g, '/').replace(/\/$/, '');
            if (fp.startsWith(wsRoot + '/')) {
                fp = fp.slice(wsRoot.length + 1);
            }
            // Strip a leading "/" so "/src/foo.ts" becomes "src/foo.ts"
            fp = fp.replace(/^\/+/, '');
            const normalized = path.posix.normalize(fp || '.');
            if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
                const err = `Unsafe path rejected: ${tool.filepath}`;
                this._post({ type: 'toolResult', id: msgId, tool: 'read_file', label: tool.filepath, success: false, error: err });
                return `[read_file: ${tool.filepath}] ERROR: ${err}`;
            }
            const fileUri = vscode.Uri.joinPath(folders[0].uri, normalized);
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            const content = new TextDecoder().decode(bytes);
            this._post({ type: 'toolResult', id: msgId, tool: 'read_file', label: tool.filepath, success: true });
            return `[read_file: ${tool.filepath}]\n\`\`\`\n${content}\n\`\`\``;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'read_file', label: tool.filepath, success: false, error: message });
            return `[read_file: ${tool.filepath}] ERROR: ${message}`;
        }
    }

    private async _handleListDirectory(tool: ListDirectoryTool, msgId: string): Promise<string> {
        try {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders || folders.length === 0) {
                const err = 'No workspace folder open';
                this._post({ type: 'toolResult', id: msgId, tool: 'list_directory', label: tool.dirpath, success: false, error: err });
                return `[list_directory: ${tool.dirpath}] ERROR: ${err}`;
            }
            const rawPath = tool.dirpath === '.' ? '' : tool.dirpath.replace(/\\/g, '/');
            const normalized = rawPath ? path.posix.normalize(rawPath) : '';
            if (normalized && (normalized.startsWith('..') || path.isAbsolute(normalized))) {
                const err = `Unsafe path rejected: ${tool.dirpath}`;
                this._post({ type: 'toolResult', id: msgId, tool: 'list_directory', label: tool.dirpath, success: false, error: err });
                return `[list_directory: ${tool.dirpath}] ERROR: ${err}`;
            }
            const dirUri = normalized
                ? vscode.Uri.joinPath(folders[0].uri, normalized)
                : folders[0].uri;
            const entries = await vscode.workspace.fs.readDirectory(dirUri);
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

        let granted: boolean;
        if (this._allowAllTerminal) {
            granted = true;
        } else {
            // Request permission inline in the chat (no VS Code modal)
            const permId = nodeCrypto.randomBytes(8).toString('hex');
            granted = await new Promise<boolean>((resolve) => {
                this._pendingTerminalPermissions.set(permId, resolve);
                this._post({ type: 'terminalPermissionRequest', id: msgId, permId, command: tool.command });
            });
        }

        if (!granted) {
            this._post({ type: 'toolResult', id: msgId, tool: 'run_terminal', label: shortCmd, success: false, error: 'Denied' });
            return `[run_terminal] Denied by user:\n${tool.command}`;
        }

        return new Promise<string>((resolve) => {
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const shell = process.platform === 'win32'
                ? (process.env.ComSpec || 'cmd.exe')
                : (process.env.SHELL || '/bin/sh');
            const shellArgs = process.platform === 'win32'
                ? ['/d', '/s', '/c', tool.command]
                : ['-c', tool.command];

            // ── Notify the webview so it can open a live terminal block ──
            this._post({ type: 'terminalChunk', id: msgId, text: '' });

            // Do not launch login shells: shell startup files are outside the
            // workspace trust boundary and should not run for every agent command.
            // On POSIX the shell leads its own process group so a timeout or Stop can
            // kill everything it started, including background jobs (`server &`).
            const useProcessGroup = process.platform !== 'win32';
            const child = cp.spawn(shell, shellArgs, {
                cwd,
                env: process.env,
                detached: useProcessGroup,
            });

            const timeoutSec = Math.max(10, vscode.workspace.getConfiguration('codico').get<number>('terminalTimeoutSeconds', 300));
            const TIMEOUT_MS = timeoutSec * 1000;
            const killTree = (sig: NodeJS.Signals) => {
                try {
                    if (useProcessGroup && child.pid) { process.kill(-child.pid, sig); } else { child.kill(sig); }
                } catch { /* already exited */ }
            };

            let timedOut = false;
            let killTimer: ReturnType<typeof setTimeout> | undefined;
            let forceSettleTimer: ReturnType<typeof setTimeout> | undefined;
            let exitGraceTimer: ReturnType<typeof setTimeout> | undefined;
            const terminate = () => {
                killTree('SIGTERM');
                killTimer = setTimeout(() => killTree('SIGKILL'), 3_000);
                // Settle even if something still holds the output pipes open
                forceSettleTimer = setTimeout(() => finish(null, 'SIGKILL'), 5_000);
            };
            const timeoutTimer = setTimeout(() => { timedOut = true; terminate(); }, TIMEOUT_MS);

            // Kill the command and everything it started when the user clicks Stop
            const onAbort = () => terminate();
            signal.addEventListener('abort', onAbort, { once: true });

            const outputChunks: string[] = [];

            const onData = (chunk: Buffer) => {
                const text = chunk.toString('utf8');
                outputChunks.push(text);
                this._post({ type: 'terminalChunk', id: msgId, text });
            };

            child.stdout.on('data', onData);
            child.stderr.on('data', onData);

            // Guard against both 'error' and 'close' firing (e.g. ENOENT spawn failure)
            let settled = false;
            const settle = (result: string, success: boolean, errorMsg?: string) => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timeoutTimer);
                clearTimeout(killTimer);
                clearTimeout(forceSettleTimer);
                clearTimeout(exitGraceTimer);
                signal.removeEventListener('abort', onAbort);
                // Stop reading: a background job may keep the pipes open indefinitely
                child.stdout.destroy();
                child.stderr.destroy();
                this._post({ type: 'toolResult', id: msgId, tool: 'run_terminal', label: shortCmd, success, error: errorMsg });
                resolve(result);
            };

            const finish = (code: number | null, sig: NodeJS.Signals | null, note = '') => {
                const output = outputChunks.join('') + note;
                if (signal.aborted) {
                    settle(`[run_terminal: ${tool.command}] Stopped by user.\n${output.slice(0, 4000)}`, false);
                    return;
                }
                if (timedOut) {
                    settle(
                        `[run_terminal: ${tool.command}]\n(timed out after ${timeoutSec}s — the command and its child processes were killed. ` +
                        `Long-running processes such as servers must not be started with run_terminal.)\n${output.slice(0, 4000)}`,
                        false,
                        `Timed out after ${timeoutSec}s`
                    );
                    return;
                }
                const exitCode = code ?? (sig ? 1 : 0);
                const bgNote = useProcessGroup && child.pid && this._trackBackgroundGroup(child.pid, tool.command)
                    ? '\n(background processes started by this command are still running; the user can stop them from the status bar)'
                    : '';
                settle(
                    `[run_terminal: ${tool.command}]\nExit: ${exitCode}\n${output.slice(0, 4000)}${bgNote}`,
                    exitCode === 0
                );
            };

            // 'close' waits for every holder of the output pipes, which never happens when
            // the command leaves a background job running. Once the shell itself exits,
            // allow a moment for trailing output and then report the result.
            child.on('exit', (code, sig) => {
                exitGraceTimer = setTimeout(() => finish(code, sig), 1_000);
            });
            child.on('close', (code, sig) => finish(code, sig));

            child.on('error', (err) => {
                if (signal.aborted) {
                    settle(`[run_terminal: ${tool.command}] Stopped by user.`, false);
                    return;
                }
                settle(`[run_terminal: ${tool.command}] ERROR: ${err.message}`, false, err.message);
            });
        });
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
        try { process.kill(-pgid, 0); return true; } catch { return false; }
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
            try { process.kill(-pgid, 'SIGTERM'); } catch { /* already gone */ }
            setTimeout(() => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* exited */ } }, 3_000);
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
        const uris = await vscode.workspace.findFiles(include, exclude, 600);
        const matches: string[] = [];

        for (const uri of uris) {
            if (matches.length >= 100) { break; }
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                if (bytes.byteLength > 1_000_000) { continue; }
                const text = new TextDecoder().decode(bytes);
                if (text.includes('\x00')) { continue; }
                const rel = vscode.workspace.asRelativePath(uri);
                const lines = text.split('\n');
                for (let i = 0; i < lines.length && matches.length < 100; i++) {
                    const line = lines[i];
                    const hit = matcher ? matcher.test(line) : line.includes(tool.pattern);
                    if (matcher) { matcher.lastIndex = 0; }
                    if (hit) {
                        matches.push(`${rel}:${i + 1}:${line.slice(0, 500)}`);
                    }
                }
            } catch {
                // Skip unreadable files; continue searching the rest of the workspace.
            }
        }

        const label = tool.glob ? `"${tool.pattern}" in ${tool.glob}` : `"${tool.pattern}"`;
        this._post({ type: 'toolResult', id: msgId, tool: 'search_files', label: `${label} — ${matches.length} matches`, success: true });
        return matches.length > 0
            ? `[search_files: ${label}]\n${matches.join('\n')}${matches.length >= 100 ? '\n… (truncated at 100 matches)' : ''}`
            : `[search_files: ${label}] No matches found`;
    }

    private async _handleFindFiles(tool: FindFilesTool, msgId: string): Promise<string> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            this._post({ type: 'toolResult', id: msgId, tool: 'find_files', label: tool.pattern, success: false, error: 'No workspace folder open' });
            return '[find_files] ERROR: No workspace folder open';
        }

        let dir = (tool.dirpath ?? '').trim().replace(/\\/g, '/');
        if (dir === '.') { dir = ''; }
        if (dir) {
            dir = path.posix.normalize(dir);
            if (dir.startsWith('..') || path.isAbsolute(dir)) {
                this._post({ type: 'toolResult', id: msgId, tool: 'find_files', label: tool.pattern, success: false, error: 'Unsafe dirpath rejected' });
                return '[find_files] ERROR: Unsafe dirpath rejected';
            }
        }

        const cleanPattern = tool.pattern.replace(/^\*\*\//, '');
        const include = dir
            ? `${dir}/**/${cleanPattern}`
            : `**/${cleanPattern}`;
        const exclude = '**/{node_modules,.git,out,dist,coverage,.next,target}/**';

        try {
            const uris = await vscode.workspace.findFiles(include, exclude, 200);
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
            const folders = vscode.workspace.workspaceFolders;
            if (!folders || folders.length === 0) {
                const err = 'No workspace folder open';
                this._post({ type: 'toolResult', id: msgId, tool: 'edit_file', label: tool.filepath, success: false, error: err });
                return `[edit_file: ${tool.filepath}] ERROR: ${err}`;
            }
            const normalized = path.posix.normalize(tool.filepath.replace(/\\/g, '/'));
            if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
                const err = `Unsafe path rejected: ${tool.filepath}`;
                this._post({ type: 'toolResult', id: msgId, tool: 'edit_file', label: tool.filepath, success: false, error: err });
                return `[edit_file: ${tool.filepath}] ERROR: ${err}`;
            }
            const fileUri = vscode.Uri.joinPath(folders[0].uri, normalized);
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            const rawContent = new TextDecoder().decode(bytes);

            // Normalize CRLF → LF for matching; oldStr from the parser is always LF-only.
            // Without this, edit_file fails with "old_str not found" on any CRLF file.
            const hasCRLF = rawContent.includes('\r\n');
            const content = hasCRLF ? rawContent.replace(/\r\n/g, '\n') : rawContent;

            const occurrences = content.split(tool.oldStr).length - 1;
            if (occurrences === 0) {
                this._post({ type: 'toolResult', id: msgId, tool: 'edit_file', label: tool.filepath, success: false, error: 'old_str not found' });
                return `[edit_file: ${tool.filepath}] ERROR: old_str not found in file`;
            }
            if (occurrences > 1) {
                this._post({ type: 'toolResult', id: msgId, tool: 'edit_file', label: tool.filepath, success: false, error: `old_str found ${occurrences} times — must be unique` });
                return `[edit_file: ${tool.filepath}] ERROR: old_str matches ${occurrences} locations — must be unique. Provide more context.`;
            }

            // Use replacer function to avoid $& / $` / $' / $n pattern interpretation in newStr.
            // Restore original line endings after replacement so the file's style is preserved.
            const applyEdit = (src: string): string => {
                const replaced = src.replace(tool.oldStr, () => tool.newStr);
                // Use a negative lookbehind so existing \r\n pairs in newStr are not
                // double-converted to \r\r\n when restoring the file's original line endings.
                return hasCRLF ? replaced.replace(/(?<!\r)\n/g, '\r\n') : replaced;
            };

            // ── Edits Mode: queue proposal instead of writing immediately ──────
            if (this._editsMode) {
                this._editProposals.queue({ filepath: tool.filepath, originalContent: bytes, proposedContent: applyEdit(content), label: `edit ${tool.filepath}` });
                this._post({ type: 'proposalQueued', filepath: tool.filepath });
                return `[edit_file: ${tool.filepath}] Queued as edit proposal`;
            }

            // Full-file diff gives the reviewer complete context (before → proposed file)
            const proposedLF = content.replace(tool.oldStr, () => tool.newStr);
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

            const effectiveNewStr = editResult.editedContent ?? tool.newStr;
            const newContentLF = content.replace(tool.oldStr, () => effectiveNewStr);
            const finalEditDiff = editResult.editedContent ? this._computeLineDiff(content, newContentLF) : editDiff;
            const newContent = hasCRLF ? newContentLF.replace(/(?<!\r)\n/g, '\r\n') : newContentLF;
            const before = new TextEncoder().encode(rawContent);
            const after = new TextEncoder().encode(newContent);
            await vscode.workspace.fs.writeFile(fileUri, after);
            // showTextDocument can fail (e.g. column unavailable) even after a successful
            // write — treat display failure as non-fatal so the AI gets the correct result.
            try {
                const doc = await vscode.workspace.openTextDocument(fileUri);
                await vscode.window.showTextDocument(doc, { preview: true });
            } catch { /* best-effort display */ }

            this._undoRedo.push({ filepath: tool.filepath, before, after, label: `edit_file ${tool.filepath}` });
            this._post({ type: 'undoRedoState', ...this._undoRedo.state });
            this._post({ type: 'toolResult', id: msgId, tool: 'edit_file', label: tool.filepath, success: true, diff: finalEditDiff });
            this._filesWrittenThisTurn++;

            // Return a context window around the edited region so the model can
            // confirm the result without issuing a follow-up read_file call.
            const editedLines = newContentLF.split('\n');
            const insertedLines = effectiveNewStr.split('\n');
            const insertStart = newContentLF.indexOf(effectiveNewStr);
            const linesBefore = newContentLF.slice(0, insertStart).split('\n').length - 1;
            const CONTEXT = 3;
            const from = Math.max(0, linesBefore - CONTEXT);
            const to   = Math.min(editedLines.length, linesBefore + insertedLines.length + CONTEXT);
            const snippet = editedLines.slice(from, to).join('\n');
            return `[edit_file: ${tool.filepath}] Edit applied successfully.\nResult (lines ${from + 1}–${to}):\n\`\`\`\n${snippet}\n\`\`\``;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'edit_file', label: tool.filepath, success: false, error: message });
            return `[edit_file: ${tool.filepath}] ERROR: ${message}`;
        }
    }

    private async _confirmExternalAction(action: string, detail: string): Promise<boolean> {
        if (this._allowAllExternal) { return true; }

        const choice = await vscode.window.showWarningMessage(
            `Codico wants to ${action}.`,
            {
                modal: true,
                detail: `${detail}\n\nThis action can affect systems outside the current workspace.`,
            },
            'Allow Once',
            'Allow External Actions This Turn'
        );

        if (choice === 'Allow External Actions This Turn') {
            this._allowAllExternal = true;
            return true;
        }
        return choice === 'Allow Once';
    }

    private async _handleBrowserNavigate(tool: BrowserNavigateTool, msgId: string): Promise<string> {
        if (!await this._confirmExternalAction('navigate the browser', tool.url)) {
            return `[browser_navigate: ${tool.url}] Denied by user`;
        }
        try {
            const result = await this._browser.navigate(tool.url);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_navigate', label: result.title || tool.url, success: true });
            // Take and send a screenshot automatically after navigation
            await this._sendBrowserScreenshot(msgId).catch(() => null);
            return `[browser_navigate] ${result.text}. Page title: "${result.title}"\nCurrent URL: ${result.currentUrl}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_navigate', label: tool.url, success: false, error: message });
            return `[browser_navigate: ${tool.url}] ERROR: ${message}`;
        }
    }

    private async _handleBrowserClick(tool: BrowserClickTool, msgId: string): Promise<string> {
        if (!await this._confirmExternalAction('click in the browser', tool.selector)) {
            return `[browser_click: ${tool.selector}] Denied by user`;
        }
        try {
            const result = await this._browser.click(tool.selector);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_click', label: tool.selector, success: true });
            await this._sendBrowserScreenshot(msgId).catch(() => null);
            return `[browser_click] ${result}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_click', label: tool.selector, success: false, error: message });
            return `[browser_click: ${tool.selector}] ERROR: ${message}`;
        }
    }

    private async _handleBrowserType(tool: BrowserTypeTool, msgId: string): Promise<string> {
        const preview = tool.text.length > 120 ? tool.text.slice(0, 120) + '…' : tool.text;
        if (!await this._confirmExternalAction('type into the browser', `${tool.selector} → "${preview}"`)) {
            return `[browser_type: ${tool.selector}] Denied by user`;
        }
        try {
            const result = await this._browser.typeText(tool.selector, tool.text, tool.submit ?? false);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_type', label: `${tool.selector} → "${tool.text}"`, success: true });
            await this._sendBrowserScreenshot(msgId).catch(() => null);
            return `[browser_type] ${result}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_type', label: tool.selector, success: false, error: message });
            return `[browser_type: ${tool.selector}] ERROR: ${message}`;
        }
    }

    private async _handleBrowserGetText(tool: BrowserGetTextTool, msgId: string): Promise<string> {
        try {
            const text = await this._browser.getText(tool.selector);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_get_text', label: tool.selector ?? 'page', success: true });
            return `[browser_get_text: ${tool.selector ?? 'page'}]\n${text}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_get_text', label: tool.selector ?? 'page', success: false, error: message });
            return `[browser_get_text] ERROR: ${message}`;
        }
    }

    private async _handleBrowserScreenshot(msgId: string): Promise<string> {
        try {
            await this._sendBrowserScreenshot(msgId);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_screenshot', label: 'screenshot', success: true });
            return `[browser_screenshot] Screenshot captured and displayed in chat.`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'browser_screenshot', label: 'screenshot', success: false, error: message });
            return `[browser_screenshot] ERROR: ${message}`;
        }
    }

    private async _sendBrowserScreenshot(msgId: string): Promise<void> {
        const buf = await this._browser.screenshot();
        const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
        this._post({ type: 'browserScreenshot', id: msgId, dataUrl, url: this._browser.currentUrl });
    }

    private async _handleFetchUrl(tool: FetchUrlTool, msgId: string): Promise<string> {
        if (!await this._confirmExternalAction('fetch a URL', tool.url)) {
            return `[fetch_url: ${tool.url}] Denied by user`;
        }

        try {
            const text = await fetchPublicText(tool.url);
            this._post({ type: 'toolResult', id: msgId, tool: 'fetch_url', label: tool.url, success: true });
            return `[fetch_url: ${tool.url}]\n${text}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'fetch_url', label: tool.url, success: false, error: message });
            return `[fetch_url: ${tool.url}] ERROR: ${message}`;
        }
    }

    private async _handleMcpCall(tool: McpCallTool, msgId: string): Promise<string> {
        const label = `${tool.server}/${tool.tool}`;
        if (!await this._confirmExternalAction('call an MCP tool', label)) {
            return `[mcp_call: ${label}] Denied by user`;
        }
        try {
            const result = await this._mcp.callTool(tool.server, tool.tool, tool.args);
            // Flatten content parts to a single string
            const text = (result.content ?? [])
                .map(part => {
                    if (part.type === 'text') { return part.text ?? ''; }
                    if (part.type === 'image') { return `[image: ${part.mimeType ?? 'unknown'}]`; }
                    return `[${part.type}]`;
                })
                .join('\n');
            const isError = result.isError === true;
            this._post({ type: 'toolResult', id: msgId, tool: 'mcp_call', label, success: !isError, error: isError ? text : undefined });
            return isError
                ? `[mcp_call: ${label}] ERROR:\n${text}`
                : `[mcp_call: ${label}]\n${text}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'mcp_call', label, success: false, error: message });
            return `[mcp_call: ${label}] ERROR: ${message}`;
        }
    }

    private async _handleLspSymbol(tool: LspSymbolTool, msgId: string): Promise<string> {
        const label = `lsp: ${tool.query}`;
        try {
            const symbols = await resolveSymbol(tool.query, 8);
            if (symbols.length === 0) {
                this._post({ type: 'toolResult', id: msgId, tool: 'lsp_symbol', label, success: true });
                return `[lsp_symbol: "${tool.query}"] No symbols found.`;
            }
            const lines = symbols.map(s => {
                const parts = [`### ${s.kind} \`${s.name}\`  —  ${s.definedIn}:${s.definedAtLine}`];
                if (s.typeInfo) { parts.push(s.typeInfo); }
                if (s.definitionSnippet) { parts.push(`\`\`\`\n${s.definitionSnippet}\n\`\`\``); }
                return parts.join('\n');
            });
            this._post({ type: 'toolResult', id: msgId, tool: 'lsp_symbol', label, success: true });
            return `[lsp_symbol: "${tool.query}"]\n${lines.join('\n\n')}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'lsp_symbol', label, success: false, error: message });
            return `[lsp_symbol: "${tool.query}"] ERROR: ${message}`;
        }
    }

    // ── Debug tools ───────────────────────────────────────────────────────────

    private async _handleDebugGetVariables(tool: DebugGetVariablesTool, msgId: string): Promise<string> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            this._post({ type: 'toolResult', id: msgId, tool: 'debug_get_variables', label: 'variables', success: false, error: 'No active debug session' });
            return '[debug_get_variables] No active debug session. Start a debug session first.';
        }

        try {
            // Get stack frames for the current thread
            const threadsResp = await session.customRequest('threads', {}) as { threads: Array<{ id: number; name: string }> };
            if (!threadsResp.threads || threadsResp.threads.length === 0) {
                this._post({ type: 'toolResult', id: msgId, tool: 'debug_get_variables', label: 'variables', success: false, error: 'No threads' });
                return '[debug_get_variables] No threads found in the current debug session.';
            }

            const threadId = threadsResp.threads[0].id;
            const stackResp = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 20 }) as { stackFrames: Array<{ id: number; name: string; source?: { name?: string }; line: number }> };
            const frames = stackResp.stackFrames ?? [];
            // DAP frameIds are opaque identifiers, not array indices — find by id, fall back to top frame
            const targetFrame = (tool.frameId != null ? frames.find(f => f.id === tool.frameId) : undefined) ?? frames[0];
            if (!targetFrame) {
                this._post({ type: 'toolResult', id: msgId, tool: 'debug_get_variables', label: 'variables', success: false, error: 'No stack frames' });
                return '[debug_get_variables] No stack frames available.';
            }

            // Get scopes for the selected frame
            const scopesResp = await session.customRequest('scopes', { frameId: targetFrame.id }) as { scopes: Array<{ name: string; variablesReference: number; expensive: boolean }> };
            const scopes = scopesResp.scopes ?? [];

            const lines: string[] = [`Frame: ${targetFrame.name} (${targetFrame.source?.name ?? '?'}:${targetFrame.line})`];

            for (const scope of scopes) {
                if (scope.expensive) { continue; } // skip large scopes like Globals
                const varsResp = await session.customRequest('variables', { variablesReference: scope.variablesReference }) as { variables: Array<{ name: string; value: string; type?: string; variablesReference: number }> };
                const vars = varsResp.variables ?? [];
                if (vars.length === 0) { continue; }
                lines.push(`\n[${scope.name}]`);
                for (const v of vars.slice(0, 50)) {
                    const typeTag = v.type ? ` (${v.type})` : '';
                    lines.push(`  ${v.name}${typeTag} = ${v.value}`);
                }
            }

            const output = lines.join('\n');
            this._post({ type: 'toolResult', id: msgId, tool: 'debug_get_variables', label: 'variables', success: true });
            return `[debug_get_variables]\n${output}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'debug_get_variables', label: 'variables', success: false, error: message });
            return `[debug_get_variables] ERROR: ${message}`;
        }
    }

    private async _handleDebugGetCallstack(msgId: string): Promise<string> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            this._post({ type: 'toolResult', id: msgId, tool: 'debug_get_callstack', label: 'call stack', success: false, error: 'No active debug session' });
            return '[debug_get_callstack] No active debug session.';
        }

        try {
            const threadsResp = await session.customRequest('threads', {}) as { threads: Array<{ id: number; name: string }> };
            const lines: string[] = [];

            for (const thread of threadsResp.threads ?? []) {
                lines.push(`Thread ${thread.id}: ${thread.name}`);
                const stackResp = await session.customRequest('stackTrace', { threadId: thread.id, startFrame: 0, levels: 30 }) as { stackFrames: Array<{ id: number; name: string; source?: { name?: string; path?: string }; line: number; column: number }> };
                for (let i = 0; i < (stackResp.stackFrames ?? []).length; i++) {
                    const f = stackResp.stackFrames[i];
                    const loc = f.source?.name ? `${f.source.name}:${f.line}:${f.column}` : `frame ${f.id}`;
                    lines.push(`  #${i}  ${f.name}  —  ${loc}`);
                }
            }

            const output = lines.join('\n') || '(no stack frames)';
            this._post({ type: 'toolResult', id: msgId, tool: 'debug_get_callstack', label: 'call stack', success: true });
            return `[debug_get_callstack]\n${output}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'debug_get_callstack', label: 'call stack', success: false, error: message });
            return `[debug_get_callstack] ERROR: ${message}`;
        }
    }

    private async _handleDebugListBreakpoints(msgId: string): Promise<string> {
        try {
            const breakpoints = vscode.debug.breakpoints;
            if (breakpoints.length === 0) {
                this._post({ type: 'toolResult', id: msgId, tool: 'debug_list_breakpoints', label: 'breakpoints', success: true });
                return '[debug_list_breakpoints] No breakpoints set.';
            }

            const lines: string[] = [];
            for (const bp of breakpoints) {
                if (bp instanceof vscode.SourceBreakpoint) {
                    const rel = vscode.workspace.asRelativePath(bp.location.uri);
                    const line = bp.location.range.start.line + 1;
                    const col = bp.location.range.start.character + 1;
                    const cond = bp.condition ? `  condition: ${bp.condition}` : '';
                    const hitCond = bp.hitCondition ? `  hitCondition: ${bp.hitCondition}` : '';
                    const enabled = bp.enabled ? '' : '  [DISABLED]';
                    lines.push(`${rel}:${line}:${col}${enabled}${cond}${hitCond}`);
                } else if (bp instanceof vscode.FunctionBreakpoint) {
                    const enabled = bp.enabled ? '' : '  [DISABLED]';
                    lines.push(`function: ${bp.functionName}${enabled}`);
                }
            }

            this._post({ type: 'toolResult', id: msgId, tool: 'debug_list_breakpoints', label: `${breakpoints.length} breakpoint(s)`, success: true });
            return `[debug_list_breakpoints] ${breakpoints.length} breakpoint(s):\n${lines.join('\n')}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._post({ type: 'toolResult', id: msgId, tool: 'debug_list_breakpoints', label: 'breakpoints', success: false, error: message });
            return `[debug_list_breakpoints] ERROR: ${message}`;
        }
    }

    private async _buildContextPreamble(): Promise<string> {
        const config = vscode.workspace.getConfiguration('codico');
        const parts: string[] = [];
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            parts.push(`Workspace: ${folders[0].uri.fsPath}`);
        }
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const relPath = vscode.workspace.asRelativePath(editor.document.uri);
            const lang = editor.document.languageId;
            const lines = editor.document.lineCount;
            parts.push(`Active file: ${relPath} (${lang}, ${lines} lines)`);
            if (!editor.selection.isEmpty) {
                const sel = editor.selection;
                const selText = editor.document.getText(editor.selection);
                const cap = 10_000;
                const truncated = selText.length > cap;
                parts.push(
                    `Selected code (${relPath} lines ${sel.start.line + 1}–${sel.end.line + 1}):\n` +
                    `\`\`\`${lang}\n${selText.slice(0, cap)}${truncated ? '\n… (truncated)' : ''}\n\`\`\``
                );
            }
        }

        // Auto-inject workspace diagnostics (all Problems panel errors/warnings)
        if (config.get<boolean>('autoInjectDiagnostics', true)) {
            const diagSummary = _buildWorkspaceDiagnosticsSummary();
            if (diagSummary) { parts.push(diagSummary); }
        }

        // Inject open tabs context if enabled
        if (config.get<boolean>('openTabsContext', true)) {
            const activeUri = editor?.document.uri.toString();
            const candidateUris: vscode.Uri[] = [];
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    if (candidateUris.length >= 5) { break; }
                    const input = tab.input as { uri?: vscode.Uri } | undefined;
                    if (!input?.uri) { continue; }
                    if (input.uri.toString() === activeUri) { continue; }
                    candidateUris.push(input.uri);
                }
                if (candidateUris.length >= 5) { break; }
            }
            // Open all candidate tabs in parallel instead of sequentially
            const tabSnippets = (await Promise.all(
                candidateUris.map(async (uri) => {
                    try {
                        const doc = await vscode.workspace.openTextDocument(uri);
                        const relPath = vscode.workspace.asRelativePath(uri);
                        const text = doc.getText();
                        return `// ${relPath}\n${text.slice(0, 5000)}${text.length > 5000 ? '\n… (truncated)' : ''}`;
                    } catch { return null; }
                })
            )).filter((s): s is string => s !== null);
            if (tabSnippets.length > 0) {
                parts.push(`Open tabs (${tabSnippets.length}):\n${tabSnippets.join('\n\n')}`);
            }
        }

        // Symbol-aware context: LSP info for symbol under cursor
        if (editor && config.get<boolean>('symbolContextEnabled', true)) {
            try {
                const symCtx = await buildSymbolContext(editor.document, editor.selection.active);
                if (symCtx) { parts.push(symCtx); }
            } catch { /* LSP may not be ready */ }
        }

        return parts.length > 0 ? `[Context]\n${parts.join('\n')}` : '';
    }

    // ── Line diff (LCS-based) ─────────────────────────────────────────────────
    /**
     * Produces a compact unified-style diff string (lines prefixed with +, -, or space).
     * Hunk separators are the literal string '@@'.
     * Input strings are split on '\n'; each side is capped at 500 lines so the
     * O(n×m) LCS stays fast even for large files.
     */
    private _computeLineDiff(before: string, after: string, maxOutputLines = 200): string {
        const CAP = 500;
        const rawA = before.split('\n');
        const rawB = after.split('\n');
        const truncated = rawA.length > CAP || rawB.length > CAP;
        const a = rawA.slice(0, CAP);
        const b = rawB.slice(0, CAP);

        const n = a.length, m = b.length;
        // LCS length table
        const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0) as number[]);
        for (let i = 1; i <= n; i++) {
            for (let j = 1; j <= m; j++) {
                dp[i][j] = a[i - 1] === b[j - 1]
                    ? dp[i - 1][j - 1] + 1
                    : Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }

        // Iterative backtrack to produce edit script
        const ops: Array<['+' | '-' | ' ', string]> = [];
        let i = n, j = m;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
                ops.unshift([' ', a[i - 1]]); i--; j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                ops.unshift(['+', b[j - 1]]); j--;
            } else {
                ops.unshift(['-', a[i - 1]]); i--;
            }
        }

        // Format with 3 context lines around each changed region
        const CTX = 3;
        const show = new Set<number>();
        for (let k = 0; k < ops.length; k++) {
            if (ops[k][0] !== ' ') {
                for (let c = Math.max(0, k - CTX); c <= Math.min(ops.length - 1, k + CTX); c++) {
                    show.add(c);
                }
            }
        }

        if (show.size === 0) { return ''; } // files are identical

        const lines: string[] = [];
        let prevShown = -1;
        for (let k = 0; k < ops.length; k++) {
            if (!show.has(k)) { continue; }
            if (prevShown >= 0 && k > prevShown + 1) { lines.push('@@'); }
            lines.push(ops[k][0] + ops[k][1]);
            prevShown = k;
            if (lines.length >= maxOutputLines) { lines.push('…'); break; }
        }

        if (truncated) { lines.push('… (diff truncated — file exceeds 500 lines)'); }
        return lines.join('\n');
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

    private static readonly PLAN_PROMPT = `You are a task planner. The user has described a goal. Break it down into a clear, numbered step-by-step plan.

Rules:
- Each step must be a single, concrete, actionable task (no vague steps like "set up the project").
- Number steps as 1. 2. 3. etc.
- After the numbered list, add a section: ## Files Affected — list every file that will be created or modified.
- Do NOT write any code yet. Do NOT execute anything. Only produce the plan.
- End with a single line: > Approve the plan to begin execution.

Goal: `;

    private static readonly REVIEW_PROMPT = `You are performing a thorough code review. Analyse the code provided and produce a structured report with these exact sections:

## Overview
One paragraph describing what the code does and its overall quality.

## Issues
List every issue found, each prefixed with a severity badge:
- 🔴 **Critical** — bugs, security vulnerabilities, data loss risks
- 🟡 **Warning** — logic errors, poor error handling, performance problems, deprecated APIs
- 🔵 **Info** — style inconsistencies, naming, missing docs, minor improvements

For each issue include: file/line reference (if determinable), a clear explanation, and a concrete fix or code snippet.
If there are no issues in a category, omit that category.

## Suggestions
Up to 5 actionable improvement ideas that are not bugs but would meaningfully improve the code (architecture, testability, readability, performance).

## Summary
One-sentence verdict: e.g. "Ready to merge with minor changes" / "Needs significant rework before merging".

Be thorough, specific, and constructive. Reference exact line numbers or code snippets wherever possible.`;

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
        this._post({ type: 'planReady', goal, error: undefined });
        const planMessage = AgentProvider.PLAN_PROMPT + goal;
        await this._handleUserMessage(planMessage);
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

        const reviewMessage = `${codeContext}\n\n${AgentProvider.REVIEW_PROMPT}`;
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

    private _getThreadListForWebview(): Array<{ id: string; name: string; updatedAt: number; preview: string; messageCount: number; active: boolean }> {
        return this._store.get<ThreadEntry[]>(this._threadsIndexKey, [])
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(t => ({ ...t, active: t.id === this._activeThreadId }));
    }

    private async _updateThreadMeta(userText: string): Promise<void> {
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

    private _isValidModelId(id: string): boolean {
        // _validModelIds is populated async by _preloadMediaFiles at construction time.
        // If the async load hasn't completed yet (very early first call) or if models.json
        // was unavailable, _validModelIds is null — allow all models rather than blocking.
        if (!this._validModelIds || this._validModelIds.size === 0) { return true; }
        return this._validModelIds.has(id);
    }

    private _buildHtml(_webview: vscode.Webview): string {
        const nonce = getNonce();
        const media = this._extensionUri.fsPath + '/media';
        // Use async-preloaded cache. Fall back to sync only if resolveWebviewView fires
        // before _preloadMediaFiles completes (extremely rare on normal activation paths).
        const rawHtml       = this._cachedHtml      ?? fs.readFileSync(media + '/chat.html',   'utf8');
        const rawModelsJson = this._cachedModelsJson ?? fs.readFileSync(media + '/models.json', 'utf8');
        // Replace all nonce placeholders
        let html = rawHtml.split('{{NONCE}}').join(nonce);
        // Inject models data — escape </script> sequences to prevent breakout.
        // Use a replacer function to avoid $& / $' / $` special replacement patterns
        // in safeModelsJson corrupting the HTML (e.g. a model name containing "$&").
        const safeModelsJson = rawModelsJson.replace(/<\/script>/gi, '<\\/script>');
        html = html.replace('{{MODELS_JSON}}', () => safeModelsJson);
        return html;
    }

}


// ─── Message type contracts ──────────────────────────────────────────────────

type WebviewMessage =
    | { type: 'sendMessage'; text: string; contentParts?: Array<{ type: string; [key: string]: unknown }>; injectActiveDiagnostics?: boolean }
    | { type: 'clearChat' }
    | { type: 'openProblems' }
    | { type: 'setApiKey' }
    | { type: 'openSettings' }
    | { type: 'closePanel' }
    | { type: 'abortStream' }
    | { type: 'checkpointResponse'; continue: boolean }
    | { type: 'killBackgroundProcesses' }
    | { type: 'changeModel'; model: string }
    | { type: 'changeEffort'; effort: 'high' | 'medium' | 'low' }
    | { type: 'requestContext'; kind: 'file' | 'selection' | 'diagnostics' | 'files-pick' }
    | { type: 'startReview'; target: 'file' | 'selection' }
    | { type: 'startPlan'; goal: string }
    | { type: 'approvePlan'; executionPrompt: string }
    | { type: 'clarifyResponse'; text: string }
    | { type: 'refreshMcp' }
    | { type: 'undo' }
    | { type: 'redo' }
    | { type: 'toggleEditsMode'; enabled: boolean }
    | { type: 'previewEditDiff'; filepath: string }
    | { type: 'acceptEdit'; filepath: string }
    | { type: 'rejectEdit'; filepath: string }
    | { type: 'acceptAllEdits' }
    | { type: 'rejectAllEdits' }
    | { type: 'sendFollowUp'; text: string }
    | { type: 'generateTestsFromCoverage' }
    | { type: 'runAndFixTests' }
    | { type: 'createThread'; name?: string }
    | { type: 'switchThread'; id: string }
    | { type: 'renameThread'; id: string; name: string }
    | { type: 'deleteThread'; id: string }
    | { type: 'threadContextMenu'; id: string }
    | { type: 'searchThreads'; query: string }
    | { type: 'resumeSession' }
    | { type: 'writePermissionResponse'; permId: string; granted: boolean }
    | { type: 'terminalPermissionResponse'; permId: string; granted: boolean }
    | { type: 'allowAllWrites'; permId: string }
    | { type: 'allowAllTerminal'; permId: string }
    | { type: 'writePermissionEdit'; permId: string; content: string }
    | { type: 'toggleAutoCommit'; enabled: boolean }
    | { type: 'compactChat' }
    | { type: 'toggleAutoCompact'; enabled: boolean }
    | { type: 'toggleChatMode'; chatMode: boolean };

type ExtensionMessage =
    | { type: 'startMessage'; id: string }
    | { type: 'appendThinking'; id: string; text: string }
    | { type: 'appendContent'; id: string; text: string }
    | { type: 'endMessage'; id: string }
    | { type: 'fileWriteResult'; id: string; filepath: string; granted: boolean; error?: string; diff?: string }
    | { type: 'toolStart'; id: string; tool: string; label: string }
    | { type: 'toolResult'; id: string; tool: string; label: string; success: boolean; error?: string; diff?: string }
    | { type: 'tokenUsage'; promptTokens: number; completionTokens: number; totalTokens: number }
    | { type: 'streamFinishReason'; id: string; reason: string }
    | { type: 'streamError'; id: string; message: string }
    | { type: 'contextSnippet'; kind: string; label: string; text: string }
    | { type: 'reviewReady'; label: string; error: string | undefined }
    | { type: 'planReady'; goal: string; error: string | undefined }
    | { type: 'browserScreenshot'; id: string; dataUrl: string; url: string }
    | { type: 'setEffort'; effort: 'high' | 'medium' | 'low' }
    | { type: 'error'; message: string }
    | { type: 'setModel'; model: string }
    | { type: 'agentActive'; agent: string }
    | { type: 'mcpStatus'; servers: Array<{ name: string; connected: boolean; toolCount: number; error?: string }> }
    | { type: 'undoRedoState'; canUndo: boolean; canRedo: boolean; undoLabel?: string; redoLabel?: string }
    | { type: 'proposalQueued'; filepath: string }
    | { type: 'proposalsReady'; proposals: Array<{ filepath: string; label: string; isNew: boolean; lines: number }> }
    | { type: 'proposalAccepted'; filepath: string }
    | { type: 'proposalRejected'; filepath: string }
    | { type: 'allProposalsResolved' }
    | { type: 'followUps'; id: string; suggestions: string[] }
    | { type: 'diagnosticsChanged'; errorCount: number; warningCount: number }
    | { type: 'threadLoaded'; id: string; name: string; displayMessages: DisplayMessage[] }
    | { type: 'threadList'; threads: Array<{ id: string; name: string; updatedAt: number; preview: string; messageCount: number; active: boolean }> }
    | { type: 'threadContextMenuRequest'; id: string; name: string }
    | { type: 'threadSearchResults'; query: string; results: Array<{ threadId: string; threadName: string; snippets: Array<{ role: string; snippet: string }> }> }
    | { type: 'writePermissionRequest'; id: string; permId: string; filepath: string; preview: string; diff?: string; editableContent?: string }
    | { type: 'terminalPermissionRequest'; id: string; permId: string; command: string }
    | { type: 'terminalChunk'; id: string; text: string }
    | { type: 'stepProgress'; id: string; step: number }
    | { type: 'activity'; text: string | null }
    | { type: 'checkpoint'; id: string; steps: number }
    | { type: 'backgroundProcesses'; processes: { command: string; startedAt: number }[] }
    | { type: 'autoCommitDone'; message: string }
    | { type: 'autoCommitError'; message: string }
    | { type: 'proactiveOffer'; filename: string; errorCount: number; warningCount: number }
    | { type: 'resumeOffer'; summary: string }
    | { type: 'focusInput' }
    | { type: 'todoUpdate'; id: string; items: Array<{ status: 'pending' | 'active' | 'done' | 'failed'; text: string }> }
    | { type: 'compactStart' }
    | { type: 'compactDone'; messageCount: number }
    | { type: 'compactError'; message: string }
    | { type: 'iterationLimit'; id: string; limit: number }
    | { type: 'selectionBadge'; label: string };
