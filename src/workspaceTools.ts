import * as path from 'path';
import * as vscode from 'vscode';
import { WriteFileTool, RunTerminalTool, SearchFilesTool, FindFilesTool, EditFileTool } from './toolParser';
import { FileManager } from './fileManager';
import { PassportRecorder } from './patchPassport';
import { UndoRedoStack } from './undoRedoStack';
import { Approvals } from './approvals';
import { commandSandbox } from './commandSandboxService';
import { CommandApprovalStore } from './commandApprovalStore';
import { EditProposalManager } from './editProposalManager';
import { killProcessGroup, processGroupAlive, runTerminalProcess, clipTerminalOutput } from './terminalProcess';
import { ExtensionMessage } from './chatProtocol';
import { editResultSnippet } from './fileReadWindow';
import { buildLocalInvariantAudit } from './localInvariantAudit';
import { CRITERIA_NOW } from './verifyTools';
import { changesBetween, COMMAND_CHANGED_FILES, treeState } from './commandChanges';
import { applyEditMatch, editFailureContext, resolveEditMatch, withoutCopiedLineNumbers } from './editMatcher';
import { filterAllowedWorkspaceUris, resolveWorkspaceToolPath } from './workspaceSecurity';
import { isDocumentationFile, isTestFile, looksLikeIntendedRegex } from './agentEfficiency';
import { computeLineDiff } from './lineDiff';
import { renderSearchMatches } from './leanContext';
import { readCurrentBytes, revealFile, sameBytes, writeCurrentBytes } from './workspaceText';
import { findFilesInRoot, toolFolders, toolRelativePath, toolRoot } from './toolRoot';
import { globToRegex } from './ignoreRules';

/**
 * The tools that change the workspace or look through it on the agent's behalf: writing and
 * editing files, searching, and running commands (with the background processes a command
 * leaves behind). The agent's conversation, panel and approvals reach them through the host.
 */
export interface ToolHost {
    post(message: ExtensionMessage): void;
    readonly approvals: Approvals;
    readonly undo: UndoRedoStack;
    /** The change report of the turn in progress (a new one each turn). */
    passport(): PassportRecorder;
    readonly editProposals: EditProposalManager;
    readonly fileManager: FileManager;
    approvedCommands(): CommandApprovalStore;
    /** Automated test runs: nobody to ask. */
    evaluationMode(): boolean;
    /** Edits Mode: changes are proposed for review instead of written. */
    editsMode(): boolean;
    /** The agent read web or MCP content this turn: "allow all commands" no longer covers commands. */
    untrustedContentSeen(): boolean;
    /** A file was written or edited (counted for the turn). */
    fileWritten(): void;
}

export class WorkspaceTools {
    /** Process groups a finished command left running, by group id. */
    private readonly _bgProcesses = new Map<number, { command: string; startedAt: number }>();
    private _bgPollTimer: ReturnType<typeof setInterval> | undefined;

    constructor(private readonly _host: ToolHost) {}

