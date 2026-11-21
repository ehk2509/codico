import * as http from 'http';
import * as https from 'https';
import { SYSTEM_PROMPT, StreamChunk, ChatMessage } from './openRouterClient';
import { StreamCompletionGuard, ThinkTagSplitter, watchStreamStall } from './streamCompletion';
import { flattenChatHistory, PlainChatMessage } from './providerConversation';

/**
 * Parse a base URL string into host, port, and path prefix.
 * Supports http:// and https:// schemes.
 */
function parseBaseUrl(baseUrl: string): { protocol: 'http' | 'https'; hostname: string; port: number; pathPrefix: string } {
    const url = new URL(baseUrl);
    const protocol = url.protocol === 'https:' ? 'https' : 'http';
    const hostname = url.hostname;
    const port = url.port ? parseInt(url.port, 10) : (protocol === 'https' ? 443 : 80);
    const pathPrefix = url.pathname.replace(/\/$/, ''); // strip trailing slash
    return { protocol, hostname, port, pathPrefix };
}

/**
 * Streams a chat completion from a local Ollama instance via its OpenAI-compatible endpoint.
 * The model parameter should be the raw Ollama model name (with the "ollama/" prefix stripped).
 * baseUrl defaults to "http://localhost:11434".
 */
export function streamOllama(
    baseUrl: string,
    history: ChatMessage[],
    model: string,
    customSystemPromptPrefix?: string,
    signal?: AbortSignal,
    overrideSystemPrompt?: string,
    options?: OllamaOptions
): AsyncIterable<StreamChunk> {
    const basePrompt = overrideSystemPrompt ?? SYSTEM_PROMPT;
    const effectiveSystemPrompt = customSystemPromptPrefix
        ? `${basePrompt}\n\n${customSystemPromptPrefix}`
        : basePrompt;

    // A context size was asked for: only the native endpoint can carry it
    if (options?.numCtx && options.numCtx > 0) {
        return streamOllamaNative(baseUrl, flattenChatHistory([{ role: 'system', content: effectiveSystemPrompt }, ...history]), model, Math.floor(options.numCtx), signal);
    }

    return {
        [Symbol.asyncIterator]() {
            const queue: Array<StreamChunk | null | Error> = [];
            let resolver: (() => void) | null = null;

            function wake(): void {
                if (resolver) {
                    const r = resolver;
                    resolver = null;
                    r();
                }
            }

            function push(item: StreamChunk | null | Error): void {
                queue.push(item);
                wake();
            }

            if (signal) {
                if (signal.aborted) {
                    push(null);
                } else {
                    signal.addEventListener('abort', () => { push(null); }, { once: true });
                }
            }

            // ── <think> tag state machine (for models like qwen3, deepseek-r1) ──
            const think = new ThinkTagSplitter((type, text) => push({ type, text }));

            const messages = flattenChatHistory([
                { role: 'system', content: effectiveSystemPrompt },
                ...history,
            ]);

            // The thinking effort, when it is not the model's default; dropped if the server refuses it
            let effortField = effortBody(options?.effort);
            const requestBody = (): string => JSON.stringify({
                model,
                messages,
                stream: true,
                stream_options: { include_usage: true },
                ...effortField,
            });

            const { protocol, hostname, port, pathPrefix } = parseBaseUrl(baseUrl);
            const transport = protocol === 'https' ? https : http;

            function doRequest(): void {
                if (signal?.aborted) { push(null); return; }
                const body = requestBody();

                const req = transport.request(
                    {
                        hostname,
                        port,
                        path: `${pathPrefix}/v1/chat/completions`,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(body),
                        },
                        signal: signal as AbortSignal,
                    },
                    (res) => {
                        if (res.statusCode && res.statusCode >= 400) {
                            let errBody = '';
                            res.setEncoding('utf8'); // keeps characters split across chunks intact
                            res.on('data', (d: string) => { errBody += d.toString(); });
                            res.on('end', () => {
                                // A model or server that takes no thinking effort: once more without it
                                if (res.statusCode === 400 && Object.keys(effortField).length > 0 && REFUSED_EFFORT_RE.test(errBody) && !signal?.aborted) {
                                    effortField = {};
                                    doRequest();
                                    return;
                                }
                                push(new Error(`Ollama HTTP ${res.statusCode}: ${errBody.slice(0, 300)}`));
                            });
                            return;
                        }

                        let buffer = '';
                        const completion = new StreamCompletionGuard();
                        let streamEnded = false;
                        const pushEnd = (): void => {
                            if (!streamEnded) {
                                streamEnded = true;
                                think.flush();
                                push(null);
                            }
                        };

                        function flushBuffer(): void {
                            if (!buffer) { return; }
                            const lines = buffer.split('\n');
                            buffer = '';
                            for (const line of lines) {
                                const trimmed = line.trim();
                                if (!trimmed) { continue; }
                                if (trimmed === 'data: [DONE]') {
                                    completion.markTerminal();
                                    pushEnd();
                                    continue;
                                }
                                if (trimmed.startsWith('data: ')) {
                                    try {
                                        const json = JSON.parse(trimmed.slice(6));

                                        if (json.error) {
                                            const msg: string = json.error?.message ?? JSON.stringify(json.error);
                                            completion.markTerminal();
                                            push({ type: 'stream_error', message: msg });
                                            pushEnd();
                                            continue;
                                        }

                                        const delta = json.choices?.[0]?.delta as
                                            | { content?: string; reasoning_content?: string; reasoning?: string }
                                            | undefined;

                                        // Thinking in its own field: reasoning_content (llama.cpp, vLLM, LM Studio) or reasoning (Ollama)
                                        const reasoning = delta?.reasoning_content || delta?.reasoning;
                                        if (typeof reasoning === 'string' && reasoning) { push({ type: 'thinking', text: reasoning }); }
                                        if (typeof delta?.content === 'string') {
                                            think.push(delta.content);
                                        }

                                        const finishReason: string | undefined = json.choices?.[0]?.finish_reason;
                                        if (finishReason) {
                                            completion.markTerminal();
                                            if (finishReason !== 'stop' && finishReason !== 'tool_calls') {
                                                push({ type: 'finish', reason: finishReason });
                                            }
                                        }

                                        const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
                                        if (usage?.total_tokens) {
                                            push({
                                                type: 'usage',
                                                promptTokens: usage.prompt_tokens ?? 0,
                                                completionTokens: usage.completion_tokens ?? 0,
                                                totalTokens: usage.total_tokens,
                                            });
                                        }
                                    } catch {
                                        // Ignore malformed SSE frames
                                    }
                                }
                            }
                        }

                        res.setEncoding('utf8'); // keeps characters split across chunks intact
                        res.on('data', (data: string) => {
                            buffer += data.toString();
                            const lines = buffer.split('\n');
                            buffer = lines.pop() ?? '';

                            for (const line of lines) {
                                const trimmed = line.trim();
                                if (!trimmed) { continue; }
                                if (trimmed === 'data: [DONE]') {
                                    completion.markTerminal();
                                    pushEnd();
                                    return;
                                }
                                if (trimmed.startsWith('data: ')) {
                                    try {
                                        const json = JSON.parse(trimmed.slice(6));

                                        if (json.error) {
                                            const msg: string = json.error?.message ?? JSON.stringify(json.error);
                                            completion.markTerminal();
                                            push({ type: 'stream_error', message: msg });
                                            pushEnd();
                                            return;
                                        }

                                        const delta = json.choices?.[0]?.delta as
                                            | { content?: string; reasoning_content?: string; reasoning?: string }
                                            | undefined;

                                        // Thinking in its own field: reasoning_content (llama.cpp, vLLM, LM Studio) or reasoning (Ollama)
                                        const reasoning = delta?.reasoning_content || delta?.reasoning;
                                        if (typeof reasoning === 'string' && reasoning) { push({ type: 'thinking', text: reasoning }); }
                                        if (typeof delta?.content === 'string') {
                                            think.push(delta.content);
                                        }

                                        const finishReason: string | undefined = json.choices?.[0]?.finish_reason;
                                        if (finishReason) {
                                            completion.markTerminal();
                                            if (finishReason !== 'stop' && finishReason !== 'tool_calls') {
                                                push({ type: 'finish', reason: finishReason });
                                            }
                                        }

                                        const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
                                        if (usage?.total_tokens) {
                                            push({
                                                type: 'usage',
                                                promptTokens: usage.prompt_tokens ?? 0,
                                                completionTokens: usage.completion_tokens ?? 0,
                                                totalTokens: usage.total_tokens,
                                            });
                                        }
                                    } catch {
                                        // Ignore malformed SSE frames
                                    }
                                }
                            }
                        });

                        res.on('end', () => {
                            flushBuffer();
                            if (!signal?.aborted) {
                                const interrupted = completion.unexpectedEofMessage('Ollama');
                                if (interrupted) {
                                    push({ type: 'stream_error', message: interrupted });
                                }
                            }
                            pushEnd();
                        });
                        res.on('error', (err: Error) => {
                            if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR' || signal?.aborted) {
                                pushEnd();
                            } else {
                                push({ type: 'stream_error', message: `Ollama stream transport error: ${err.message}` });
                                pushEnd();
                            }
                        });
                    }
                );

                req.on('error', (err: Error) => {
                    if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR' || signal?.aborted) {
                        push(null);
                    } else {
                        push({ type: 'stream_error', message: `Ollama stream transport error: ${err.message}` });
                        push(null);
                    }
                });
                watchStreamStall(req);
                req.write(body);
                req.end();
            }

            doRequest();

            return {
                async next(): Promise<IteratorResult<StreamChunk>> {
                    while (queue.length === 0) {
                        await new Promise<void>((r) => { resolver = r; });
                    }

                    const item = queue.shift()!;

                    if (item === null) {
                        return { value: undefined as unknown as StreamChunk, done: true };
                    }
                    if (item instanceof Error) {
                        throw item;
                    }
                    return { value: item, done: false };
                },
            };
        },
    };
}

