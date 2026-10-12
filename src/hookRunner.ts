import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Hook, hookCommandLine, hookFingerprint, hookInput, hookLabel, hooksFor, hookSubject, HOOKS_TEMPLATE, parseHooks, refusalText, reportText, toolOutcome } from './hooks';
import { buildTerminalEnvironment, runTerminalProcess } from './terminalProcess';
import { ToolCall } from './toolParser';
import { resolveWorkspaceToolPath } from './workspaceSecurity';

const HOOKS_FILE = '.codico/hooks.json';
/** Hooks the user allowed for this workspace, by fingerprint. */
export const APPROVED_HOOKS_KEY = 'codico.approvedHooks.v1';

/**
 * Runs a project's lifecycle hooks around the agent's tool calls. A hook is a command from
 * a file in the repository, so it runs only in a trusted workspace and only after the user
 * has allowed that exact command once.
 */
export class HookRunner implements vscode.Disposable {
    private readonly _loaded = new Map<string, Promise<Hook[]>>();
    /** Asked and not allowed in this session: not asked again on every tool call. */
    private readonly _declined = new Set<string>();
    private _reported = '';
    private readonly _watcher: vscode.FileSystemWatcher;

    /** @param _autoApprove automated tests have nobody to ask */
    constructor(private readonly _state: () => vscode.Memento, private readonly _autoApprove: () => boolean = () => false) {
        this._watcher = vscode.workspace.createFileSystemWatcher(`**/${HOOKS_FILE}`);
        const reload = (): void => { this._loaded.clear(); };
        this._watcher.onDidChange(reload);
        this._watcher.onDidCreate(reload);
        this._watcher.onDidDelete(reload);
    }

    dispose(): void { this._watcher.dispose(); }

    /**
     * Runs the "before" hooks of a tool call.
     * @returns the tool result that refuses the call, or '' when it may go ahead
     */
    async before(tool: ToolCall, signal: AbortSignal): Promise<string> {
        const subject = hookSubject(tool);
        if (!subject) { return ''; }
        const context = await this._context(tool);
        for (const hook of hooksFor(context.hooks, subject.before, subject.kind, subject.subject)) {
            if (signal.aborted || !await this._allowed(hook)) { continue; }
            const outcome = await this._run(hook, tool, context.root, subject.subject, signal, {});
            if (signal.aborted) { return ''; }
            if (outcome.exitCode !== 0 || outcome.timedOut) { return refusalText(tool, hook, outcome); }
        }
        return '';
    }

    /** Runs the "after" hooks of a tool call that succeeded; returns what they add to its result. */
    async after(tool: ToolCall, result: string, signal: AbortSignal): Promise<string> {
        const subject = hookSubject(tool);
        if (!subject) { return ''; }
        const done = toolOutcome(tool, result);
        if (!done.succeeded) { return ''; }
        const context = await this._context(tool);
        let added = '';
        for (const hook of hooksFor(context.hooks, subject.after, subject.kind, subject.subject)) {
            if (signal.aborted || !await this._allowed(hook)) { continue; }
            added += reportText(hook, await this._run(hook, tool, context.root, subject.subject, signal, { exitCode: done.exitCode, output: tool.type === 'run_terminal' ? result.slice(-8000) : undefined }));
        }
        return added;
    }

    /** The hooks that apply to a tool call: those of the folder the file is in (the first folder for commands). */
    private async _context(tool: ToolCall): Promise<{ hooks: Hook[]; root: vscode.Uri | undefined }> {
        if (!vscode.workspace.isTrusted) { return { hooks: [], root: undefined }; }
        let folder = vscode.workspace.workspaceFolders?.[0];
        if (tool.type === 'write_file' || tool.type === 'edit_file') {
            // A path the file tools would refuse gets no hook: the tool reports it
            try { folder = (await resolveWorkspaceToolPath(tool.filepath)).folder; } catch { return { hooks: [], root: undefined }; }
        }
        if (!folder) { return { hooks: [], root: undefined }; }
        const key = folder.uri.toString();
        let hooks = this._loaded.get(key);
        if (!hooks) { hooks = this._load(folder); this._loaded.set(key, hooks); }
        return { hooks: await hooks, root: folder.uri };
    }

