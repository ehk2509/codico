import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { bestLines, CodeIndex, renderSearchResults, RenderedHit, tokenize } from './codeSearch';
import { ignoreRules } from './ignoreRules';
import { resolveWorkspaceToolPath } from './workspaceSecurity';

/**
 * The workspace's local code search: builds the index the first time it is asked, keeps it
 * current as files change, and renders results for the agent's search_code tool. Nothing
 * leaves the machine and no key is needed.
 */

const DEFAULT_MAX_FILES = 5000;
/** A file larger than this is generated, minified or data: not worth indexing. */
const MAX_FILE_BYTES = 200_000;
/** Text indexed in total; the index takes roughly two to three times this in memory. */
const MAX_TOTAL_CHARS = 30_000_000;
const READ_CONCURRENCY = 24;
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.next', '__pycache__', '.venv', 'venv', 'build', 'coverage', '.nyc_output', '.cache', '.turbo', '.svelte-kit', 'target', 'vendor']);
const SKIP_FILE_RE = /\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|otf|map|lock|bin|exe|dll|so|dylib|zip|tar|gz|7z|rar|pdf|docx?|xlsx?|mp[34]|avi|mov|mkv|pyc|pyo|min\.js|min\.css|snap|vsix)$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|(?:^|\/)\.env(?:\.[^/]*)?$|\.(?:pem|key|p12|pfx|keystore|jks)$|(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)[^/]*$/i;

export class CodeSearchService {
    private _index: CodeIndex | undefined;
    private _building: Promise<CodeIndex> | undefined;
    /** Files changed or removed since they were indexed, applied before the next search. */
    private readonly _pending = new Map<string, vscode.Uri | null>();
    private _note = '';

