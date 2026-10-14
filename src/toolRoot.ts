import { AsyncLocalStorage } from 'async_hooks';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * The folder the agent's tools work in. Normally the workspace; a team worker running in
 * this window works in its own git worktree instead. The worker's whole run (its requests,
 * tool calls and everything they start) carries its folder, so the path checks, reads,
 * writes, searches and commands it makes all resolve inside that folder, with no tool
 * having to be told.
 */
interface ToolRoot {
    folder: vscode.WorkspaceFolder;
    /** The workspace's own folder: its .codicoignore rules apply in the worktree too. */
    rulesFrom?: vscode.WorkspaceFolder;
}

const storage = new AsyncLocalStorage<ToolRoot>();

/** Runs `fn` with the tools working in `root` (an absolute folder outside the workspace). */
export function runInToolRoot<T>(root: string, fn: () => T): T {
    const folder: vscode.WorkspaceFolder = { uri: vscode.Uri.file(root), name: path.basename(root), index: 0 };
    return storage.run({ folder, rulesFrom: vscode.workspace.workspaceFolders?.[0] }, fn);
}

/** The worker's folder, when the code runs on a worker's behalf. */
export function toolRoot(): vscode.WorkspaceFolder | undefined { return storage.getStore()?.folder; }

/** Folders whose ignore rules also apply to `folder` (the workspace's, for a worker's worktree). */
export function extraRuleFolders(folder: vscode.WorkspaceFolder): vscode.WorkspaceFolder[] {
    const current = storage.getStore();
    return current && current.rulesFrom && current.folder.uri.toString() === folder.uri.toString() ? [current.rulesFrom] : [];
}

/** The folders the tools may reach: the worker's alone, or the workspace's. */
export function toolFolders(): readonly vscode.WorkspaceFolder[] | undefined {
    const root = toolRoot();
    return root ? [root] : vscode.workspace.workspaceFolders;
}

/** The tool folder that holds `uri`, if any. */
export function toolFolderOf(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    const root = toolRoot();
    if (!root) { return vscode.workspace.getWorkspaceFolder(uri); }
    const inside = path.relative(root.uri.fsPath, uri.fsPath);
    return inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside)) ? root : undefined;
}

/** A path as the agent writes it: relative to its folder. */
export function toolRelativePath(uri: vscode.Uri): string {
    const root = toolRoot();
    return root ? path.relative(root.uri.fsPath, uri.fsPath).split(path.sep).join('/') : vscode.workspace.asRelativePath(uri);
}

/**
 * Files under the worker's folder matching `include`, as the editor's findFiles would find
 * them in the workspace (which it cannot do for a folder it has not opened).
 */
export async function findFilesInRoot(root: vscode.WorkspaceFolder, include: RegExp, skipDir: RegExp, max: number): Promise<vscode.Uri[]> {
    const found: vscode.Uri[] = [];
    const walk = async (dir: string): Promise<void> => {
        let entries: fs.Dirent[];
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (found.length >= max) { return; }
            const full = path.join(dir, entry.name);
            const rel = path.relative(root.uri.fsPath, full).split(path.sep).join('/');
            // Symbolic links are not followed: they could lead out of the folder
            if (entry.isDirectory()) { if (!skipDir.test(entry.name)) { await walk(full); } }
            else if (entry.isFile() && include.test(rel)) { found.push(vscode.Uri.file(full)); }
        }
    };
    await walk(root.uri.fsPath);
    return found;
}