    private async _load(folder: vscode.WorkspaceFolder): Promise<Hook[]> {
        let text: string;
        try { text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, HOOKS_FILE))); } catch { return []; }
        const { hooks, problems } = parseHooks(text);
        const report = problems.join('\n');
        if (report && report !== this._reported) {
            this._reported = report;
            void vscode.window.showWarningMessage(`Codico: ${HOOKS_FILE} has a problem, so part of it is not used: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`);
        }
        return hooks;
    }

    private async _allowed(hook: Hook): Promise<boolean> {
        if (this._autoApprove()) { return true; }
        const fingerprint = hookFingerprint(hook);
        const approved = this._state().get<Record<string, true>>(APPROVED_HOOKS_KEY, {});
        if (approved[fingerprint]) { return true; }
        if (this._declined.has(fingerprint)) { return false; }
        const allow = 'Allow for This Workspace';
        const choice = await vscode.window.showWarningMessage(
            `This project wants Codico to run a command as a ${hook.event} hook.`,
            {
                modal: true,
                detail: `${hook.name ? `${hook.name}\n\n` : ''}Command:\n    ${hook.command}\n\n${hook.match ? `For: ${hook.match}\n\n` : ''}` +
                    `It comes from ${HOOKS_FILE} in this project and will run without asking again, with your user's access, each time the agent ${hook.event.endsWith('Edit') ? 'edits a matching file' : 'runs a matching command'}. Only allow commands you trust.`,
            },
            allow,
        );
        if (choice !== allow) { this._declined.add(fingerprint); return false; }
        approved[fingerprint] = true;
        await this._state().update(APPROVED_HOOKS_KEY, approved);
        return true;
    }

    private async _run(hook: Hook, tool: ToolCall, root: vscode.Uri | undefined, subject: string, signal: AbortSignal, extra: { exitCode?: number; output?: string }): Promise<{ exitCode: number; timedOut: boolean; output: string }> {
        const input = hookInput(hook, tool, extra);
        // The full tool call (file content included) is too large for the environment: it goes in a file
        const inputFile = path.join(os.tmpdir(), `codico-hook-${crypto.randomBytes(8).toString('hex')}.json`);
        try {
            fs.writeFileSync(inputFile, JSON.stringify(input.json), { mode: 0o600 });
            const result = await runTerminalProcess({
                command: hookCommandLine(hook, subject),
                cwd: root?.scheme === 'file' ? root.fsPath : undefined,
                timeoutMs: hook.timeoutSeconds * 1000,
                signal,
                env: { ...buildTerminalEnvironment(), ...input.env, CODICO_HOOK_INPUT: inputFile },
            });
            return { exitCode: result.error ? 127 : result.exitCode, timedOut: result.timedOut, output: result.error ? `${hookLabel(hook)}: ${result.error}` : result.output };
        } catch (err) {
            return { exitCode: 127, timedOut: false, output: `The hook could not be started: ${err instanceof Error ? err.message : String(err)}` };
        } finally {
            fs.rm(inputFile, { force: true }, () => { /* a leftover temp file is harmless */ });
        }
    }
}

/** "Codico: New Hooks File": writes a starting `.codico/hooks.json` and opens it. */
export async function createHooksFile(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) { void vscode.window.showErrorMessage('Open a folder first: hooks belong to a project.'); return; }
    const file = vscode.Uri.joinPath(root, HOOKS_FILE);
    let exists = true;
    try { await vscode.workspace.fs.stat(file); } catch { exists = false; }
    if (!exists) { await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(HOOKS_TEMPLATE)); }
    await vscode.window.showTextDocument(file);
}