    /** A file was created or saved. */
    changed(uri: vscode.Uri): void { if (this._index) { this._pending.set(this._relative(uri), uri); } }
    /** A file the agent has just written, by its workspace-relative path. */
    changedPath(relativePath: string): void {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (this._index && root && !path.isAbsolute(relativePath)) { this._pending.set(relativePath.split(path.sep).join('/').replace(/^\.\//, ''), vscode.Uri.joinPath(root, relativePath)); }
    }
    /** A file was deleted. */
    removed(uri: vscode.Uri): void { if (this._index) { this._pending.set(this._relative(uri), null); } }
    /** Forget the index (the workspace folders changed): it is rebuilt on the next search. */
    reset(): void { this._index = undefined; this._building = undefined; this._pending.clear(); }

    private _relative(uri: vscode.Uri): string { return vscode.workspace.asRelativePath(uri, false).split(path.sep).join('/'); }

    /** Runs the search_code tool and never throws: a failure is the tool's result. */
    async run(tool: { query: string; path?: string; maxResults?: number }, signal?: AbortSignal): Promise<{ text: string; label: string; success: boolean; error?: string }> {
        const label = `${tool.query.slice(0, 70)}${tool.path ? ` in ${tool.path}` : ''}`;
        try {
            const found = await this.search(tool.query, tool.maxResults ?? 8, tool.path ?? '', signal);
            return { text: found.text, label: `${label} \u2014 ${found.results} result${found.results === 1 ? '' : 's'}`, success: true };
        } catch (err) {
            return { text: `[search_code: ${tool.query}] ERROR: ${err instanceof Error ? err.message : String(err)}. Use search_files instead.`, label, success: false, error: 'Search failed' };
        }
    }

    /** The search_code tool: the best-matching chunks, with a few lines of each and who uses them. */
    async search(query: string, limit: number, pathPrefix: string, signal?: AbortSignal): Promise<{ text: string; results: number }> {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!root) { return { text: `[search_code: ${query}] ERROR: no folder is open.`, results: 0 }; }
        if (!query.trim()) { return { text: '[search_code] ERROR: give a query: a few words or identifiers describing what you are looking for.', results: 0 }; }
        const index = await this._ready(root, signal);
        await this._applyPending(index);
        const prefix = pathPrefix.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\*+.*$/, '');
        const hits = index.search(query, Math.min(20, Math.max(1, limit)), prefix);
        const terms = tokenize(query);
        const rendered: RenderedHit[] = [];
        for (const [position, hit] of hits.entries()) {
            // Removed or no longer readable since it was indexed: shown without lines
            const lines = (await this._read(hit.file))?.split('\n') ?? [];
            rendered.push({
                ...hit,
                lines: bestLines(lines, hit, terms).map(line => ({ number: line + 1, text: lines[line] })),
                // Who depends on it matters for the first results; computing it for all would be noise
                usedBy: position < 3 ? index.importersOf(hit.file) : [],
            });
        }
        return { text: renderSearchResults(query, rendered, index.fileCount, this._note + (prefix ? `, under ${prefix}` : '')), results: rendered.length };
    }

    private _ready(root: vscode.Uri, signal?: AbortSignal): Promise<CodeIndex> {
        if (this._index) { return Promise.resolve(this._index); }
        this._building ??= this._build(root, signal).then(index => { this._index = index; this._building = undefined; return index; }, err => { this._building = undefined; throw err; });
        return this._building;
    }

    private async _build(root: vscode.Uri, signal?: AbortSignal): Promise<CodeIndex> {
        const maxFiles = Math.max(100, vscode.workspace.getConfiguration('codico').get<number>('codeSearchMaxFiles', DEFAULT_MAX_FILES));
        const listed = (await this._listFiles(root)).filter(file => !SKIP_FILE_RE.test(file) && !ignoreRules.shouldIgnore(file));
        const files = listed.slice(0, maxFiles);
        const index = new CodeIndex();
        let chars = 0;
        let full = false;
        for (let at = 0; at < files.length && !full && !signal?.aborted; at += READ_CONCURRENCY) {
            const batch = files.slice(at, at + READ_CONCURRENCY);
            const texts = await Promise.all(batch.map(file => this._read(file)));
            batch.forEach((file, i) => {
                const text = texts[i];
                if (text === undefined || full) { return; }
                if (chars + text.length > MAX_TOTAL_CHARS) { full = true; return; }
                chars += text.length;
                index.addFile(file, text);
            });
        }
        this._note = full ? ` (the index is full at ${index.fileCount.toLocaleString('en-US')} of ${listed.length.toLocaleString('en-US')} files)`
            : listed.length > files.length ? ` (the first ${files.length.toLocaleString('en-US')} of ${listed.length.toLocaleString('en-US')} files; raise codico.codeSearchMaxFiles for more)` : '';
        return index;
    }

    /**
     * Text of a file worth indexing; undefined for one that is missing, too large or binary,
     * and for one the agent's own file tools would refuse: excluded by .codicoignore, or reached
     * through a symbolic link that leads outside the workspace.
     */
    private async _read(file: string): Promise<string | undefined> {
        try {
            const bytes = await vscode.workspace.fs.readFile((await resolveWorkspaceToolPath(file)).uri);
            if (bytes.byteLength > MAX_FILE_BYTES) { return undefined; }
            const text = new TextDecoder().decode(bytes);
            return text.includes('\x00') ? undefined : text;
        } catch { return undefined; }
    }

    private async _applyPending(index: CodeIndex): Promise<void> {
        if (this._pending.size === 0) { return; }
        const pending = [...this._pending.entries()];
        this._pending.clear();
        for (const [file, uri] of pending) {
            const text = uri && !SKIP_FILE_RE.test(file) && !file.split('/').some(part => SKIP_DIRS.has(part)) ? await this._read(file) : undefined;
            if (text === undefined) { index.removeFile(file); } else { index.addFile(file, text); }
        }
        // Replaced entries stay in the index until it is rebuilt: do that once they are a third of it
        if (index.staleShare > 0.33) { this.reset(); }
    }

    /** The workspace's files: what git tracks or would track (so .gitignore is honoured), else a walk of the folder. */
    private async _listFiles(root: vscode.Uri): Promise<string[]> {
        if (root.scheme === 'file') {
            const listed = await new Promise<string[] | undefined>(resolve => {
                cp.execFile('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root.fsPath, maxBuffer: 64 * 1024 * 1024, timeout: 20_000, windowsHide: true },
                    (err, stdout) => resolve(err ? undefined : String(stdout).split('\0').filter(Boolean)));
            });
            if (listed && listed.length > 0) { return listed.filter(file => !file.split('/').some(part => SKIP_DIRS.has(part))); }
        }
        const out: string[] = [];
        const walk = async (rel: string, depth: number): Promise<void> => {
            if (depth > 12 || out.length > 200_000) { return; }
            let entries: Array<[string, vscode.FileType]>;
            try { entries = await vscode.workspace.fs.readDirectory(rel ? vscode.Uri.joinPath(root, rel) : root); } catch { return; }
            for (const [name, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
                const child = rel ? `${rel}/${name}` : name;
                // A link is not followed: it may lead out of the workspace
                if ((type & vscode.FileType.SymbolicLink) !== 0) { continue; }
                if ((type & vscode.FileType.Directory) !== 0) { if (!SKIP_DIRS.has(name) && !name.startsWith('.')) { await walk(child, depth + 1); } }
                else if ((type & vscode.FileType.File) !== 0) { out.push(child); }
            }
        };
        await walk('', 0);
        return out;
    }
}
