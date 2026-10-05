// Shared protocol contracts for the extension host and webview-facing runtimes.
// Keep this module data-only: it must not depend on VS Code runtime state.

export interface ThreadEntry {
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    preview: string;
    hasBeenNamed?: boolean;
}

/** A webview event recorded while an assistant reply streamed, without its message id. */
export type ReplayEvent = { type: string; text?: string; diff?: string; [key: string]: unknown };

export interface DisplayMessage {
    role: 'user' | 'assistant';
    /** Plain-text summary, used for search and for threads saved before events were recorded. */
    text: string;
    /** Events that rebuild the full reply (text, reasoning, tool steps, terminal output). */
    events?: ReplayEvent[];
}

/** Events replayed to rebuild a reply when a thread is reopened. Interactive ones are excluded. */
export const REPLAY_TYPES = new Set([
    'appendThinking', 'appendContent', 'toolStart', 'toolResult', 'fileWriteResult',
    'terminalChunk', 'todoUpdate', 'streamFinishReason', 'streamError',
]);
/** Approximate characters of streamed text stored per reply. */
export const REPLAY_BUDGET = 400_000;
export const REPLAY_DIFF_LIMIT = 20_000;

// ─── Message type contracts ──────────────────────────────────────────────────

export type WebviewMessage =
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

export type ExtensionMessage =
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
