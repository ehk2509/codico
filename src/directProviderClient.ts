import * as http from 'http';
import * as https from 'https';
import { ChatMessage, MessageContentPart, OpenRouterEndpoint, StreamChunk, SYSTEM_PROMPT } from './openRouterClient';
import type { ProviderRequestOptimizer } from './accoProviderOptimizer';
import { deepseekAdapter, OpenAICompatAdapter } from './deepseekAdapter';
import { GEMINI_MODELS, geminiGenerationConfig, geminiQuickConfig, geminiUsage, SKIP_THOUGHT_SIGNATURE, usesThoughtSignatures } from './geminiAdapter';
import { OPENAI_MODELS, openaiAdapter } from './openaiAdapter';
import { StreamCompletionGuard, ThinkTagSplitter, watchStreamStall } from './streamCompletion';
import { NativeToolDefinition, NATIVE_TOOL_PROMPT, OpenAIToolCallAccumulator } from './nativeTools';
import { toAnthropicMessages, toGeminiMessages, toOpenAIMessages } from './providerConversation';

// ── Provider registry ─────────────────────────────────────────────────────────

export interface DirectProviderModel {
    id: string;
    displayName: string;
}

export interface DirectProvider {
    id: string;
    name: string;
    apiBase: string;
    format: 'openai' | 'anthropic' | 'google';
    models: DirectProviderModel[];
    /** Where this provider's OpenAI-compatible API departs from the generic protocol. */
    adapter?: OpenAICompatAdapter;
}

