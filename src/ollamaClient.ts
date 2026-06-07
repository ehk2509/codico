import * as http from 'http';
import * as https from 'https';
import { SYSTEM_PROMPT, StreamChunk, ChatMessage } from './openRouterClient';

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
    overrideSystemPrompt?: string
): AsyncIterable<StreamChunk> {
    const basePrompt = overrideSystemPrompt ?? SYSTEM_PROMPT;
    const effectiveSystemPrompt = customSystemPromptPrefix
        ? `${basePrompt}\n\n${customSystemPromptPrefix}`
        : basePrompt;

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
            let inThinkBlock = false;

            function processContentChunk(raw: string): void {
                if (!raw) { return; }

                if (!inThinkBlock) {
                    const tIdx = raw.indexOf('<think>');
                    if (tIdx !== -1) {
                        const before = raw.slice(0, tIdx);
                        if (before) { push({ type: 'content', text: before }); }
                        inThinkBlock = true;
                        processContentChunk(raw.slice(tIdx + 7));
                    } else {
                        push({ type: 'content', text: raw });
                    }
                } else {
                    const eIdx = raw.indexOf('</think>');
                    if (eIdx !== -1) {
                        const inside = raw.slice(0, eIdx);
                        if (inside) { push({ type: 'thinking', text: inside }); }
                        inThinkBlock = false;
                        processContentChunk(raw.slice(eIdx + 8));
                    } else {
                        push({ type: 'thinking', text: raw });
                    }
                }
            }

            const messages: ChatMessage[] = [
                { role: 'system', content: effectiveSystemPrompt },
                ...history,
            ];

            const body = JSON.stringify({
                model,
                messages,
                stream: true,
                stream_options: { include_usage: true },
            });

            const { protocol, hostname, port, pathPrefix } = parseBaseUrl(baseUrl);
            const transport = protocol === 'https' ? https : http;

            function doRequest(): void {
                if (signal?.aborted) { push(null); return; }

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
                            res.on('data', (d: Buffer) => { errBody += d.toString(); });
                            res.on('end', () => {
                                push(new Error(`Ollama HTTP ${res.statusCode}: ${errBody.slice(0, 300)}`));
                            });
                            return;
                        }

                        let buffer = '';

                        function flushBuffer(): void {
                            if (!buffer) { return; }
                            const lines = buffer.split('\n');
                            buffer = '';
                            for (const line of lines) {
                                const trimmed = line.trim();
                                if (!trimmed) { continue; }
                                if (trimmed === 'data: [DONE]') {
                                    push(null);
                                    continue;
                                }
                                if (trimmed.startsWith('data: ')) {
                                    try {
                                        const json = JSON.parse(trimmed.slice(6));

                                        if (json.error) {
                                            const msg: string = json.error?.message ?? JSON.stringify(json.error);
                                            push({ type: 'stream_error', message: msg });
                                            push(null);
                                            continue;
                                        }

                                        const delta = json.choices?.[0]?.delta as
                                            | { content?: string }
                                            | undefined;

                                        if (typeof delta?.content === 'string') {
                                            processContentChunk(delta.content);
                                        }

                                        const finishReason: string | undefined = json.choices?.[0]?.finish_reason;
                                        if (finishReason && finishReason !== 'stop' && finishReason !== 'tool_calls') {
                                            push({ type: 'finish', reason: finishReason });
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

                        res.on('data', (data: Buffer) => {
                            buffer += data.toString();
                            const lines = buffer.split('\n');
                            buffer = lines.pop() ?? '';

                            for (const line of lines) {
                                const trimmed = line.trim();
                                if (!trimmed) { continue; }
                                if (trimmed === 'data: [DONE]') {
                                    push(null);
                                    return;
                                }
                                if (trimmed.startsWith('data: ')) {
                                    try {
                                        const json = JSON.parse(trimmed.slice(6));

                                        if (json.error) {
                                            const msg: string = json.error?.message ?? JSON.stringify(json.error);
                                            push({ type: 'stream_error', message: msg });
                                            push(null);
                                            return;
                                        }

                                        const delta = json.choices?.[0]?.delta as
                                            | { content?: string }
                                            | undefined;

                                        if (typeof delta?.content === 'string') {
                                            processContentChunk(delta.content);
                                        }

                                        const finishReason: string | undefined = json.choices?.[0]?.finish_reason;
                                        if (finishReason && finishReason !== 'stop' && finishReason !== 'tool_calls') {
                                            push({ type: 'finish', reason: finishReason });
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
                            push(null);
                        });
                        res.on('error', (err: Error) => {
                            if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') { push(null); }
                            else { push(err); }
                        });
                    }
                );

                req.on('error', (err: Error) => {
                    if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') { push(null); }
                    else { push(err); }
                });
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

/**
 * Non-streaming single-shot completion via Ollama's OpenAI-compatible endpoint.
 * Used for follow-up suggestions and other one-shot requests.
 */
export function ollamaChatCompletion(
    baseUrl: string,
    messages: ChatMessage[],
    model: string,
    maxTokens: number,
    signal?: AbortSignal
): Promise<string> {
    const { protocol, hostname, port, pathPrefix } = parseBaseUrl(baseUrl);
    const transport = protocol === 'https' ? https : http;

    const body = JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        stream: false,
    });

    return new Promise((resolve) => {
        if (signal?.aborted) { resolve(''); return; }

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
            },
            (res) => {
                let data = '';
                res.on('data', (c: Buffer) => { data += c.toString(); });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data)?.choices?.[0]?.message?.content ?? '');
                    } catch { resolve(''); }
                });
                res.on('error', () => resolve(''));
            }
        );

        signal?.addEventListener('abort', () => { req.destroy(); resolve(''); }, { once: true });
        req.on('error', () => resolve(''));
        req.write(body);
        req.end();
    });
}
