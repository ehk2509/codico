import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { StringDecoder } from 'string_decoder';
import { ignoreRules } from './ignoreRules';

// ── Streaming completion cache ─────────────────────────────────────────────
// Keyed by `${docUri}@${line}:${char}`. Holds the growing text and a done flag.
interface StreamState {
    text: string;
    done: boolean;
    abort: AbortController;
}
const _streams = new Map<string, StreamState>();

function _streamKey(doc: vscode.TextDocument, pos: vscode.Position): string {
    return `${doc.uri.toString()}@${pos.line}:${pos.character}`;
}

/**
 * Collect short snippets from open editor tabs (excluding the active document).
 * Returns a formatted string to inject as related-file context, or '' if none.
 */
async function _getOpenTabContext(
    activeDocument: vscode.TextDocument,
    maxFiles = 3,
    maxCharsPerFile = 1500
): Promise<string> {
    const snippets: string[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (snippets.length >= maxFiles) { break; }
            const input = tab.input as { uri?: vscode.Uri } | undefined;
            if (!input?.uri) { continue; }
            if (input.uri.toString() === activeDocument.uri.toString()) { continue; }
            // Only text files (skip images, diffs, etc.)
            try {
                const doc = await vscode.workspace.openTextDocument(input.uri);
                const rel = vscode.workspace.asRelativePath(input.uri);
                const full = doc.getText();
                const text = full.slice(0, maxCharsPerFile);
                snippets.push(`// ${rel}\n${text}${full.length > maxCharsPerFile ? '\n// …truncated' : ''}`);
            } catch { /* skip unreadable tabs */ }
        }
        if (snippets.length >= maxFiles) { break; }
    }
    return snippets.join('\n\n');
}

/**
 * Parse SSE lines into state.text. Returns true if any new tokens were added.
 * Single helper used by both the streaming data handler and the end-flush so
 * future schema changes only need to be applied once.
 */
function parseSSELines(lines: string[], state: StreamState): boolean {
    let changed = false;
    for (const line of lines) {
        if (!line.startsWith('data:')) { continue; }
        const raw = line.slice(5).trim();
        if (raw === '[DONE]') { state.done = true; continue; }
        try {
            const delta: string = JSON.parse(raw)?.choices?.[0]?.delta?.content ?? '';
            if (delta) { state.text += delta; changed = true; }
        } catch { /* skip malformed SSE frames */ }
    }
    return changed;
}

/**
 * Starts (or returns existing) SSE streaming FIM completion for the given position.
 * Uses a system + user message pair optimised for fill-in-the-middle completion.
 * Progressively fills state.text and retriggers inline suggestions after each batch.
 */