/** Options of an Ollama request that the OpenAI-compatible endpoint has no way to carry. */
export interface OllamaOptions {
    /**
     * The context window (tokens) to load the model with. Unset or 0 leaves the server's own setting, which on a
     * default install is 4096 to 8192 tokens, far less than an agent's conversation: Ollama then silently drops the
     * start of it. When set, the request goes to Ollama's native /api/chat, the only endpoint that accepts this.
     */
    numCtx?: number;
    /** Thinking effort; 'medium' (the default) sends nothing, so the model thinks as it normally does. */
    effort?: 'high' | 'medium' | 'low';
}

/** An AsyncIterable of chunks fed by `start`, which pushes chunks, then null at the end or an Error to throw. */
function chunkStream(start: (push: (item: StreamChunk | null | Error) => void) => void): AsyncIterable<StreamChunk> {
    return {
        [Symbol.asyncIterator]() {
            const queue: Array<StreamChunk | null | Error> = [];
            let resolver: (() => void) | null = null;
            const push = (item: StreamChunk | null | Error): void => {
                queue.push(item);
                const wake = resolver;
                resolver = null;
                wake?.();
            };
            start(push);
            return {
                async next(): Promise<IteratorResult<StreamChunk>> {
                    while (queue.length === 0) { await new Promise<void>(r => { resolver = r; }); }
                    const item = queue.shift()!;
                    if (item === null) { return { value: undefined as unknown as StreamChunk, done: true }; }
                    if (item instanceof Error) { throw item; }
                    return { value: item, done: false };
                },
            };
        },
    };
}

