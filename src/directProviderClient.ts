import * as https from 'https';
import { ChatMessage, MessageContentPart, StreamChunk, SYSTEM_PROMPT } from './openRouterClient';
import { StreamCompletionGuard } from './streamCompletion';
import { NativeToolDefinition, NATIVE_TOOL_PROMPT, OpenAIToolCallAccumulator } from './nativeTools';

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
        id: 'openai', name: 'OpenAI', apiBase: 'api.openai.com', format: 'openai',
        models: [
            { id: 'gpt-4o', displayName: 'GPT-4o' },
            { id: 'gpt-4o-mini', displayName: 'GPT-4o Mini' },
            { id: 'o3', displayName: 'o3' },
            { id: 'o4-mini', displayName: 'o4-mini' },
        ],
    },
    {
        id: 'google', name: 'Google', apiBase: 'generativelanguage.googleapis.com', format: 'google',
        models: [
            { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
            { id: 'gemini-2.5-pro-preview-05-06', displayName: 'Gemini 2.5 Pro' },
            { id: 'gemini-1.5-flash-latest', displayName: 'Gemini 1.5 Flash' },
        ],
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
        id: 'deepseek', name: 'DeepSeek', apiBase: 'api.deepseek.com', format: 'openai',
        models: [
            { id: 'deepseek-chat', displayName: 'DeepSeek V3' },
            { id: 'deepseek-reasoner', displayName: 'DeepSeek R1' },
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

// ── <think> tag state machine (shared by OpenAI-compat streaming) ─────────────

function makeThinkParser(push: (v: StreamChunk) => void) {
    let inThinkBlock = false;
    return function processChunk(text: string): void {
        if (inThinkBlock) {
            const eIdx = text.indexOf('</think>');
            if (eIdx !== -1) {
                const inside = text.slice(0, eIdx);
                if (inside) { push({ type: 'thinking', text: inside }); }
                inThinkBlock = false;
                processChunk(text.slice(eIdx + 8));
            } else {
                push({ type: 'thinking', text });
            }
        } else {
            const tIdx = text.indexOf('<think>');
            if (tIdx !== -1) {
                const before = text.slice(0, tIdx);
                if (before) { push({ type: 'content', text: before }); }
                inThinkBlock = true;
                processChunk(text.slice(tIdx + 7));
            } else {
                if (text) { push({ type: 'content', text }); }
            }
        }
    };
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
    nativeTools: NativeToolDefinition[]
): void {
    const messages = [{ role: 'system' as const, content: system }, ...history];
    const body = JSON.stringify({
        model: modelId,
        messages,
        stream: true,
        max_tokens: 8192,
        stream_options: { include_usage: true },
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
    });

    const req = https.request(
        { hostname: apiBase, path: '/v1/chat/completions', method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => {
            if (res.statusCode && res.statusCode >= 400) {
                let e = ''; res.on('data', (d: Buffer) => { e += d; });
                res.on('end', () => { push(new Error(`${apiBase} HTTP ${res.statusCode}: ${e.slice(0, 300)}`)); push(null); });
                return;
            }
            let buf = '';
            const completion = new StreamCompletionGuard();
            const nativeCalls = new OpenAIToolCallAccumulator();
            const processChunk = makeThinkParser(push as (v: StreamChunk) => void);
            const emitNativeCalls = (final = false): void => {
                for (const call of nativeCalls.flushReady()) { push({ type: 'native_tool', call }); }
                if (final && nativeCalls.hasPending) {
                    push({
                        type: 'stream_error',
                        message: `${apiBase} returned malformed native tool arguments for: ${nativeCalls.pendingNames().join(', ')}`,
                    });
                }
            };
            res.on('data', (chunk: Buffer) => {
                buf += chunk.toString();
                const lines = buf.split('\n'); buf = lines.pop() ?? '';
                for (const line of lines) {
                    const t = line.trim();
                    if (!t.startsWith('data:')) { continue; }
                    const raw = t.slice(5).trim();
                    if (raw === '[DONE]') {
                        completion.markTerminal();
                        emitNativeCalls(true);
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
                        if (delta?.reasoning) { push({ type: 'thinking', text: delta.reasoning }); }
                        if (typeof delta?.content === 'string' && delta.content) { processChunk(delta.content); }
                        for (const toolCall of delta?.tool_calls ?? []) { nativeCalls.add(toolCall); }
                        const finishReason = json.choices?.[0]?.finish_reason as string | null | undefined;
                        if (finishReason) {
                            completion.markTerminal();
                            emitNativeCalls(true);
                            if (finishReason !== 'stop' && finishReason !== 'tool_calls') { push({ type: 'finish', reason: finishReason }); }
                        }
                        const u = json.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
                        if (u != null && u.total_tokens != null) { push({ type: 'usage', promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0, totalTokens: u.total_tokens }); }
                    } catch { /* malformed SSE */ }
                }
            });
            res.on('end', () => {
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
    req.write(body); req.end();
}

// ── Anthropic streaming ───────────────────────────────────────────────────────

type AnthropicPart =
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

function _toAnthropicContent(content: string | MessageContentPart[]): string | AnthropicPart[] {
    if (typeof content === 'string') { return content; }
    const parts: AnthropicPart[] = [];
    for (const p of content) {
        if (p.type === 'text') {
            parts.push({ type: 'text', text: p.text });
        } else if (p.type === 'image_url') {
            const m = p.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
            if (m) { parts.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }); }
        }
    }
    // Fallback: if all image parts failed the data-URI check, avoid sending an empty array (Anthropic 400).
    if (parts.length === 0) { return '[image]'; }
    return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
}

function _streamAnthropic(
    apiKey: string,
    modelId: string,
    history: ChatMessage[],
    system: string,
    signal: AbortSignal | undefined,
    push: (v: StreamChunk | null | Error) => void,
    nativeTools: NativeToolDefinition[]
): void {
    const messages = history
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: _toAnthropicContent(m.content) }));

    const body = JSON.stringify({
        model: modelId,
        system,
        messages,
        max_tokens: 8192,
        stream: true,
        ...(nativeTools.length > 0 ? {
            tools: nativeTools.map(tool => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
            })),
        } : {}),
    });

    const req = https.request(
        { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => {
            if (res.statusCode && res.statusCode >= 400) {
                let e = ''; res.on('data', (d: Buffer) => { e += d; });
                res.on('end', () => { push(new Error(`Anthropic HTTP ${res.statusCode}: ${e.slice(0, 300)}`)); push(null); });
                return;
            }
            let buf = '';
            let lastEvent = '';
            const completion = new StreamCompletionGuard();
            const toolBlocks = new Map<number, { id?: string; name: string; args: string }>();
            let inputTokens = 0;
            let outputTokens = 0;

            res.on('data', (chunk: Buffer) => {
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
                            inputTokens = json.message?.usage?.input_tokens ?? 0;
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
                            if (total > 0) { push({ type: 'usage', promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: total }); }
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
    req.write(body); req.end();
}

// ── Google Gemini streaming ───────────────────────────────────────────────────

type GeminiPart = { text?: string; inlineData?: { mimeType: string; data: string } };

function _toGeminiMessages(history: ChatMessage[]): Array<{ role: string; parts: GeminiPart[] }> {
    return history.filter(m => m.role !== 'system').map(m => {
        const role = m.role === 'assistant' ? 'model' : 'user';
        if (typeof m.content === 'string') { return { role, parts: [{ text: m.content }] }; }
        const parts: GeminiPart[] = (m.content as MessageContentPart[]).map(p => {
            if (p.type === 'text') { return { text: p.text }; }
            if (p.type === 'image_url') {
                const match = p.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
                if (match) { return { inlineData: { mimeType: match[1], data: match[2] } }; }
            }
            return { text: '' };
        });
        return { role, parts };
    });
}

function _streamGoogle(
    apiKey: string,
    modelId: string,
    history: ChatMessage[],
    system: string,
    signal: AbortSignal | undefined,
    push: (v: StreamChunk | null | Error) => void,
    nativeTools: NativeToolDefinition[]
): void {
    const body = JSON.stringify({
        contents: _toGeminiMessages(history),
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: { maxOutputTokens: 8192 },
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
    });

    const req = https.request(
        { hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => {
            if (res.statusCode && res.statusCode >= 400) {
                let e = ''; res.on('data', (d: Buffer) => { e += d; });
                res.on('end', () => { push(new Error(`Google HTTP ${res.statusCode}: ${e.slice(0, 300)}`)); push(null); });
                return;
            }
            let buf = '';
            const completion = new StreamCompletionGuard();
            const emittedFunctionCalls = new Set<string>();
            res.on('data', (chunk: Buffer) => {
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
                                if (typeof part.text === 'string' && part.text) { push({ type: 'content', text: part.text }); }
                                const fn = part.functionCall;
                                if (fn?.name && fn.args && typeof fn.args === 'object' && !Array.isArray(fn.args)) {
                                    const key = `${fn.name}:${JSON.stringify(fn.args)}`;
                                    if (!emittedFunctionCalls.has(key)) {
                                        emittedFunctionCalls.add(key);
                                        push({ type: 'native_tool', call: { name: fn.name, arguments: fn.args } });
                                    }
                                }
                            }
                            if (cand.finishReason) {
                                completion.markTerminal();
                                if (cand.finishReason !== 'STOP') { push({ type: 'finish', reason: cand.finishReason }); }
                            }
                        }
                        const u = json.usageMetadata;
                        if (u != null && u.totalTokenCount != null) { push({ type: 'usage', promptTokens: u.promptTokenCount ?? 0, completionTokens: u.candidatesTokenCount ?? 0, totalTokens: u.totalTokenCount }); }
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
    req.write(body); req.end();
}

// ── Public streaming API ──────────────────────────────────────────────────────

export function streamDirect(
    apiKey: string,
    history: ChatMessage[],
    providerId: string,
    modelId: string,
    systemPromptPrefix?: string,
    signal?: AbortSignal,
    _thinkingEffort?: 'high' | 'medium' | 'low',
    overrideSystemPrompt?: string,
    nativeTools: NativeToolDefinition[] = []
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
            case 'openai':     _streamOpenAICompat(apiKey, provider.apiBase, modelId, history, system, signal, push, nativeTools); break;
            case 'anthropic':  _streamAnthropic(apiKey, modelId, history, system, signal, push, nativeTools);                      break;
            case 'google':     _streamGoogle(apiKey, modelId, history, system, signal, push, nativeTools);                         break;
        }
    }

    return iterable;
}

// ── Non-streaming single completion (follow-ups, compact, commit) ─────────────

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
            reqBody = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } });
            reqOpts = {
                hostname: 'generativelanguage.googleapis.com',
                path: `/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) },
            };
        } else {
            reqBody = JSON.stringify({ model: modelId, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens });
            reqOpts = {
                hostname: provider.apiBase, path: '/v1/chat/completions', method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) },
            };
        }

        const req = https.request(reqOpts, (res) => {
            let data = ''; let totalBytes = 0; let bodyDestroyed = false;
            res.on('data', (c: Buffer) => {
                totalBytes += c.length;
                if (totalBytes > 256 * 1024) { bodyDestroyed = true; res.destroy(); done(''); return; }
                data += c.toString();
            });
            res.on('end', () => {
                if (bodyDestroyed) { return; }
                try {
                    const json = JSON.parse(data);
                    if (provider.format === 'anthropic') { done(json.content?.[0]?.text ?? ''); }
                    else if (provider.format === 'google') { done(json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''); }
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