function _startStream(
    key: string,
    apiKey: string,
    model: string,
    language: string,
    prefix: string,
    suffix: string,
    relatedContext: string,
    ollamaBaseUrl?: string
): StreamState {
    const existing = _streams.get(key);
    if (existing && !existing.done) { return existing; }

    const abort = new AbortController();
    const state: StreamState = { text: '', done: false, abort };
    _streams.set(key, state);

    // ── FIM-style prompt ──────────────────────────────────────────────────
    const systemMsg =
        'You are a code completion engine. ' +
        'Complete the code exactly at the <MID> marker. ' +
        'Output ONLY the raw completion text — no explanation, no markdown fences, ' +
        'no repeating of the prefix or suffix code.';

    const contextBlock = relatedContext
        ? `// Related open files (for context only):\n${relatedContext}\n\n`
        : '';

    const userMsg =
        `${contextBlock}// Language: ${language}\n` +
        `<PRE>${prefix}<SUF>${suffix}<MID>`;

    const isOllama = model.startsWith('ollama/');
    const effectiveModel = isOllama ? model.slice('ollama/'.length) : model;

    const body = JSON.stringify({
        model: effectiveModel,
        messages: [
            { role: 'system', content: systemMsg },
            { role: 'user',   content: userMsg },
        ],
        max_tokens: 256,
        temperature: 0.05,
        stop: ['\n\n\n', '<PRE>', '<SUF>', '<MID>'],
        stream: true,
    });

    // ── Shared SSE response handler ───────────────────────────────────────
    function makeResponseHandler(destroy: () => void) {
        return (res: http.IncomingMessage) => {
            // Reject HTTP-level errors — error bodies contain no SSE lines so without
            // this check state.done is never set and the stream entry lingers indefinitely.
            if (res.statusCode && res.statusCode >= 400) {
                state.done = true;
                let errBody = '';
                res.on('data', (d: Buffer) => { errBody += d.toString(); });
                res.on('end', () => {
                    console.error(`Codico inline completion: HTTP ${res.statusCode} — ${errBody.slice(0, 200)}`);
                    void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
                });
                res.on('error', () => { /* already marked done */ });
                return;
            }

            // StringDecoder reassembles multi-byte UTF-8 codepoints across TCP chunk
            // boundaries, preventing U+FFFD corruption in non-ASCII code.
            const decoder = new StringDecoder('utf8');
            const MAX_COMPLETION_BYTES = 32 * 1024;
            let buf = '';
            let totalBytes = 0;
            let capped = false;

            res.on('data', (chunk: Buffer) => {
                totalBytes += chunk.length;
                if (totalBytes > MAX_COMPLETION_BYTES) {
                    if (!capped) {
                        capped = true;
                        destroy();
                        state.done = true;
                        void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
                    }
                    return;
                }
                buf += decoder.write(chunk);
                const lines = buf.split('\n');
                buf = lines.pop() ?? '';
                if (parseSSELines(lines.map(l => l.trim()), state)) {
                    void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
                }
            });
            res.on('end', () => {
                buf += decoder.end();
                parseSSELines(buf.split('\n').map(l => l.trim()), state);
                buf = '';
                state.done = true;
                void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            });
            // Surface socket-level errors (TCP reset, connection drop mid-stream).
            // Without this listener Node.js would throw an unhandled error event,
            // crashing the extension host.
            res.on('error', () => {
                state.done = true;
                void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            });
        };
    }

    if (isOllama) {
        const base = ollamaBaseUrl ?? 'http://localhost:11434';
        const url = new URL(base);
        const transport = url.protocol === 'https:' ? https : http;
        const port = url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
        const pathPrefix = url.pathname.replace(/\/$/, '');
        const req = transport.request(
            {
                hostname: url.hostname,
                port,
                path: `${pathPrefix}/v1/chat/completions`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            makeResponseHandler(() => req.destroy())
        );
        req.on('error', () => { state.done = true; });
        // Guard against an already-aborted signal — Node.js does not retroactively fire
        // the 'abort' event for signals that were aborted before addEventListener is called.
        if (abort.signal.aborted) { req.destroy(); state.done = true; return state; }
        abort.signal.addEventListener('abort', () => { req.destroy(); state.done = true; }, { once: true });
        req.write(body);
        req.end();
    } else {
        const req = https.request(
            {
                hostname: 'openrouter.ai',
                path: '/api/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'vscode-codico',
                    'X-Title': 'Codico',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            makeResponseHandler(() => req.destroy())
        );
        req.on('error', () => { state.done = true; });
        if (abort.signal.aborted) { req.destroy(); state.done = true; return state; }
        abort.signal.addEventListener('abort', () => { req.destroy(); state.done = true; }, { once: true });
        req.write(body);
        req.end();
    }

    return state;
}

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    // Per-instance debounce timer so concurrent documents don't clobber each other's
    // pending completions. A module-level timer would cancel document A's pending
    // request whenever the user types in document B.
    private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly _context: vscode.ExtensionContext) {}

    provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionList | null> {
        const config = vscode.workspace.getConfiguration('codico');
        if (!config.get<boolean>('inlineCompletionsEnabled', true)) {
            return Promise.resolve(null);
        }

        // Respect .copilotignore
        if (document.uri.scheme === 'file') {
            const rel = vscode.workspace.asRelativePath(document.uri);
            if (ignoreRules.shouldIgnore(rel)) { return Promise.resolve(null); }
        }

        const key = _streamKey(document, position);

        // If there's already a stream for this key, return whatever text has accumulated
        const existing = _streams.get(key);
        if (existing) {
            if (existing.text) {
                return Promise.resolve({
                    items: [new vscode.InlineCompletionItem(existing.text, new vscode.Range(position, position))],
                });
            }
            return Promise.resolve(null);
        }

        const delayMs = config.get<number>('inlineCompletionsDebounceMs', 100);

        return new Promise((resolve) => {
            if (this._debounceTimer) { clearTimeout(this._debounceTimer); }

            // Abort in-flight streams at other positions and prune all completed entries
            for (const [k, s] of _streams) {
                if (k !== key) {
                    if (!s.done) { s.abort.abort(); }
                    _streams.delete(k);
                } else if (s.done) {
                    // Evict completed entry at the current position so it doesn't linger forever
                    _streams.delete(k);
                }
            }

            this._debounceTimer = setTimeout(async () => {
                if (token.isCancellationRequested) { return resolve(null); }

                const model = config.get<string>('model', 'deepseek/deepseek-v4-flash');
                const isOllama = model.startsWith('ollama/');
                const ollamaBaseUrl = config.get<string>('ollamaBaseUrl', 'http://localhost:11434');

                let apiKey = '';
                if (!isOllama) {
                    apiKey = await this._context.secrets.get('openRouterApiKey') ?? '';
                    if (!apiKey) { return resolve(null); }
                }

                // Wider context windows: 4000-char prefix, 1000-char suffix
                const prefixStart = document.positionAt(
                    Math.max(0, document.offsetAt(position) - 4000)
                );
                const suffixEnd = document.positionAt(
                    Math.min(document.getText().length, document.offsetAt(position) + 1000)
                );
                const prefix = document.getText(new vscode.Range(prefixStart, position));
                const suffix = document.getText(new vscode.Range(position, suffixEnd));

                // Gather open-tab context (up to 3 related files, 1500 chars each)
                const relatedContext = await _getOpenTabContext(document);

                if (token.isCancellationRequested) { return resolve(null); }

                // Abort the HTTP stream when VS Code cancels the suggestion cycle.
                // Store the Disposable and call dispose() after the promise settles so the
                // handler cannot fire against a later stream started at the same key.
                const cancelDisposable = token.onCancellationRequested(() => {
                    _streams.get(key)?.abort.abort();
                    _streams.delete(key);
                });

                const state = _startStream(
                    key, apiKey, model,
                    document.languageId,
                    prefix, suffix,
                    relatedContext,
                    isOllama ? ollamaBaseUrl : undefined
                );

                // Wait up to 80 ms for first tokens, but exit immediately on cancellation
                // rather than burning the full wait period after the user resumes typing.
                await new Promise<void>(r => {
                    const t = setTimeout(r, 80);
                    const d = token.onCancellationRequested(() => { clearTimeout(t); r(); d.dispose(); });
                });

                cancelDisposable.dispose();

                if (token.isCancellationRequested) { return resolve(null); }

                if (state.text) {
                    resolve({
                        items: [new vscode.InlineCompletionItem(state.text, new vscode.Range(position, position))],
                    });
                } else {
                    // Tokens haven't arrived yet — resolve null; stream will retrigger
                    resolve(null);
                }
            }, delayMs);
        });
    }
}