/**
 * A streamed chat through Ollama's native /api/chat (newline-delimited JSON), with the context window the
 * caller asked for. The reply, its thinking, token counts and end reason map to the same chunks as the
 * OpenAI-compatible path.
 */
export function streamOllamaNative(baseUrl: string, messages: PlainChatMessage[], model: string, numCtx: number, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    return chunkStream(push => {
        if (signal?.aborted) { push(null); return; }
        signal?.addEventListener('abort', () => { push(null); }, { once: true });
        const think = new ThinkTagSplitter((type, text) => push({ type, text }));
        const body = JSON.stringify({ model, messages, stream: true, options: { num_ctx: numCtx } });
        const { protocol, hostname, port, pathPrefix } = parseBaseUrl(baseUrl);
        const transport = protocol === 'https' ? https : http;
        const completion = new StreamCompletionGuard();
        let ended = false;
        const end = (): void => { if (!ended) { ended = true; think.flush(); push(null); } };

        /** One line of the response. Returns true when the stream is finished. */
        const handleLine = (line: string): boolean => {
            const trimmed = line.trim();
            if (!trimmed) { return false; }
            let json: { error?: string; message?: { content?: string; thinking?: string }; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number };
            try { json = JSON.parse(trimmed); } catch { return false; }
            if (json.error) {
                completion.markTerminal();
                push({ type: 'stream_error', message: String(json.error) });
                end();
                return true;
            }
            if (typeof json.message?.thinking === 'string' && json.message.thinking) { push({ type: 'thinking', text: json.message.thinking }); }
            if (typeof json.message?.content === 'string' && json.message.content) { think.push(json.message.content); }
            if (json.done) {
                completion.markTerminal();
                if (json.done_reason && json.done_reason !== 'stop') { push({ type: 'finish', reason: json.done_reason }); }
                const prompt = json.prompt_eval_count ?? 0;
                const completionTokens = json.eval_count ?? 0;
                if (prompt || completionTokens) { push({ type: 'usage', promptTokens: prompt, completionTokens, totalTokens: prompt + completionTokens }); }
                end();
                return true;
            }
            return false;
        };

        const req = transport.request(
            { hostname, port, path: `${pathPrefix}/api/chat`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, signal: signal as AbortSignal },
            (res) => {
                if (res.statusCode && res.statusCode >= 400) {
                    let errBody = '';
                    res.setEncoding('utf8');
                    res.on('data', (d: string) => { errBody += d; });
                    res.on('end', () => { push(new Error(`Ollama HTTP ${res.statusCode}: ${errBody.slice(0, 300)}`)); });
                    return;
                }
                let buffer = '';
                res.setEncoding('utf8');
                res.on('data', (data: string) => {
                    buffer += data;
                    const lines = buffer.split('\n');
                    buffer = lines.pop() ?? '';
                    for (const line of lines) { if (handleLine(line)) { return; } }
                });
                res.on('end', () => {
                    if (buffer) { handleLine(buffer); }
                    if (!signal?.aborted) {
                        const interrupted = completion.unexpectedEofMessage('Ollama');
                        if (interrupted) { push({ type: 'stream_error', message: interrupted }); }
                    }
                    end();
                });
                res.on('error', (err: Error) => {
                    if ((err as NodeJS.ErrnoException).code !== 'ABORT_ERR' && !signal?.aborted) { push({ type: 'stream_error', message: `Ollama stream transport error: ${err.message}` }); }
                    end();
                });
            }
        );
        req.on('error', (err: Error) => {
            if ((err as NodeJS.ErrnoException).code !== 'ABORT_ERR' && !signal?.aborted) { push({ type: 'stream_error', message: `Ollama stream transport error: ${err.message}` }); }
            push(null);
        });
        watchStreamStall(req);
        req.write(body);
        req.end();
    });
}