    async writeFile(tool: WriteFileTool, msgId: string): Promise<string> {
        try {
            const target = await resolveWorkspaceToolPath(tool.filepath);
            const beforeBytes = await readCurrentBytes(target.uri);
            const beforeText = beforeBytes ? new TextDecoder().decode(beforeBytes) : '';

            if (this._host.editsMode()) {
                this._host.editProposals.queue({ filepath: tool.filepath, uri: target.uri, originalContent: beforeBytes, proposedContent: tool.content, label: `write ${tool.filepath}` });
                this._host.post({ type: 'proposalQueued', filepath: tool.filepath });
                return `[write_file: ${tool.filepath}] Queued as edit proposal`;
            }

            const diff = this._computeLineDiff(beforeText, tool.content);
            const writeResult = await this._host.approvals.askWrite({ id: msgId, filepath: tool.filepath, diff, editableContent: tool.content });

            if (!writeResult.granted) {
                this._host.post({ type: 'fileWriteResult', id: msgId, filepath: tool.filepath, granted: false });
                return `[write_file: ${tool.filepath}] Denied by user`;
            }

            // Approval can take a while: if the file changed meanwhile (the user edited it),
            // writing would silently replace those changes with content they never saw
            if (!sameBytes(await readCurrentBytes(target.uri), beforeBytes)) {
                this._host.post({ type: 'fileWriteResult', id: msgId, filepath: tool.filepath, granted: false, error: 'File changed while waiting for approval' });
                return `[write_file: ${tool.filepath}] Not written: the file changed while waiting for approval (probably edited by the user). Read it again and make your change on its current content.`;
            }

            const contentToWrite = writeResult.editedContent ?? tool.content;
            const finalDiff = writeResult.editedContent ? this._computeLineDiff(beforeText, contentToWrite) : diff;
            await this._host.fileManager.writeFile(tool.filepath, contentToWrite);

            const after = new TextEncoder().encode(contentToWrite);
            this._host.undo.push({ filepath: tool.filepath, uri: target.uri, before: beforeBytes, after, label: `write_file ${tool.filepath}` });
            this._host.post({ type: 'undoRedoState', ...this._host.undo.state });
            this._host.post({ type: 'fileWriteResult', id: msgId, filepath: tool.filepath, granted: true, diff: finalDiff });
            this._host.passport().recordChange(tool.filepath, beforeBytes ? beforeText : null, contentToWrite);
            this._host.fileWritten();
            const lineCount = contentToWrite.split('\n').length;
            return `[write_file: ${tool.filepath}] Written successfully (${lineCount} lines). File is on disk — no need to read it back to verify.${buildLocalInvariantAudit(contentToWrite, '', tool.filepath, beforeText)}${this._criteriaNote(tool.filepath)}`;
        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            this._host.post({ type: 'fileWriteResult', id: msgId, filepath: tool.filepath, granted: false, error: errorMsg });
            return `[write_file: ${tool.filepath}] Error: ${errorMsg}`;
        }
    }

    async runTerminal(tool: RunTerminalTool, msgId: string, signal: AbortSignal): Promise<string> {
        const shortCmd = tool.command.length > 80
            ? tool.command.slice(0, 80) + '\u2026'
            : tool.command;

        // Confined by the operating system when the user asked for it; where that is required and not possible, not run at all
        const sandbox = await commandSandbox();
        if (sandbox.refusal) { this._host.post({ type: 'toolResult', id: msgId, tool: 'run_terminal', label: shortCmd, success: false, error: 'No sandbox' }); return `[run_terminal: ${tool.command}] ${sandbox.refusal}`; }
        const granted = await this.askToRun(tool.command, msgId);
        if (!granted) {
            this._host.post({ type: 'toolResult', id: msgId, tool: 'run_terminal', label: shortCmd, success: false, error: 'Denied' });
            return `[run_terminal] Denied by user:\n${tool.command}`;
        }

        const cwd = toolFolders()?.[0]?.uri.fsPath;
        const timeoutSec = Math.max(
            10,
            vscode.workspace.getConfiguration('codico').get<number>('terminalTimeoutSeconds', 300)
        );

        this._host.post({ type: 'terminalChunk', id: msgId, text: '' });
        const treeBefore = cwd ? treeState(cwd) : undefined;
        const result = await runTerminalProcess({
            command: tool.command,
            cwd,
            timeoutMs: timeoutSec * 1000,
            signal, sandbox: sandbox.wrap,
            onChunk: (text) => this._host.post({ type: 'terminalChunk', id: msgId, text }),
        });

        if (result.stopped) {
            this._host.post({ type: 'toolResult', id: msgId, tool: 'run_terminal', label: shortCmd, success: false });
            return `[run_terminal: ${tool.command}] Stopped by user.\n${clipTerminalOutput(result.output)}`;
        }
        if (result.timedOut) {
            const message = `Timed out after ${timeoutSec}s`;
            this._host.post({ type: 'toolResult', id: msgId, tool: 'run_terminal', label: shortCmd, success: false, error: message });
            this._host.passport().recordCommand(tool.command, null, result.output);
            return `[run_terminal: ${tool.command}]\n(timed out after ${timeoutSec}s — the command and its child processes were killed. Long-running processes such as servers must not be started with run_terminal.)\n${clipTerminalOutput(result.output)}`;
        }
        if (result.error) {
            this._host.post({ type: 'toolResult', id: msgId, tool: 'run_terminal', label: shortCmd, success: false, error: result.error });
            return `[run_terminal: ${tool.command}] ERROR: ${result.error}`;
        }

        const bgNote = result.backgroundProcessGroup &&
            this._trackBackgroundGroup(result.backgroundProcessGroup, tool.command)
            ? '\n(background processes started by this command are still running; the user can stop them from the status bar)'
            : '';
        const success = result.exitCode === 0;
        const changedNote = this._recordCommandChanges(treeBefore);
        const evidence = this._host.passport().recordCommand(tool.command, result.exitCode ?? null, result.output);
        // Once there are acceptance criteria, a check's result can be named as evidence for them
        const acceptance = this._host.passport().acceptance;
        const named = evidence && tool.verifies?.length ? acceptance.claimByCheck(tool.verifies, evidence, tool.command) : '';
        const evidenceNote = evidence && acceptance.criteria.length > 0 ? `\n(recorded as evidence ${evidence})${named ? `\n${named}` : ''}` : '';
        this._host.post({
            type: 'toolResult',
            id: msgId,
            tool: 'run_terminal',
            label: shortCmd,
            success,
            error: success ? undefined : `Exit ${result.exitCode}`,
        });
        return `[run_terminal: ${tool.command}]\nExit: ${result.exitCode}\n${clipTerminalOutput(result.output)}${bgNote}${sandbox.explain(result.output, result.exitCode)}${evidenceNote}${changedNote}`;
    }

