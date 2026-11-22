/**
 * Workspace ignore rules.
 *
 * .codicoignore is the Codico security boundary for agent-visible files.
 * .copilotignore remains supported as a compatibility source. Rules are loaded
 * per workspace folder so multi-root workspaces do not share exclusions.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { extraRuleFolders, toolFolders } from './toolRoot';
import { CompiledRule, compileIgnoreRules, ignoredByRules } from './ignorePattern';
export { globToRegex } from './ignorePattern';

export class IgnoreRules {
    private readonly _rulesByFolder = new Map<string, CompiledRule[]>();
    private readonly _loadedFolders = new Set<string>();

    private _key(folder: vscode.WorkspaceFolder): string {
        return folder.uri.toString();
    }

    private async _readRules(folder: vscode.WorkspaceFolder, filename: string): Promise<CompiledRule[]> {
        try {
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, filename));
            return compileIgnoreRules(new TextDecoder().decode(bytes));
        } catch {
            return [];
        }
    }

    async load(folder?: vscode.WorkspaceFolder): Promise<void> {
        const folders = folder ? [folder] : (vscode.workspace.workspaceFolders ?? []);
        for (const current of folders) {
            const legacy = await this._readRules(current, '.copilotignore');
            const codico = await this._readRules(current, '.codicoignore');
            // A worker's worktree: the workspace's rules apply too, committed or not
            const inherited: CompiledRule[] = [];
            for (const other of extraRuleFolders(current)) { inherited.push(...await this._readRules(other, '.copilotignore'), ...await this._readRules(other, '.codicoignore')); }
            this._rulesByFolder.set(this._key(current), [...inherited, ...legacy, ...codico]);
            this._loadedFolders.add(this._key(current));
        }
    }

    async ensureLoaded(folder: vscode.WorkspaceFolder): Promise<void> {
        if (!this._loadedFolders.has(this._key(folder))) {
            await this.load(folder);
        }
    }

    shouldIgnore(relativePath: string, folder?: vscode.WorkspaceFolder): boolean {
        const current = folder ?? toolFolders()?.[0];
        if (!current) { return false; }
        const rules = this._rulesByFolder.get(this._key(current)) ?? [];
        const rel = relativePath.split(path.sep).join('/').replace(/^\.\//, '');
        return ignoredByRules(rules, rel);
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
