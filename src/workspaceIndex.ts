import * as vscode from 'vscode';
import * as https from 'https';
import * as path from 'path';
import * as crypto from 'crypto';
import { ignoreRules } from './ignoreRules';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IndexChunk {
    /** Workspace-relative file path. */
    file: string;
    /** 1-based start line of this chunk. */
    startLine: number;
    /** Text content (with a file+line header for context quality). */
    text: string;
    /** Embedding vector — present only after embeddings have been computed. */
    vector?: number[];
}

export interface IndexStatus {
    chunkCount: number;
    fileCount: number;
    hasVectors: boolean;
    /** Milliseconds since last full index build (Infinity if never built). */
    ageMs: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CHUNK_LINES   = 60;
const CHUNK_OVERLAP = 10;
const MAX_FILES     = 600;
const MAX_FILE_BYTES = 200_000;
const EMBED_BATCH   = 32;
const DEFAULT_EMBED_MODEL = 'nomic-ai/nomic-embed-text';

const IGNORE_DIRS = new Set([
    'node_modules', '.git', 'out', 'dist', '.next', '__pycache__',
    '.venv', 'venv', 'build', 'coverage', '.nyc_output', '.cache',
    '.turbo', '.svelte-kit', 'target', 'pkg',
]);

const IGNORE_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.map', '.lock', '.bin', '.exe', '.dll', '.so', '.dylib',
    '.zip', '.tar', '.gz', '.7z', '.rar',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx',
    '.mp3', '.mp4', '.avi', '.mov', '.mkv',
    '.pyc', '.pyo',
]);

const STORAGE_KEY = 'codico.workspaceIndex.v2';
const LEGACY_STORAGE_KEY = 'codico.workspaceIndex.v1';

function hashIndexText(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot  += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
}

// ── WorkspaceIndex ────────────────────────────────────────────────────────────

export class WorkspaceIndex {
    private _chunks: IndexChunk[] = [];
    private _indexedAt = 0;
    private _apiKey = '';
    private _buildAbort: AbortController | null = null;

    constructor(private readonly _context: vscode.ExtensionContext) {}

    // ── Public API ─────────────────────────────────────────────────────────────

    /** Update the API key used for embeddings. Call whenever the secret changes. */
    setApiKey(key: string): void { this._apiKey = key; }

    get isIndexed(): boolean { return this._chunks.length > 0; }

    get status(): IndexStatus {
        return {
            chunkCount: this._chunks.length,
            fileCount:  new Set(this._chunks.map(c => c.file)).size,
            hasVectors: this._chunks.length > 0 && this._chunks.every(c => c.vector && c.vector.length > 0),
            ageMs:      this._indexedAt > 0 ? Date.now() - this._indexedAt : Infinity,
        };
    }