export const DIRECT_PROVIDERS: readonly DirectProvider[] = [
    {
        id: 'anthropic', name: 'Anthropic', apiBase: 'api.anthropic.com', format: 'anthropic',
        models: [
            { id: 'claude-opus-4-5', displayName: 'Claude Opus 4.5' },
            { id: 'claude-sonnet-4-5-20251001', displayName: 'Claude Sonnet 4.5' },
            { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5' },
            { id: 'claude-3-5-sonnet-20241022', displayName: 'Claude 3.5 Sonnet' },
        ],
    },
    {
        id: 'openai', name: 'OpenAI', apiBase: 'api.openai.com', format: 'openai', adapter: openaiAdapter,
        models: OPENAI_MODELS,
    },
    {
        id: 'google', name: 'Google', apiBase: 'generativelanguage.googleapis.com', format: 'google',
        models: GEMINI_MODELS,
    },
    {
        id: 'groq', name: 'Groq', apiBase: 'api.groq.com', format: 'openai',
        models: [
            { id: 'llama-3.3-70b-versatile', displayName: 'Llama 3.3 70B' },
            { id: 'llama-3.1-8b-instant', displayName: 'Llama 3.1 8B Instant' },
            { id: 'deepseek-r1-distill-llama-70b', displayName: 'DeepSeek R1 70B' },
        ],
    },
    {
        id: 'deepseek', name: 'DeepSeek', apiBase: 'api.deepseek.com', format: 'openai', adapter: deepseekAdapter,
        models: [
            { id: 'deepseek-flash', displayName: 'DeepSeek V4.1 Flash' },
            { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
        ],
    },
    {
        id: 'mistral', name: 'Mistral', apiBase: 'api.mistral.ai', format: 'openai',
        models: [
            { id: 'mistral-large-latest', displayName: 'Mistral Large' },
            { id: 'codestral-latest', displayName: 'Codestral' },
            { id: 'mistral-small-latest', displayName: 'Mistral Small' },
        ],
    },
    {
        id: 'grok', name: 'Grok (xAI)', apiBase: 'api.x.ai', format: 'openai',
        models: [
            { id: 'grok-3', displayName: 'Grok 3' },
            { id: 'grok-3-mini', displayName: 'Grok 3 Mini' },
        ],
    },
    {
        id: 'cerebras', name: 'Cerebras', apiBase: 'api.cerebras.ai', format: 'openai',
        models: [
            { id: 'llama-4-scout-17b-16e-instruct', displayName: 'Llama 4 Scout 17B' },
            { id: 'llama3.1-70b', displayName: 'Llama 3.1 70B' },
        ],
    },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse `direct:providerId/modelId` → parts, or null if malformed. */
export function parseDirectModelId(fullId: string): { providerId: string; modelId: string } | null {
    if (!fullId.startsWith('direct:')) { return null; }
    const rest = fullId.slice('direct:'.length);
    const slash = rest.indexOf('/');
    if (slash < 1) { return null; }
    return { providerId: rest.slice(0, slash), modelId: rest.slice(slash + 1) };
}

export function getDirectProvider(providerId: string): DirectProvider | undefined {
    return DIRECT_PROVIDERS.find(p => p.id === providerId);
}

/** OpenRouter vendor prefix (`deepseek/…`) → the direct provider that serves the same vendor's models. */
const VENDOR_PROVIDER: Record<string, string> = {
    deepseek: 'deepseek', anthropic: 'anthropic', openai: 'openai', google: 'google', 'x-ai': 'grok', mistralai: 'mistral',
};

/**
 * A direct model to use in place of an OpenRouter model when there is no OpenRouter key:
 * the same vendor's provider if its key is set, otherwise the first provider with a key.
 */
export function pickDirectFallback(model: string, providersWithKey: readonly string[]): string | undefined {
    const vendor = VENDOR_PROVIDER[model.split('/')[0]];
    const id = vendor && providersWithKey.includes(vendor) ? vendor : providersWithKey[0];
    const provider = id ? getDirectProvider(id) : undefined;
    return provider ? `direct:${provider.id}/${provider.models[0].id}` : undefined;
}

/** VS Code secrets key name for a given direct provider. */
export function directSecretKey(providerId: string): string {
    return `directApiKey.${providerId}`;
}

// ── Queue-based async iterator ────────────────────────────────────────────────

function makeQueue<T>(): { push: (v: T | null | Error) => void; iterable: AsyncIterable<T> } {
    const queue: Array<T | null | Error> = [];
    // Array of pending resolvers — supports concurrent next() calls safely.
    const waiters: Array<() => void> = [];
    function wake() {
        if (waiters.length > 0 && queue.length > 0) { waiters.shift()!(); }
    }
    return {
        push(v) { queue.push(v); wake(); },
        iterable: {
            [Symbol.asyncIterator]() {
                return {
                    async next(): Promise<IteratorResult<T>> {
                        while (queue.length === 0) { await new Promise<void>(r => { waiters.push(r); }); }
                        const item = queue.shift()!;
                        if (item === null) { return { value: undefined as unknown as T, done: true }; }
                        if (item instanceof Error) { throw item; }
                        return { value: item, done: false };
                    },
                };
            },
        },
    };
}

/**
 * Sends a request body, first through the optional optimizer. Optimization is strictly
 * fail-open: an unavailable or faulty optimizer must never prevent the model request.
 * @param format the request shape, as the optimizer names it
 */
function sendOptimized(
    optimizer: ProviderRequestOptimizer | undefined,
    format: 'openai' | 'anthropic' | 'gemini',
    requestBody: Record<string, unknown>,
    signal: AbortSignal | undefined,
    push: (v: StreamChunk | null | Error) => void,
    send: (body: string) => void
): void {
    if (!optimizer) { send(JSON.stringify(requestBody)); return; }
    optimizer.optimize(format, requestBody).catch(() => requestBody).then(optimized => {
        if (signal?.aborted) { push(null); return; }
        try { send(JSON.stringify(optimized)); } catch (err) { push(err instanceof Error ? err : new Error(String(err))); push(null); }
    });
}

// ── OpenAI-compatible streaming ───────────────────────────────────────────────

function _streamOpenAICompat(
    apiKey: string,
    apiBase: string,
    modelId: string,
    history: ChatMessage[],
    system: string,
    signal: AbortSignal | undefined,
    push: (v: StreamChunk | null | Error) => void,
    nativeTools: NativeToolDefinition[],
    adapter?: OpenAICompatAdapter,
    effort: 'high' | 'medium' | 'low' = 'medium',
    endpoint?: OpenRouterEndpoint,
    /** Leave out the adapter's extra fields (a retry after the API refused one of them). */
    plain = false,
    optimizer?: ProviderRequestOptimizer
): void {
    const replayField = adapter?.replayReasoning ? adapter.reasoningField : undefined;
    const messages = toOpenAIMessages([{ role: 'system', content: system }, ...history], nativeTools.length > 0, replayField);
    const requestBody: Record<string, unknown> = {
        model: adapter?.modelId(modelId) ?? modelId,
        messages,
        stream: true,
        [adapter?.maxTokensField ?? 'max_tokens']: adapter?.maxTokens(modelId) ?? 8192,
        stream_options: { include_usage: true },
        ...(plain ? {} : adapter?.body(modelId, effort)),
        ...(nativeTools.length > 0 ? {
            tools: nativeTools.map(tool => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                },
            })),
            tool_choice: 'auto',
        } : {}),
    };

    const send = (body: string): void => {
        // `endpoint` is for automated tests only (evaluation mode): a normal install talks to apiBase over HTTPS
        const transport = endpoint?.protocol === 'http:' ? http : https;
        const req = transport.request(
            { hostname: endpoint?.hostname ?? apiBase, port: endpoint?.port, path: endpoint?.path ?? '/v1/chat/completions', method: 'POST',
              headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
            (res) => {
                if (res.statusCode && res.statusCode >= 400) {
                    res.setEncoding('utf8'); // keeps characters split across chunks intact
                    let e = ''; res.on('data', (d: string) => { e += d; });
                    res.on('end', () => {
                        // An option this model does not take (e.g. an effort level): once more without the extras
                        const extras = plain || !adapter ? [] : Object.keys(adapter.body(modelId, effort));
                        if (res.statusCode === 400 && extras.some(field => e.includes(field)) && !signal?.aborted) {
                            _streamOpenAICompat(apiKey, apiBase, modelId, history, system, signal, push, nativeTools, adapter, effort, endpoint, true, optimizer);
                            return;
                        }
                        if (nativeTools.length > 0 && /tool|function|unsupported|not supported/i.test(e) && !signal?.aborted) {
                            push({ type: 'thinking', text: '\n[Native tools unavailable for this model — retrying with compatibility tool format…]\n' });
                            _streamOpenAICompat(apiKey, apiBase, modelId, history, system, signal, push, [], adapter, effort, endpoint, plain, optimizer);
                            return;
                        }
                        push(new Error(`${apiBase} HTTP ${res.statusCode}: ${e.slice(0, 300)}`));
                        push(null);
                    });
                    return;
                }
                let buf = '';
                const completion = new StreamCompletionGuard();
                const nativeCalls = new OpenAIToolCallAccumulator();
                const think = new ThinkTagSplitter((type, text) => push({ type, text }));
                // The reply's reasoning, sent on as one chunk so the caller can store it for replay
                let reasoningText = '';
                let reasoningSent = false;
                const finishReasoning = (): void => {
                    if (replayField && reasoningText && !reasoningSent) { reasoningSent = true; push({ type: 'reasoning', text: reasoningText }); }
                };
                const emitNativeCalls = (final = false): void => {
                    for (const call of nativeCalls.flushReady()) { push({ type: 'native_tool', call }); }
                    if (final && nativeCalls.hasPending) {
                        push({
                            type: 'stream_error',
                            message: `${apiBase} returned malformed native tool arguments for: ${nativeCalls.pendingNames().join(', ')}`,
                        });
                    }
                };
                res.setEncoding('utf8'); // keeps characters split across chunks intact
                res.on('data', (chunk: string) => {
                    buf += chunk.toString();
                    const lines = buf.split('\n'); buf = lines.pop() ?? '';
                    for (const line of lines) {
                        const t = line.trim();
                        if (!t.startsWith('data:')) { continue; }
                        const raw = t.slice(5).trim();
                        if (raw === '[DONE]') {
                            completion.markTerminal();
                            think.flush();
                            emitNativeCalls(true);
                            finishReasoning();
                            push(null);
                            return;
                        }
                        try {
                            const json = JSON.parse(raw);
                            if (json.error) {
                                completion.markTerminal();
                                push({ type: 'stream_error', message: json.error?.message ?? String(json.error) });
                                push(null);
                                return;
                            }
                            const delta = json.choices?.[0]?.delta as {
                                content?: string;
                                reasoning?: string;
                                tool_calls?: Array<{
                                    index?: number;
                                    id?: string;
                                    function?: { name?: string; arguments?: string };
                                }>;
                            } | undefined;
                            // delta.reasoning is an explicit thinking field (e.g. some providers); delta.content
                            // may also contain <think> blocks for models like DeepSeek-R1 on Groq/DeepSeek direct.
                            const adapted = adapter ? (delta as Record<string, unknown> | undefined)?.[adapter.reasoningField] : undefined;
                            const reasoning = delta?.reasoning || (typeof adapted === 'string' ? adapted : '');
                            if (reasoning) { reasoningText += reasoning; push({ type: 'thinking', text: reasoning }); }
                            if (typeof delta?.content === 'string' && delta.content) { think.push(delta.content); }
                            for (const toolCall of delta?.tool_calls ?? []) { nativeCalls.add(toolCall); }
                            const finishReason = json.choices?.[0]?.finish_reason as string | null | undefined;
                            if (finishReason) {
                                completion.markTerminal();
                                emitNativeCalls(true);
                                if (finishReason !== 'stop' && finishReason !== 'tool_calls') { push({ type: 'finish', reason: finishReason }); }
                            }
                            const u = json.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined;
                            if (u != null && u.total_tokens != null) {
                                // Cache hits: the provider's own field (DeepSeek), or OpenAI's prompt_tokens_details
                                const cached = adapter?.cachedTokens(u as Record<string, unknown>) ?? (u.prompt_tokens_details?.cached_tokens || undefined);
                                push({ type: 'usage', promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0, totalTokens: u.total_tokens, ...(cached ? { cachedTokens: cached } : {}) });
                            }
                        } catch { /* malformed SSE */ }
                    }
                });
                res.on('end', () => {
                    think.flush();
                    finishReasoning();
                    if (!signal?.aborted) {
                        const interrupted = completion.unexpectedEofMessage(apiBase);
                        if (interrupted) { push({ type: 'stream_error', message: interrupted }); }
                    }
                    push(null);
                });
                res.on('error', (e: Error) => {
                    if ((e as NodeJS.ErrnoException).code === 'ABORT_ERR' || signal?.aborted) {
                        push(null);
                    } else {
                        push({ type: 'stream_error', message: `${apiBase} stream transport error: ${e.message}` });
                        push(null);
                    }
                });
            }
        );
        req.on('error', (e: Error) => {
            if ((e as NodeJS.ErrnoException).code === 'ABORT_ERR' || signal?.aborted) {
                push(null);
            } else {
                push({ type: 'stream_error', message: `${apiBase} stream transport error: ${e.message}` });
                push(null);
            }
        });
        if (signal) { signal.addEventListener('abort', () => req.destroy(), { once: true }); }
        watchStreamStall(req);
        req.write(body); req.end();
    };
    sendOptimized(optimizer, 'openai', requestBody, signal, push, send);
}

// ── Anthropic streaming ───────────────────────────────────────────────────────

function _streamAnthropic(
    apiKey: string,
    modelId: string,
    history: ChatMessage[],
    system: string,
    signal: AbortSignal | undefined,
    push: (v: StreamChunk | null | Error) => void,
    nativeTools: NativeToolDefinition[],
    optimizer?: ProviderRequestOptimizer
): void {
    const messages = toAnthropicMessages(history, nativeTools.length > 0);

    const requestBody: Record<string, unknown> = {
        model: modelId,
        system,
        messages,
        max_tokens: 8192,
        stream: true,
        // Caches the request up to its last block; the next request in the task reuses it
        cache_control: { type: 'ephemeral' },
        ...(nativeTools.length > 0 ? {
            tools: nativeTools.map(tool => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
            })),
        } : {}),
    };

    const send = (body: string): void => {
        const req = https.request(
            { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
              headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
            (res) => {
                if (res.statusCode && res.statusCode >= 400) {
                    res.setEncoding('utf8'); // keeps characters split across chunks intact
                    let e = ''; res.on('data', (d: string) => { e += d; });
                    res.on('end', () => {
                        if (nativeTools.length > 0 && /tool|function|unsupported|not supported/i.test(e) && !signal?.aborted) {
                            push({ type: 'thinking', text: '\n[Native tools unavailable for this model — retrying with compatibility tool format…]\n' });
                            _streamAnthropic(apiKey, modelId, history, system, signal, push, [], optimizer);
                            return;
                        }
                        push(new Error(`Anthropic HTTP ${res.statusCode}: ${e.slice(0, 300)}`));
                        push(null);
                    });
                    return;
                }
                let buf = '';
                let lastEvent = '';
                const completion = new StreamCompletionGuard();
                const toolBlocks = new Map<number, { id?: string; name: string; args: string }>();
                let inputTokens = 0;
                let cachedTokens = 0;
                let outputTokens = 0;

                res.setEncoding('utf8'); // keeps characters split across chunks intact
                res.on('data', (chunk: string) => {
                    buf += chunk.toString();
                    const lines = buf.split('\n'); buf = lines.pop() ?? '';
                    for (const line of lines) {
                        const t = line.trim();
                        if (t.startsWith('event:')) { lastEvent = t.slice(6).trim(); continue; }
                        if (!t.startsWith('data:')) { continue; }
                        const raw = t.slice(5).trim();
                        if (!raw) { continue; }
                        try {
                            const json = JSON.parse(raw);
                            const type = json.type ?? lastEvent;
                            lastEvent = '';
                            if (type === 'message_start') {
                                // input_tokens excludes cached tokens: the prompt is all three together
                                const u = json.message?.usage ?? {};
                                cachedTokens = u.cache_read_input_tokens ?? 0;
                                inputTokens = (u.input_tokens ?? 0) + cachedTokens + (u.cache_creation_input_tokens ?? 0);
                            } else if (type === 'content_block_start') {
                                const block = json.content_block ?? {};
                                if (block.type === 'tool_use' && block.name) {
                                    toolBlocks.set(json.index ?? 0, {
                                        id: block.id,
                                        name: block.name,
                                        args: block.input && typeof block.input === 'object' && Object.keys(block.input).length > 0
                                            ? JSON.stringify(block.input)
                                            : '',
                                    });
                                }
                            } else if (type === 'content_block_delta') {
                                const d = json.delta ?? {};
                                if (d.type === 'thinking_delta' && d.thinking) { push({ type: 'thinking', text: d.thinking }); }
                                else if (d.type === 'text_delta' && d.text) { push({ type: 'content', text: d.text }); }
                                else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
                                    const block = toolBlocks.get(json.index ?? 0);
                                    if (block) { block.args += d.partial_json; }
                                }
                            } else if (type === 'content_block_stop') {
                                const index = json.index ?? 0;
                                const block = toolBlocks.get(index);
                                if (block) {
                                    try {
                                        const parsed = block.args.trim() ? JSON.parse(block.args) : {};
                                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                                            push({ type: 'native_tool', call: { id: block.id, name: block.name, arguments: parsed } });
                                        } else {
                                            push({ type: 'stream_error', message: `Anthropic returned non-object arguments for native tool ${block.name}` });
                                        }
                                    } catch {
                                        push({ type: 'stream_error', message: `Anthropic returned malformed native tool arguments for ${block.name}` });
                                    }
                                    toolBlocks.delete(index);
                                }
                            } else if (type === 'message_delta') {
                                outputTokens = json.usage?.output_tokens ?? outputTokens;
                                const stop = json.delta?.stop_reason;
                                if (stop) {
                                    completion.markTerminal();
                                    if (stop !== 'end_turn' && stop !== 'tool_use') { push({ type: 'finish', reason: stop }); }
                                }
                            } else if (type === 'message_stop') {
                                completion.markTerminal();
                                const total = inputTokens + outputTokens;
                                if (total > 0) { push({ type: 'usage', promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: total, ...(cachedTokens ? { cachedTokens } : {}) }); }
                                push(null);
                            }
                        } catch { /* malformed */ }
                    }
                });
                // push(null) here is deduplicated by the done-guard in streamDirect (message_stop already sent null)
                res.on('end', () => {
                    if (!signal?.aborted) {
                        const interrupted = completion.unexpectedEofMessage('Anthropic');
                        if (interrupted) { push({ type: 'stream_error', message: interrupted }); }
                    }
                    push(null);
                });
                res.on('error', (e: Error) => {
                    if ((e as NodeJS.ErrnoException).code === 'ABORT_ERR' || signal?.aborted) {
                        push(null);
                    } else {
                        push({ type: 'stream_error', message: `Anthropic stream transport error: ${e.message}` });
                        push(null);
                    }
                });
            }
        );
        req.on('error', (e: Error) => {
            if ((e as NodeJS.ErrnoException).code === 'ABORT_ERR' || signal?.aborted) {
                push(null);
            } else {
                push({ type: 'stream_error', message: `Anthropic stream transport error: ${e.message}` });
                push(null);
            }
        });
        if (signal) { signal.addEventListener('abort', () => req.destroy(), { once: true }); }
        watchStreamStall(req);
        req.write(body); req.end();
    };
    sendOptimized(optimizer, 'anthropic', requestBody, signal, push, send);
}