    /** Files the command changed, recorded as changes of the turn (before its result counts as a check), and said to the agent. */
    private _recordCommandChanges(before: ReturnType<typeof treeState>): string {
        const after = before && treeState(before.root);
        if (!before || !after) { return ''; }
        const passport = this._host.passport();
        const changes = changesBetween(before, after, file => passport.textOf(file) ?? passport.textOf(path.join(before.root, file)));
        for (const change of changes) { passport.recordChange(change.path, change.before, change.after); }
        return changes.length ? `\n${COMMAND_CHANGED_FILES} ${changes.map(c => c.path).join(', ')}. Codico records and checks them like an edit; change files with edit_file or write_file instead, so each change is shown and reviewed.` : '';
    }

    private readonly _criteriaAsked = new WeakSet<object>(); // the turns already asked for their criteria (by their change report)

    /** At a turn's first code change with no acceptance criteria stated: ask for them now, so the checks that follow verify them, instead of at the end. */
    private _criteriaNote(filepath: string): string {
        const passport = this._host.passport();
        if (isDocumentationFile(filepath) || isTestFile(filepath) || passport.acceptance.criteria.length > 0 || this._criteriaAsked.has(passport)) { return ''; }
        this._criteriaAsked.add(passport); return `\n\n${CRITERIA_NOW}`;
    }

    /** Whether a command may run: asked on a card, unless allowed for the task or remembered. */
    async askToRun(command: string, msgId: string): Promise<boolean> {
        // After the agent has read external content this turn, Allow All no longer covers
        // commands: a prompt-injected page must not be able to run them unattended.
        const askAgain = this._host.approvals.allowAllCommands && !this._host.evaluationMode() && this._host.untrustedContentSeen();
        // A remembered command is not asked about, with the same exception
        const remembered = this._host.untrustedContentSeen() ? undefined : this._host.approvedCommands().allows(command);
        if ((this._host.approvals.allowAllCommands && !askAgain) || remembered) { return true; }
        return this._host.approvals.askCommand(permId => ({ type: 'terminalPermissionRequest', id: msgId, permId, command, rules: askAgain ? [] : this._host.approvedCommands().offer(permId, command),
            note: askAgain ? 'Asking again: the agent read web or MCP content in this turn, so Allow All does not cover commands.' : undefined }));
    }