/** A thinking effort other than the model's default, as the OpenAI-compatible request field. */
function effortBody(effort: 'high' | 'medium' | 'low' | undefined): Record<string, unknown> {
    return effort && effort !== 'medium' ? { reasoning_effort: effort } : {};
}

/** An error saying the model or server takes no thinking option (the request is then sent without it). */
const REFUSED_EFFORT_RE = /reasoning_effort|chat_template_kwargs|does not support thinking|think/i;

/**
 * Turns thinking off for a short job: reasoning_effort "none" (Ollama, OpenAI-style servers) and
 * enable_thinking false in the chat template (llama.cpp, vLLM: Qwen3 and similar models).
 */
const NO_THINKING = { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } };

/** The outcome of one non-streamed request. */
interface OneShotResult { content: string; finish?: string; status: number; error?: string }

function oneShot(baseUrl: string, payload: Record<string, unknown>, signal: AbortSignal | undefined, timeoutMs: number): Promise<OneShotResult> {
    const { protocol, hostname, port, pathPrefix } = parseBaseUrl(baseUrl);
    const transport = protocol === 'https' ? https : http;
    const body = JSON.stringify(payload);
    return new Promise(resolve => {
        if (signal?.aborted) { resolve({ content: '', status: 0 }); return; }
        const req = transport.request(
            { hostname, port, path: `${pathPrefix}/v1/chat/completions`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
            (res) => {
                let data = '';
                res.setEncoding('utf8'); // keeps characters split across chunks intact
                res.on('data', (c: string) => { data += c; });
                res.on('end', () => {
                    const status = res.statusCode ?? 0;
                    if (status >= 400) { resolve({ content: '', status, error: `HTTP ${status}: ${data.slice(0, 300)}` }); return; }
                    try {
                        const choice = JSON.parse(data)?.choices?.[0];
                        resolve({ content: choice?.message?.content ?? '', finish: choice?.finish_reason ?? undefined, status });
                    } catch { resolve({ content: '', status, error: `unreadable reply: ${data.slice(0, 200)}` }); }
                });
                res.on('error', (err: Error) => resolve({ content: '', status: 0, error: err.message }));
            }
        );
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)));
        signal?.addEventListener('abort', () => req.destroy(), { once: true });
        req.on('error', (err: Error) => resolve({ content: '', status: 0, error: signal?.aborted ? undefined : err.message }));
        req.write(body);
        req.end();
    });
}

