import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ignoreRules } from './ignoreRules';

export interface WorkspaceToolTarget {
    folder: vscode.WorkspaceFolder;
    relativePath: string;
    uri: vscode.Uri;
}

function slash(value: string): string {
    return value.replace(/\\/g, '/');
}

function workspaceFolders(): readonly vscode.WorkspaceFolder[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        throw new Error('No workspace folder open');
    }
    return folders;
}

function selectFolderAndRelativePath(rawPath: string, allowRoot: boolean): {
    folder: vscode.WorkspaceFolder;
    relativePath: string;
} {
    const folders = workspaceFolders();
    let raw = slash(rawPath.trim());
    if (allowRoot && (raw === '' || raw === '.')) {
        return { folder: folders[0], relativePath: '' };
    }

    for (const folder of folders) {
        const root = slash(folder.uri.fsPath).replace(/\/+$/, '');
        if (raw === root || raw.startsWith(root + '/')) {
            raw = raw === root ? '' : raw.slice(root.length + 1);
            return { folder, relativePath: raw };
        }
    }

    raw = raw.replace(/^\/+/, '');
    if (folders.length > 1) {
        const slashIndex = raw.indexOf('/');
        const firstSegment = slashIndex >= 0 ? raw.slice(0, slashIndex) : raw;
        const named = folders.find(folder => folder.name === firstSegment);
        if (named) {
            return {
                folder: named,
                relativePath: slashIndex >= 0 ? raw.slice(slashIndex + 1) : '',
            };
        }
    }

    return { folder: folders[0], relativePath: raw };
}

function normalizeRelativePath(relativePath: string, allowRoot: boolean): string {
    if (relativePath.includes('\0')) {
        throw new Error('Unsafe path rejected');
    }
    const normalized = path.posix.normalize(relativePath || '.');
    if (normalized === '.') {
        if (allowRoot) { return ''; }
        throw new Error('Workspace file path is required');
    }
    if (
        normalized === '..' ||
        normalized.startsWith('../') ||
        path.posix.isAbsolute(normalized) ||
        /^[A-Za-z]:\//.test(normalized)
    ) {
        throw new Error('Unsafe path rejected');
    }
    return normalized.replace(/^\.\//, '');
}

export async function resolveWorkspaceToolPath(
    rawPath: string,
    allowRoot = false,
): Promise<WorkspaceToolTarget> {
    const selected = selectFolderAndRelativePath(rawPath, allowRoot);
    const relativePath = normalizeRelativePath(selected.relativePath, allowRoot);
    await ignoreRules.ensureLoaded(selected.folder);

    if (relativePath && ignoreRules.shouldIgnore(relativePath, selected.folder)) {
        throw new Error('Path excluded by .codicoignore: ' + relativePath);
    }

    const uri = relativePath ? vscode.Uri.joinPath(selected.folder.uri, relativePath) : selected.folder.uri;
    await assertNoSymlinkEscape(selected.folder, uri, relativePath);
    return { folder: selected.folder, relativePath, uri };
}

/**
 * The path text stays inside the folder, but a symbolic link on the way (a repo's
 * `docs -> ~/.ssh`) could still lead outside it. The deepest existing part of the
 * path is resolved, since write_file targets may not exist yet.
 */
async function assertNoSymlinkEscape(folder: vscode.WorkspaceFolder, uri: vscode.Uri, relativePath: string): Promise<void> {
    if (uri.scheme !== 'file' || !relativePath) { return; }
    const root = await fs.promises.realpath(folder.uri.fsPath).catch(() => folder.uri.fsPath);
    let probe = uri.fsPath;
    let rest = '';
    for (;;) {
        try {
            const resolved = path.join(await fs.promises.realpath(probe), rest);
            const inside = path.relative(root, resolved);
            if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) {
                throw new Error('Unsafe path rejected: it leads outside the workspace through a symbolic link: ' + relativePath);
            }
            return;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') { throw err; }
            // A dangling link: writing through it would create its (unchecked) target
            if ((await fs.promises.lstat(probe).catch(() => null))?.isSymbolicLink()) {
                throw new Error('Unsafe path rejected: it is a symbolic link to a missing target: ' + relativePath);
            }
            const parent = path.dirname(probe);
            if (parent === probe) { return; }
            rest = path.join(path.basename(probe), rest);
            probe = parent;
        }
    }
}

export async function isWorkspaceUriAllowed(uri: vscode.Uri): Promise<boolean> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) { return false; }
    await ignoreRules.ensureLoaded(folder);
    const relativePath = slash(path.relative(folder.uri.fsPath, uri.fsPath));
    if (
        !relativePath ||
        relativePath === '.' ||
        relativePath === '..' ||
        relativePath.startsWith('../') ||
        path.isAbsolute(relativePath)
    ) {
        return relativePath === '' || relativePath === '.';
    }
    return !ignoreRules.shouldIgnore(relativePath, folder);
}

export async function filterAllowedWorkspaceUris(uris: readonly vscode.Uri[]): Promise<vscode.Uri[]> {
    const allowed: vscode.Uri[] = [];
    for (const uri of uris) {
        if (await isWorkspaceUriAllowed(uri)) {
            allowed.push(uri);
        }
    }
    return allowed;
}

export function isIgnoredDirectoryEntry(target: WorkspaceToolTarget, name: string): boolean {
    const relativePath = target.relativePath ? target.relativePath + '/' + name : name;
    return ignoreRules.shouldIgnore(relativePath, target.folder);
}
