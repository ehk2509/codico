/**
 * .copilotignore — file exclusion rules
 *
 * Reads `.copilotignore` from the workspace root (same gitignore-style syntax).
 * Exposes `shouldIgnore(relativePath)` used by:
 *   - WorkspaceIndex (skip ignored files during indexing)
 *   - agentProvider._buildContextPreamble (skip open tabs)
 *   - inlineCompletionProvider (skip ignored documents)
 */

import * as vscode from 'vscode';
import * as path from 'path';

// ── Minimal gitignore-style pattern matcher ───────────────────────────────────

interface CompiledRule {
    negate: boolean;
    /** If set, only match at root of workspace (pattern started with /) */
    anchored: boolean;
    /** Regex compiled from the glob pattern. */
    re: RegExp;
}

function _globToRegex(glob: string): RegExp {
    // Escape regex specials except * and ?
    let s = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    // **  →  match any path segment sequence
    s = s.replace(/\*\*/g, '\x00');
    // *   →  match within a single segment
    s = s.replace(/\*/g, '[^/]*');
    // ?   →  match single char except /
    s = s.replace(/\?/g, '[^/]');
    // restore **: **/  (followed by /) → optional path prefix; bare ** → any sequence
    s = s.replace(/\x00\//g, '(?:.+/)?').replace(/\x00/g, '.*');
    return new RegExp(`^${s}$`, 'i');
}

function _compile(raw: string): CompiledRule | null {
    let line = raw.trim();
    if (!line || line.startsWith('#')) { return null; }

    const negate = line.startsWith('!');
    if (negate) { line = line.slice(1); }

    // Trailing slash → match directories; for our purposes treat same as file
    if (line.endsWith('/')) { line = line.slice(0, -1); }

    const anchored = line.startsWith('/');
    if (anchored) { line = line.slice(1); }

    // If not anchored, prepend **/ so the pattern matches anywhere in the path.
    // If anchored, also match any entry under that path (e.g. /dist matches dist/bundle.js).
    let re: RegExp;
    if (anchored) {
        const base = _globToRegex(line);
        // Replace the trailing $ anchor with an optional trailing path so /dist also
        // matches dist/sub/file — same semantics as gitignore directory patterns.
        re = new RegExp(base.source.replace(/\$$/, '(?:\\/.*)?$'), 'i');
    } else {
        re = _globToRegex(`**/${line}`);
    }
    return { negate, anchored, re };
}

// ── IgnoreRules ───────────────────────────────────────────────────────────────

export class IgnoreRules {
    private _rules: CompiledRule[] = [];
    private _loaded = false;

    /** Load (or reload) rules from `.copilotignore` in the workspace root. */
    async load(): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) { return; }

        const uri = vscode.Uri.joinPath(folders[0].uri, '.copilotignore');
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text  = new TextDecoder().decode(bytes);
            this._rules = text
                .split(/\r?\n/)
                .map(_compile)
                .filter((r): r is CompiledRule => r !== null);
            this._loaded = true;
        } catch {
            // File doesn't exist → no rules
            this._rules = [];
            this._loaded = true;
        }
    }

    /**
     * Returns true if the given workspace-relative path should be excluded.
     * @param relativePath forward-slash-separated path relative to workspace root
     */
    shouldIgnore(relativePath: string): boolean {
        if (!this._loaded || this._rules.length === 0) { return false; }

        // Normalise separators
        const rel = relativePath.split(path.sep).join('/');
        let ignored = false;

        for (const rule of this._rules) {
            if (rule.re.test(rel)) {
                ignored = !rule.negate;
            }
        }
        return ignored;
    }

    get isLoaded(): boolean { return this._loaded; }
}

// ── Singleton used across providers ──────────────────────────────────────────

export const ignoreRules = new IgnoreRules();

/**
 * Watch `.copilotignore` for changes and reload automatically.
 */
export function watchIgnoreFile(context: vscode.ExtensionContext): void {
    // Initial load
    void ignoreRules.load();

    const watcher = vscode.workspace.createFileSystemWatcher('**/.copilotignore');
    watcher.onDidChange(() => void ignoreRules.load());
    watcher.onDidCreate(() => void ignoreRules.load());
    watcher.onDidDelete(() => void ignoreRules.load());
    context.subscriptions.push(watcher);
}