/**
 * Non-streaming single-shot completion via the OpenAI-compatible endpoint, for short jobs
 * (follow-up suggestions, commit messages, summaries). Thinking is turned off, so a reasoning
 * model does not spend the whole budget thinking and answer nothing; a server that refuses that
 * option is asked again without it, and an answer cut off before any text is asked for again with
 * more room. Resolves '' when stopped; throws when the server fails or does not answer in time.
 */
export async function ollamaChatCompletion(
    baseUrl: string,
    messages: ChatMessage[],
    model: string,
    maxTokens: number,
    signal?: AbortSignal,
    timeoutMs = 120_000
): Promise<string> {
    const base = { model, messages: flattenChatHistory(messages), max_tokens: maxTokens, stream: false };
    let result = await oneShot(baseUrl, { ...base, ...NO_THINKING }, signal, timeoutMs);
    if (result.status === 400 && REFUSED_EFFORT_RE.test(result.error ?? '')) {
        result = await oneShot(baseUrl, base, signal, timeoutMs);
    }
    // Still thought through the whole budget (thinking could not be turned off): more room, once
    if (!result.error && !result.content.trim() && result.finish === 'length' && !signal?.aborted) {
        result = await oneShot(baseUrl, { ...base, max_tokens: Math.max(maxTokens * 8, 2000) }, signal, timeoutMs);
    }
    if (signal?.aborted) { return ''; }
    if (result.error) { throw new Error(`Local model request failed: ${result.error}`); }
    return result.content;
}