// ── Google Gemini streaming ───────────────────────────────────────────────────

function _streamGoogle(
    apiKey: string,
    modelId: string,
    history: ChatMessage[],
    system: string,
    signal: AbortSignal | undefined,
    push: (v: StreamChunk | null | Error) => void,
    nativeTools: NativeToolDefinition[],
    effort: 'high' | 'medium' | 'low' = 'medium',
    /** false: leave the thinking options out (a retry after the API refused them). */
    thinking = true,
    optimizer?: ProviderRequestOptimizer
): void {
    const requestBody: Record<string, unknown> = {
        contents: toGeminiMessages(history, nativeTools.length > 0, usesThoughtSignatures(modelId) ? SKIP_THOUGHT_SIGNATURE : undefined),
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: geminiGenerationConfig(modelId, effort, thinking),
        ...(nativeTools.length > 0 ? {
            tools: [{
                functionDeclarations: nativeTools.map(tool => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                })),
            }],
            toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        } : {}),
    };

    const send = (body: string): void => {
        const req = https.request(
            { hostname: 'generativelanguage.googleapis.com',
              path: `/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
            (res) => {
                if (res.statusCode && res.statusCode >= 400) {
                    res.setEncoding('utf8'); // keeps characters split across chunks intact
                    let e = ''; res.on('data', (d: string) => { e += d; });
                    res.on('end', () => {
                        // A thinking option this model does not take (e.g. a level): once more without them
                        if (thinking && res.statusCode === 400 && /thinking/i.test(e) && !signal?.aborted) {
                            _streamGoogle(apiKey, modelId, history, system, signal, push, nativeTools, effort, false, optimizer);
                            return;
                        }
                        if (nativeTools.length > 0 && /tool|function|unsupported|not supported/i.test(e) && !signal?.aborted) {
                            push({ type: 'thinking', text: '\n[Native tools unavailable for this model — retrying with compatibility tool format…]\n' });
                            _streamGoogle(apiKey, modelId, history, system, signal, push, [], effort, thinking, optimizer);
                            return;
                        }
                        push(new Error(`Google HTTP ${res.statusCode}: ${e.slice(0, 300)}`));
                        push(null);
                    });
                    return;
                }
                let buf = '';
                const completion = new StreamCompletionGuard();
                const emittedFunctionCalls = new Set<string>();
                res.setEncoding('utf8'); // keeps characters split across chunks intact
                res.on('data', (chunk: string) => {
                    buf += chunk.toString();
                    const lines = buf.split('\n'); buf = lines.pop() ?? '';
                    for (const line of lines) {
                        const t = line.trim();
                        if (!t.startsWith('data:')) { continue; }
                        const raw = t.slice(5).trim();
                        if (!raw) { continue; }
                        if (raw === '[DONE]') {
                            completion.markTerminal();
                            push(null);
                            return;
                        }
                        try {
                            const json = JSON.parse(raw);
                            const cand = json.candidates?.[0];
                            if (cand) {
                                for (const part of cand.content?.parts ?? []) {
                                    // A thought summary (asked for with includeThoughts) is not part of the answer
                                    if (typeof part.text === 'string' && part.text) { push({ type: part.thought === true ? 'thinking' : 'content', text: part.text }); }
                                    const fn = part.functionCall;
                                    if (fn?.name && fn.args && typeof fn.args === 'object' && !Array.isArray(fn.args)) {
                                        const key = `${fn.name}:${JSON.stringify(fn.args)}`;
                                        if (!emittedFunctionCalls.has(key)) {
                                            emittedFunctionCalls.add(key);
                                            push({ type: 'native_tool', call: { name: fn.name, arguments: fn.args, ...(typeof part.thoughtSignature === 'string' ? { signature: part.thoughtSignature } : {}) } });
                                        }
                                    }
                                }
                                if (cand.finishReason) {
                                    completion.markTerminal();
                                    if (cand.finishReason !== 'STOP') { push({ type: 'finish', reason: cand.finishReason }); }
                                }
                            }
                            const usage = geminiUsage(json.usageMetadata);
                            if (usage) { push({ type: 'usage', ...usage }); }
                        } catch { /* malformed */ }
                    }
                });
                res.on('end', () => {
                    if (!signal?.aborted) {
                        const interrupted = completion.unexpectedEofMessage('Google Gemini');
                        if (interrupted) { push({ type: 'stream_error', message: interrupted }); }
                    }
                    push(null);
                });
                res.on('error', (e: Error) => {
                    if ((e as NodeJS.ErrnoException).code === 'ABORT_ERR' || signal?.aborted) {
                        push(null);
                    } else {
                        push({ type: 'stream_error', message: `Google Gemini stream transport error: ${e.message}` });
                        push(null);
                    }
                });
            }
        );
        req.on('error', (e: Error) => {
            if ((e as NodeJS.ErrnoException).code === 'ABORT_ERR' || signal?.aborted) {
                push(null);
            } else {
                push({ type: 'stream_error', message: `Google Gemini stream transport error: ${e.message}` });
                push(null);
            }
        });
        if (signal) { signal.addEventListener('abort', () => req.destroy(), { once: true }); }
        watchStreamStall(req);
        req.write(body); req.end();
    };
    sendOptimized(optimizer, 'gemini', requestBody, signal, push, send);
}

// ── Public streaming API ──────────────────────────────────────────────────────

export function streamDirect(
    apiKey: string,
    history: ChatMessage[],
    providerId: string,
    modelId: string,
    systemPromptPrefix?: string,
    signal?: AbortSignal,
    thinkingEffort?: 'high' | 'medium' | 'low',
    overrideSystemPrompt?: string,
    nativeTools: NativeToolDefinition[] = [],
    /** Automated tests only (evaluation mode); OpenAI-compatible providers. */
    endpoint?: OpenRouterEndpoint,
    /** Optional local optimizer (ACCO) the request body passes through before it is sent. */
    requestOptimizer?: ProviderRequestOptimizer
): AsyncIterable<StreamChunk> {
    const provider = getDirectProvider(providerId);
    if (!provider) {
        return {
            [Symbol.asyncIterator]() {
                return { async next() { throw new Error(`Unknown direct provider: "${providerId}"`); } };
            },
        };
    }

    const baseSystem = overrideSystemPrompt ?? SYSTEM_PROMPT;
    const toolSystem = nativeTools.length > 0 ? `${baseSystem}\n\n${NATIVE_TOOL_PROMPT}` : baseSystem;
    const system = systemPromptPrefix ? `${toolSystem}\n\n${systemPromptPrefix}` : toolSystem;
    const { push: rawPush, iterable } = makeQueue<StreamChunk>();

    // Deduplicate terminal signals: only the first push(null) or push(Error) takes effect.
    // This prevents double-termination from (a) the abort listener below + req.on('error') ABORT_ERR path,
    // and (b) message_stop (Anthropic) + res.on('end') firing a second null.
    let done = false;
    const push = (v: StreamChunk | null | Error): void => {
        if (v === null || v instanceof Error) {
            if (done) { return; }
            done = true;
        }
        rawPush(v);
    };

    if (signal?.aborted) {
        push(null);
    } else {
        // Abort listener ensures termination even when the signal fires before the HTTP request
        // object is created inside the format handler (pre-creation window).
        signal?.addEventListener('abort', () => push(null), { once: true });
        switch (provider.format) {
            case 'openai':     _streamOpenAICompat(apiKey, provider.apiBase, modelId, history, system, signal, push, nativeTools, provider.adapter, thinkingEffort, endpoint, false, requestOptimizer); break;
            case 'anthropic':  _streamAnthropic(apiKey, modelId, history, system, signal, push, nativeTools, requestOptimizer); break;
            case 'google':     _streamGoogle(apiKey, modelId, history, system, signal, push, nativeTools, thinkingEffort, true, requestOptimizer); break;
        }
    }

    return iterable;
}

// ── Non-streaming single completion (follow-ups, compact, commit) ─────────────

/** The answer of a Gemini reply: its text parts, without thought summaries. */
function googleAnswerText(parts: unknown): string {
    if (!Array.isArray(parts)) { return ''; }
    return (parts as Array<{ text?: unknown; thought?: unknown }>).filter(p => typeof p.text === 'string' && p.thought !== true).map(p => p.text as string).join('');
}

export async function directSingleCompletion(
    apiKey: string,
    providerId: string,
    modelId: string,
    prompt: string,
    maxTokens = 500,
    signal?: AbortSignal
): Promise<string> {
    const provider = getDirectProvider(providerId);
    if (!provider) { return ''; }
    if (signal?.aborted) { return ''; }

    return new Promise<string>((resolve) => {
        let resolved = false;
        const done = (v: string) => { if (!resolved) { resolved = true; resolve(v); } };

        let reqBody: string;
        let reqOpts: https.RequestOptions;

        if (provider.format === 'anthropic') {
            reqBody = JSON.stringify({ model: modelId, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens });
            reqOpts = {
                hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
                headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) },
            };
        } else if (provider.format === 'google') {
            reqBody = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: geminiQuickConfig(modelId, maxTokens) });
            reqOpts = {
                hostname: 'generativelanguage.googleapis.com',
                path: `/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) },
            };
        } else {
            reqBody = JSON.stringify({ model: provider.adapter?.modelId(modelId) ?? modelId, messages: [{ role: 'user', content: prompt }], [provider.adapter?.maxTokensField ?? 'max_tokens']: provider.adapter?.quickMaxTokens?.(modelId, maxTokens) ?? maxTokens, ...provider.adapter?.quickBody(modelId) });
            reqOpts = {
                hostname: provider.apiBase, path: '/v1/chat/completions', method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) },
            };
        }

        const req = https.request(reqOpts, (res) => {
            let data = ''; let totalBytes = 0; let bodyDestroyed = false;
            res.setEncoding('utf8'); // keeps characters split across chunks intact
            res.on('data', (c: string) => {
                totalBytes += c.length;
                if (totalBytes > 256 * 1024) { bodyDestroyed = true; res.destroy(); done(''); return; }
                data += c.toString();
            });
            res.on('end', () => {
                if (bodyDestroyed) { return; }
                try {
                    const json = JSON.parse(data);
                    if (provider.format === 'anthropic') { done(json.content?.[0]?.text ?? ''); }
                    else if (provider.format === 'google') { done(googleAnswerText(json.candidates?.[0]?.content?.parts)); }
                    else { done(json.choices?.[0]?.message?.content ?? ''); }
                } catch { done(''); }
            });
            res.on('error', () => done(''));
        });
        req.setTimeout(30_000, () => { req.destroy(); done(''); });
        req.on('error', () => done(''));
        if (signal) { signal.addEventListener('abort', () => { req.destroy(); done(''); }, { once: true }); }
        req.write(reqBody); req.end();
    });
}