    /** Records `pgid` if any process in that group is still alive. Returns true when tracked. */
    private _trackBackgroundGroup(pgid: number, command: string): boolean {
        if (!WorkspaceTools._groupAlive(pgid)) { return false; }
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
            if (!WorkspaceTools._groupAlive(pgid)) { this._bgProcesses.delete(pgid); changed = true; }
        }
        if (this._bgProcesses.size === 0 && this._bgPollTimer) {
            clearInterval(this._bgPollTimer);
            this._bgPollTimer = undefined;
        }
        if (changed) { this._postBackgroundProcesses(); }
    }

    killBackgroundProcesses(): void {
        for (const pgid of this._bgProcesses.keys()) {
            killProcessGroup(pgid, 'SIGTERM');
            setTimeout(() => killProcessGroup(pgid, 'SIGKILL'), 3_000);
        }
        this._bgProcesses.clear();
        if (this._bgPollTimer) { clearInterval(this._bgPollTimer); this._bgPollTimer = undefined; }
        this._postBackgroundProcesses();
    }

    private _postBackgroundProcesses(): void {
        this._host.post({
            type: 'backgroundProcesses',
            processes: [...this._bgProcesses.values()].map(p => ({ command: p.command, startedAt: p.startedAt })),
        });
    }

    async searchFiles(tool: SearchFilesTool, msgId: string): Promise<string> {
        const folders = toolFolders();
        if (!folders || folders.length === 0) {
            this._host.post({ type: 'toolResult', id: msgId, tool: 'search_files', label: tool.pattern, success: false, error: 'No workspace folder open' });
            return '[search_files] ERROR: No workspace folder open';
        }

        let matcher: RegExp | null = null;
        if (tool.isRegex) {
            try {
                matcher = new RegExp(tool.pattern);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this._host.post({ type: 'toolResult', id: msgId, tool: 'search_files', label: tool.pattern, success: false, error: message });
                return `[search_files: ${tool.pattern}] ERROR: Invalid regular expression: ${message}`;
            }
        }

        const include = tool.glob?.trim() || '**/*';
        const exclude = '**/{node_modules,.git,out,dist,coverage,.next,target}/**';
        const uris = await filterAllowedWorkspaceUris(await this._findFiles(include, exclude, 600));
        const scan = async (test: (line: string) => boolean): Promise<string[]> => {
            const found: string[] = [];
            for (const uri of uris) {
                if (found.length >= 1000) { break; }
                try {
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    if (bytes.byteLength > 1_000_000) { continue; }
                    const text = new TextDecoder().decode(bytes);
                    if (text.includes('\x00')) { continue; }
                    const rel = toolRelativePath(uri);
                    const lines = text.split('\n');
                    for (let i = 0; i < lines.length && found.length < 1000; i++) {
                        if (test(lines[i])) { found.push(`${rel}:${i + 1}:${lines[i].slice(0, 300)}`); }
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
        this._host.post({ type: 'toolResult', id: msgId, tool: 'search_files', label: `${label} — ${matches.length} matches`, success: true });
        return matches.length > 0
            ? `[search_files: ${label}]${note}\n${renderSearchMatches(matches, matches.length < 1000)}\nUse read_file start_line/end_line around the most relevant matches instead of reading large files whole.`
            : `[search_files: ${label}] No matches found${note}`;
    }

    async findFiles(tool: FindFilesTool, msgId: string): Promise<string> {
        try {
            const cleanPattern = tool.pattern.replace(/^\*\*\//, '');
            let include: string | vscode.RelativePattern = `**/${cleanPattern}`;
            const requestedDir = (tool.dirpath ?? '').trim();
            if (requestedDir && requestedDir !== '.') {
                const target = await resolveWorkspaceToolPath(requestedDir, true);
                const scopedPattern = target.relativePath
                    ? `${target.relativePath}/**/${cleanPattern}`
                    : `**/${cleanPattern}`;
                include = new vscode.RelativePattern(target.folder, scopedPattern);
            }

            const exclude = '**/{node_modules,.git,out,dist,coverage,.next,target}/**';
            const uris = await filterAllowedWorkspaceUris(await this._findFiles(include, exclude, 200));
            const result = uris.map(uri => toolRelativePath(uri));
            this._host.post({ type: 'toolResult', id: msgId, tool: 'find_files', label: `${tool.pattern} — ${result.length} file(s)`, success: true });
            return result.length > 0
                ? `[find_files: ${tool.pattern}]\n${result.join('\n')}${result.length >= 200 ? '\n… (truncated at 200)' : ''}`
                : `[find_files: ${tool.pattern}] No files found`;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this._host.post({ type: 'toolResult', id: msgId, tool: 'find_files', label: tool.pattern, success: false, error: message });
            return `[find_files: ${tool.pattern}] ERROR: ${message}`;
        }
    }

    async editFile(tool: EditFileTool, msgId: string): Promise<string> {
        try {
            const fileUri = (await resolveWorkspaceToolPath(tool.filepath)).uri;
            // Edits mode: a file can have a queued (unwritten) proposal. Build on it, or earlier
            // edits to the same file are lost and edits to a file created by write_file fail.
            const pending = this._host.editsMode() ? this._host.editProposals.pending(fileUri) : undefined;
            const bytes = pending ? pending.originalContent : await readCurrentBytes(fileUri);
            if (!pending && bytes === null) { throw new Error(`File not found: ${tool.filepath}`); }
            let rawContent = pending ? pending.proposedContent : new TextDecoder().decode(bytes!);

            // Normalize CRLF → LF for matching; oldStr from the parser is always LF-only.
            // Without this, edit_file fails with "old_str not found" on any CRLF file.
            let hasCRLF = rawContent.includes('\r\n');
            let content = hasCRLF ? rawContent.replace(/\r\n/g, '\n') : rawContent;

            // Line numbers copied along from a numbered read are not part of the file
            const bare = withoutCopiedLineNumbers(content, tool.oldStr, tool.newStr);
            tool = { ...tool, oldStr: bare.oldText, newStr: bare.newText };
            const resolved = resolveEditMatch(content, tool.oldStr);
            if (!resolved.match) {
                const err = resolved.error === 'ambiguous'
                    ? `old_str matches ${resolved.candidates}+ locations after safe normalization — provide more context`
                    : 'old_str not found, including safe whitespace-tolerant matching';
                this._host.post({ type: 'toolResult', id: msgId, tool: 'edit_file', label: tool.filepath, success: false, error: err });
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
            if (this._host.editsMode()) {
                this._host.editProposals.queue({ filepath: tool.filepath, uri: fileUri, originalContent: bytes, proposedContent: applyEdit(tool.newStr), label: `edit ${tool.filepath}` });
                this._host.post({ type: 'proposalQueued', filepath: tool.filepath });
                return `[edit_file: ${tool.filepath}] Queued as edit proposal`;
            }

            // Full-file diff gives the reviewer complete context (before → proposed file)
            const proposedLF = applyEditMatch(content, editMatch, tool.newStr);
            const editDiff = this._computeLineDiff(content, proposedLF);

            const editResult = await this._host.approvals.askWrite({ id: msgId, filepath: tool.filepath, diff: editDiff, editableContent: tool.newStr });
            if (!editResult.granted) {
                this._host.post({ type: 'toolResult', id: msgId, tool: 'edit_file', label: tool.filepath, success: false, error: 'Denied' });
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
                    this._host.post({ type: 'toolResult', id: msgId, tool: 'edit_file', label: tool.filepath, success: false, error: 'File changed while waiting for approval' });
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

            this._host.undo.push({ filepath: tool.filepath, uri: fileUri, before, after, label: `edit_file ${tool.filepath}` });
            this._host.post({ type: 'undoRedoState', ...this._host.undo.state });
            this._host.post({ type: 'toolResult', id: msgId, tool: 'edit_file', label: tool.filepath, success: true, diff: finalEditDiff });
            this._host.passport().recordChange(tool.filepath, rawContent, newContent);
            this._host.fileWritten();

            // Return a context window around the edited region so the model can
            // confirm the result without issuing a follow-up read_file call.
            const linesBefore = newContentLF.slice(0, editMatch.start).split('\n').length - 1;
            // Enough around the edit for the next nearby edit without reading the file again
            const snippet = editResultSnippet(newContentLF.split('\n'), linesBefore, effectiveNewStr.split('\n').length);
            const invariantAudit = buildLocalInvariantAudit(newContentLF, effectiveNewStr, tool.filepath, content);
            const matchNote = editMatch.mode === 'exact' ? '' : ` (${editMatch.mode} unique match)`;
            return `[edit_file: ${tool.filepath}] Edit applied successfully${matchNote}.\nResult (lines ${snippet.from}–${snippet.to}, numbered like read_file):\n\`\`\`\n${snippet.text}\n\`\`\`${invariantAudit}${this._criteriaNote(tool.filepath)}`;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this._host.post({ type: 'toolResult', id: msgId, tool: 'edit_file', label: tool.filepath, success: false, error: message });
            return `[edit_file: ${tool.filepath}] ERROR: ${message}`;
        }
    }

    /** The editor's file search, or for a team worker (a folder the editor has not opened) a walk of its folder. */
    private async _findFiles(include: string | vscode.RelativePattern, exclude: string, max: number): Promise<vscode.Uri[]> {
        const root = toolRoot();
        if (!root) { return vscode.workspace.findFiles(include, exclude, max); }
        const glob = typeof include === 'string' ? include : include.pattern;
        return findFilesInRoot(root, globToRegex(glob), /^(?:node_modules|\.git|out|dist|coverage|\.next|target)$/, max);
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
}
