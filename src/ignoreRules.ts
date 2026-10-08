/**
 * Workspace ignore rules.
 *
 * .codicoignore is the Codico security boundary for agent-visible files.
 * .copilotignore remains supported as a compatibility source. Rules are loaded
 * per workspace folder so multi-root workspaces do not share exclusions.
 */

import * as vscode from 'vscode';
import * as path from 'path';

interface CompiledRule {
    negate: boolean;
    anchored: boolean;
    re: RegExp;
}

function _globToRegex(glob: string): RegExp {
    let s = glob.replace(/[.+^$\{\}()|[\]\\]/g, '\\$&');
    s = s.replace(/\*\*/g, '\x00');
    s = s.replace(/\*/g, '[^/]*');
    s = s.replace(/\?/g, '[^/]');
    s = s.replace(/\x00\//g, '(?:.+/)?').replace(/\x00/g, '.*');
    return new RegExp('^' + s + '$', 'i');
}

function _compile(raw: string): CompiledRule | null {
    let line = raw.trim();
    if (!line || line.startsWith('#')) { return null; }

    const negate = line.startsWith('!');
    if (negate) { line = line.slice(1); }
    if (line.endsWith('/')) { line = line.slice(0, -1); }

    const anchored = line.startsWith('/');
    if (anchored) { line = line.slice(1); }

    let re: RegExp;
    if (anchored) {
        const base = _globToRegex(line);
        re = new RegExp(base.source.replace(/\$$/, '(?:\\/.*)?$'), 'i');
    } else {
        re = _globToRegex('**/' + line);
    }
    return { negate, anchored, re };
}

export class IgnoreRules {
    private readonly _rulesByFolder = new Map<string, CompiledRule[]>();
    private readonly _loadedFolders = new Set<string>();

    private _key(folder: vscode.WorkspaceFolder): string {
        return folder.uri.toString();
    }

    private async _readRules(folder: vscode.WorkspaceFolder, filename: string): Promise<CompiledRule[]> {
        try {
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, filename));
            return new TextDecoder().decode(bytes)
                .split(/\r?\n/)
                .map(_compile)
                .filter((rule): rule is CompiledRule => rule !== null);
        } catch {
            return [];
        }
    }

    async load(folder?: vscode.WorkspaceFolder): Promise<void> {
        const folders = folder ? [folder] : (vscode.workspace.workspaceFolders ?? []);
        for (const current of folders) {
            const legacy = await this._readRules(current, '.copilotignore');
            const codico = await this._readRules(current, '.codicoignore');
            this._rulesByFolder.set(this._key(current), [...legacy, ...codico]);
            this._loadedFolders.add(this._key(current));
        }
    }

    async ensureLoaded(folder: vscode.WorkspaceFolder): Promise<void> {
        if (!this._loadedFolders.has(this._key(folder))) {
            await this.load(folder);
        }
    }

    shouldIgnore(relativePath: string, folder?: vscode.WorkspaceFolder): boolean {
        const current = folder ?? vscode.workspace.workspaceFolders?.[0];
        if (!current) { return false; }
        const rules = this._rulesByFolder.get(this._key(current)) ?? [];
        const rel = relativePath.split(path.sep).join('/').replace(/^\.\//, '');
        let ignored = false;
        for (const rule of rules) {
            if (rule.re.test(rel)) {
                ignored = !rule.negate;
            }
        }
        return ignored;
    }

    isLoadedFor(folder: vscode.WorkspaceFolder): boolean {
        return this._loadedFolders.has(this._key(folder));
    }

    get isLoaded(): boolean {
        const folders = vscode.workspace.workspaceFolders ?? [];
        return folders.length > 0 && folders.every(folder => this.isLoadedFor(folder));
    }
}

export const ignoreRules = new IgnoreRules();

export function watchIgnoreFile(context: vscode.ExtensionContext): void {
    void ignoreRules.load();

    for (const pattern of ['**/.codicoignore', '**/.copilotignore']) {
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        watcher.onDidChange(() => void ignoreRules.load());
        watcher.onDidCreate(() => void ignoreRules.load());
        watcher.onDidDelete(() => void ignoreRules.load());
        context.subscriptions.push(watcher);
    }
}