    /**
     * Build (or rebuild) the full workspace index.
     * Shows a VS Code progress notification and is cancellable.
     */
    async buildIndex(): Promise<IndexStatus> {
        this._buildAbort?.abort();
        this._buildAbort = new AbortController();
        const abort = this._buildAbort;
        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Codico: Indexing workspace', cancellable: true },
            async (progress, token) => {
                token.onCancellationRequested(() => abort.abort());
                return this._doBuild(progress, abort.signal);
            }
        );
    }

    /**
     * Build the workspace index silently in the background.
     * Shows a spinning status bar item instead of a notification popup.
     * Intended for automatic first-open indexing.
     */
    async buildIndexBackground(): Promise<IndexStatus> {
        this._buildAbort?.abort();
        this._buildAbort = new AbortController();
        const abort = this._buildAbort;
        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: '$(sync~spin) Codico: indexing workspace…' },
            async (progress) => {
                return this._doBuild(progress, abort.signal, true);
            }
        );
    }

    /**
     * Search the index for chunks most relevant to `query`.
     * Uses cosine similarity when vectors are available; falls back to keyword scoring.
     */
    async search(query: string, topK = 8): Promise<IndexChunk[]> {
        if (this._chunks.length === 0) { return []; }

        // Vector path
        const withVectors = this._chunks.filter(c => c.vector && c.vector.length > 0);
        // Never mix current source text with only partially valid/stale embeddings.
        // If any chunk lacks a verified vector, fall back to keyword search across
        // the complete current workspace until a rebuild/reindex restores coverage.
        if (withVectors.length === this._chunks.length && withVectors.length > 0 && this._apiKey) {
            try {
                const [qvec] = await this._embedBatch([query]);
                if (qvec && qvec.length > 0) {
                    return withVectors
                        .map(c => ({ chunk: c, score: cosineSimilarity(qvec, c.vector!) }))
                        .sort((a, b) => b.score - a.score)
                        .slice(0, topK)
                        .map(r => r.chunk);
                }
            } catch { /* fall through */ }
        }

        // Keyword fallback
        return this._keywordSearch(query, topK);
    }

    /** Incrementally re-index a single changed file. */
    async reindexFile(uri: vscode.Uri): Promise<void> {
        const rel = vscode.workspace.asRelativePath(uri);
        this._chunks = this._chunks.filter(c => c.file !== rel);
        const newChunks = await this._chunkFile(uri);
        if (newChunks.length === 0) { return; }
        if (this._apiKey) {
            try {
                const vectors = await this._embedBatch(newChunks.map(c => c.text));
                for (let i = 0; i < newChunks.length; i++) {
                    if (vectors[i]) { newChunks[i].vector = vectors[i]; }
                }
            } catch { /* embed silently failed; keep chunks without vectors */ }
        }
        this._chunks.push(...newChunks);
        void this._persist();
    }

    /** Remove a deleted file's chunks from the index. */
    removeFile(uri: vscode.Uri): void {
        const rel = vscode.workspace.asRelativePath(uri);
        this._chunks = this._chunks.filter(c => c.file !== rel);
        void this._persist();
    }

    /**
     * Load a previously persisted index from workspace storage.
     *
     * Persisted entries intentionally do not contain raw source text. On restore we
     * re-read the current files and hydrate each chunk from disk. Embeddings are only
     * reused when the current chunk hash matches the hash stored with the vector, so
     * stale vectors can never be paired with changed source code.
     */
    async load(): Promise<boolean> {
        type PersistedChunk = {
            file: string;
            startLine: number;
            vector?: number[];
            textHash?: string;
        };
        type PersistedIndex = { chunks: PersistedChunk[]; indexedAt: number };

        const saved =
            this._context.workspaceState.get<PersistedIndex>(STORAGE_KEY) ??
            this._context.workspaceState.get<PersistedIndex>(LEGACY_STORAGE_KEY);
        if (!saved?.chunks?.length) { return false; }

        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) { return false; }

        const root = folders[0].uri;
        const persistedByKey = new Map(
            saved.chunks.map(c => [`${c.file}:${c.startLine}`, c] as const)
        );
        const hydrated: IndexChunk[] = [];
        const files = Array.from(new Set(saved.chunks.map(c => c.file)));

        for (const file of files) {
            const currentChunks = await this._chunkFile(vscode.Uri.joinPath(root, file));
            for (const chunk of currentChunks) {
                const persisted = persistedByKey.get(`${chunk.file}:${chunk.startLine}`);
                if (
                    persisted?.vector &&
                    persisted.vector.length > 0 &&
                    persisted.textHash &&
                    persisted.textHash === hashIndexText(chunk.text)
                ) {
                    chunk.vector = persisted.vector;
                }
                hydrated.push(chunk);
            }
        }

        if (hydrated.length === 0) { return false; }

        this._chunks = hydrated;
        this._indexedAt = saved.indexedAt ?? 0;

        // Migrate legacy metadata lazily. Legacy v1 entries had no text hash, so
        // their vectors are deliberately not trusted; keyword search remains usable.
        if (!this._context.workspaceState.get<PersistedIndex>(STORAGE_KEY)) {
            void this._persist();
            void this._context.workspaceState.update(LEGACY_STORAGE_KEY, undefined);
        }
        return true;
    }

    /** Clear the index from memory and persistent storage. */
    async clear(): Promise<void> {
        // Abort any in-progress build so it can't overwrite the clear
        this._buildAbort?.abort();
        this._buildAbort = null;
        this._chunks    = [];
        this._indexedAt = 0;
        await this._context.workspaceState.update(STORAGE_KEY, undefined);
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    private async _doBuild(
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        signal: AbortSignal,
        silent = false
    ): Promise<IndexStatus> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) { return this.status; }
        const root = folders[0].uri;

        progress.report({ message: 'Collecting files…', increment: 2 });
        const files = await this._collectFiles(root, signal);
        if (signal.aborted) { return this.status; }

        progress.report({ message: `Chunking ${files.length} files…`, increment: 3 });
        const chunks: IndexChunk[] = [];
        for (const uri of files) {
            if (signal.aborted) { break; }
            chunks.push(...await this._chunkFile(uri));
        }
        if (chunks.length === 0) { return this.status; }

        if (this._apiKey && !signal.aborted) {
            const total = chunks.length;
            let done = 0;
            for (let i = 0; i < chunks.length && !signal.aborted; i += EMBED_BATCH) {
                const batch = chunks.slice(i, i + EMBED_BATCH);
                try {
                    const vectors = await this._embedBatch(batch.map(c => c.text), signal);
                    for (let j = 0; j < batch.length; j++) {
                        if (vectors[j]) { batch[j].vector = vectors[j]; }
                    }
                } catch { /* skip this batch */ }
                done += batch.length;
                progress.report({
                    message: `Embedding ${done}/${total} chunks…`,
                    increment: (EMBED_BATCH / total) * 90,
                });
            }
        } else if (!this._apiKey) {
            progress.report({ message: 'No API key — skipping embeddings (keyword search only)', increment: 90 });
        }

        if (signal.aborted) { return this.status; }

        this._chunks    = chunks;
        this._indexedAt = Date.now();
        void this._persist();

        const s = this.status;
        if (silent) {
            vscode.window.setStatusBarMessage(
                `$(check) Codico: indexed ${s.fileCount} files${s.hasVectors ? '' : ' (keyword only)'}`, 4000
            );
        } else {
            vscode.window.showInformationMessage(
                `Codico: Indexed ${s.fileCount} files (${s.chunkCount} chunks)${s.hasVectors ? ' with embeddings' : ' — keyword search only'}.`
            );
        }
        return s;
    }

    private async _collectFiles(
        root: vscode.Uri,
        signal: AbortSignal,
        rel = '',
        depth = 0,
        counter = { count: 0 }
    ): Promise<vscode.Uri[]> {
        if (depth > 7 || signal.aborted) { return []; }
        const results: vscode.Uri[] = [];
        try {
            const dir = rel ? vscode.Uri.joinPath(root, rel) : root;
            const entries = await vscode.workspace.fs.readDirectory(dir);
            for (const [name, type] of entries) {
                if (signal.aborted || counter.count >= MAX_FILES) { break; }
                const childRel = rel ? `${rel}/${name}` : name;
                if (type === vscode.FileType.Directory) {
                    if (IGNORE_DIRS.has(name) || name.startsWith('.')) { continue; }
                    results.push(...await this._collectFiles(root, signal, childRel, depth + 1, counter));
                } else {
                    const ext = path.extname(name).toLowerCase();
                    if (!IGNORE_EXTS.has(ext)) {
                        results.push(vscode.Uri.joinPath(root, childRel));
                        counter.count++;
                    }
                }
            }
        } catch { /* unreadable directory */ }
        return results;
    }

    private async _chunkFile(uri: vscode.Uri): Promise<IndexChunk[]> {
        try {
            const rel = vscode.workspace.asRelativePath(uri);
            if (ignoreRules.shouldIgnore(rel)) { return []; }
            const bytes = await vscode.workspace.fs.readFile(uri);
            if (bytes.byteLength > MAX_FILE_BYTES) { return []; }
            const text = new TextDecoder().decode(bytes);
            if (text.includes('\x00')) { return []; }  // binary guard

            const lines = text.split('\n');
            const chunks: IndexChunk[] = [];
            let i = 0;
            while (i < lines.length) {
                const end  = Math.min(i + CHUNK_LINES, lines.length);
                const body = lines.slice(i, end).join('\n');
                // File path header improves embedding quality for code search
                chunks.push({ file: rel, startLine: i + 1, text: `// ${rel}  (lines ${i + 1}–${end})\n${body}` });
                i += CHUNK_LINES - CHUNK_OVERLAP;
                if (i >= lines.length) { break; }
            }
            return chunks;
        } catch { return []; }
    }

    private _embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]> {
        const model = vscode.workspace
            .getConfiguration('codico')
            .get<string>('embeddingModel', DEFAULT_EMBED_MODEL);

        return new Promise((resolve, reject) => {
            if (signal?.aborted) { resolve([]); return; }
            const body = Buffer.from(JSON.stringify({ model, input: texts }));
            const req = https.request(
                {
                    hostname: 'openrouter.ai',
                    path: '/api/v1/embeddings',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': body.length,
                        'Authorization': `Bearer ${this._apiKey}`,
                        'HTTP-Referer': 'vscode-codico',
                        'X-Title': 'Codico',
                    },
                },
                (res) => {
                    const parts: Buffer[] = [];
                    res.on('data', (c: Buffer) => parts.push(c));
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(Buffer.concat(parts).toString('utf8'));
                            if (json.error) {
                                reject(new Error(String(json.error.message ?? json.error)));
                                return;
                            }
                            // Sort by index to guarantee order matches input
                            const vectors: number[][] = (json.data ?? [])
                                .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
                                .map((d: { embedding: number[] }) => d.embedding);
                            resolve(vectors);
                        } catch (e) { reject(e); }
                    });
                }
            );
            if (signal) {
                signal.addEventListener('abort', () => { req.destroy(); resolve([]); }, { once: true });
            }
            req.on('error', reject);
            req.setTimeout(60_000, () => req.destroy(new Error('Embedding request timed out')));
            req.write(body);
            req.end();
        });
    }

    private _keywordSearch(query: string, topK: number): IndexChunk[] {
        const terms = query.toLowerCase().split(/\W+/).filter(t => t.length > 2);
        if (terms.length === 0) { return this._chunks.slice(0, topK); }

        return this._chunks
            .map(c => {
                const lower = c.text.toLowerCase();
                const score = terms.reduce((acc, t) => {
                    const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
                    return acc + (lower.match(re)?.length ?? 0);
                }, 0);
                return { chunk: c, score };
            })
            .filter(r => r.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(r => r.chunk);
    }

    private async _persist(): Promise<void> {
        // Strip chunk text before persisting — only keep metadata and vectors.
        // Raw source text could contain secrets and should not be stored unencrypted.
        const stripped = this._chunks.map(c => ({
            file: c.file,
            startLine: c.startLine,
            vector: c.vector,
            textHash: hashIndexText(c.text),
        }));
        await this._context.workspaceState.update(STORAGE_KEY, {
            chunks:    stripped,
            indexedAt: this._indexedAt,
        });
    }
}
