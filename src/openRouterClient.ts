import * as http from 'http';
import * as https from 'https';
import { StreamCompletionGuard, ThinkTagSplitter, watchStreamStall } from './streamCompletion';
import { NativeToolCall, NativeToolDefinition, NATIVE_TOOL_PROMPT, OpenAIToolCallAccumulator } from './nativeTools';
import { toOpenAIMessages } from './providerConversation';
import type { ProviderRequestOptimizer } from './accoProviderOptimizer';
import { UNTRUSTED_CONTENT_RULE } from './untrustedContent';

export type StreamChunk =
    | { type: 'thinking'; text: string }
    | { type: 'content'; text: string }
    | { type: 'usage'; promptTokens: number; completionTokens: number; totalTokens: number; /** Provider-reported cost in USD, when available (OpenRouter). */ costUsd?: number; /** Prompt tokens served from the provider's prompt cache. */ cachedTokens?: number }
    | { type: 'finish'; reason: string }       // non-'stop' finish_reason from the model
    | { type: 'native_tool'; call: NativeToolCall }
    | { type: 'stream_error'; message: string }; // error object inside an SSE event

export type MessageContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

export type ChatMessage =
    | { role: 'system'; content: string | MessageContentPart[] }
    | { role: 'user'; content: string | MessageContentPart[]; /** Identifies the turn this request started (edit, delete, regenerate). */ turnId?: string }
    | { role: 'assistant'; content: string | MessageContentPart[]; nativeToolCalls?: NativeToolCall[] }
    | { role: 'tool'; content: string; toolCallId: string; toolName: string };

export interface OpenRouterEndpoint {
    protocol?: 'http:' | 'https:';
    hostname: string;
    port?: number;
    path?: string;
}

/**
 * Endpoint override for automated tests only. Callers must only use this in the
 * VS Code test Extension Host (evaluation mode): a normal install never sends
 * the API key anywhere but openrouter.ai.
 */
export function testOpenRouterEndpoint(raw: string | undefined): OpenRouterEndpoint | undefined {
    if (!raw) { return undefined; }
    try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') { return undefined; }
        return {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port ? Number(url.port) : undefined,
            path: url.pathname === '/' ? undefined : url.pathname,
        };
    } catch {
        return undefined;
    }
}

export const CHAT_SYSTEM_PROMPT = `You are Codico, a helpful coding assistant inside Visual Studio Code.

## Tools (read-only)

\`\`\`read_file
filepath: <relative path>
\`\`\`
\`\`\`list_directory
dirpath: <relative path, or . for root>
\`\`\`
\`\`\`search_files
pattern: <text or regex>
glob: <optional, e.g. **/*.ts>
regex: true|false
\`\`\`
\`\`\`find_files
pattern: <filename or glob>
dirpath: <optional subdirectory>
\`\`\`
\`\`\`get_diagnostics
filepath: <relative path, or omit for workspace>
\`\`\`
\`\`\`fetch_url
url: <full URL>
\`\`\`
\`\`\`lsp_symbol
query: <symbol name>
\`\`\`

## Rules
1. Explore narrowly before answering: use search_files or find_files with task-specific identifiers to locate relevant code, then read only the most relevant files. Use read_file start_line/end_line around search matches for large files. Avoid broad directory scans unless the location is genuinely unknown.
2. Give precise, code-grounded answers with file paths and line references where relevant.
3. Do NOT emit write_file, edit_file, run_terminal, or any browser tool calls — you are in read-only Ask mode.
4. One sentence before each tool call so the user sees what you are doing.
5. Emit one tool fence at a time. Continue autonomously after each result.
6. ${UNTRUSTED_CONTENT_RULE}`;

export const SYSTEM_PROMPT = `You are Codico, an autonomous coding assistant inside Visual Studio Code.

## Tools

Invoke tools using these exact fenced-code-block formats. One tool per response block; results come back as a follow-up.

\`\`\`read_file
filepath: <relative path>
\`\`\`
\`\`\`list_directory
dirpath: <relative path, or . for root>
\`\`\`
\`\`\`write_file
filepath: <relative path>
content:
<full file content>
\`\`\`
\`\`\`edit_file
filepath: <relative path>
old_str:
<exact string to replace — whitespace must match>
new_str:
<replacement>
\`\`\`
\`\`\`run_terminal
command: <shell command>
\`\`\`
\`\`\`search_files
pattern: <text or regex>
glob: <optional, e.g. **/*.ts>
regex: true|false
\`\`\`
\`\`\`find_files
pattern: <filename or glob>
dirpath: <optional subdirectory>
\`\`\`
\`\`\`get_diagnostics
filepath: <relative path, or omit for workspace>
\`\`\`
\`\`\`fetch_url
url: <full URL>
\`\`\`
\`\`\`browser_navigate
url: <full URL>
\`\`\`
\`\`\`browser_click
selector: <CSS selector or visible text>
\`\`\`
\`\`\`browser_type
selector: <CSS selector>
text: <text to type>
submit: true|false
\`\`\`
\`\`\`browser_get_text
selector: <CSS selector, or omit for full page>
\`\`\`
\`\`\`browser_screenshot
\`\`\`
\`\`\`browser_close
\`\`\`
\`\`\`lsp_symbol
query: <symbol name>
\`\`\`
\`\`\`debug_get_variables
frame_id: <optional frame index, 0 = top of stack>
\`\`\`
\`\`\`debug_get_callstack
\`\`\`
\`\`\`debug_list_breakpoints
\`\`\`
\`\`\`update_todo
- [ ] pending task
- [x] completed task
- [~] currently working on this
- [!] failed task
\`\`\`

## Rules
1. Explore narrowly before editing: start with search_files/find_files using names, errors, or identifiers from the task, then read only the most relevant files. Use read_file start_line/end_line around search matches for large files. Use list_directory only when the code location is genuinely unknown. Do not read package.json unless dependencies, scripts, or build configuration matter.
2. Prefer edit_file for partial changes; write_file only for whole-file rewrites.
3. write_file must contain the COMPLETE file — never truncate.
   Code blocks inside write_file/edit_file content are fine, but always give their opening fence a language (\`\`\`bash, \`\`\`text). Alternatively open the tool fence with four backticks (\`\`\`\`write_file) and close it with four.
4. edit_file old_str must match exactly once, including all whitespace.
5. One sentence before each tool call so the user sees what you are doing, followed by the tool fence in the same response — never end a response after announcing an action.
6. Emit one tool fence at a time. Continue autonomously after each result.
7. Run get_diagnostics after code changes to verify no new errors.
8. Use fetch_url for static docs/READMEs; use browser_navigate for SPAs and interactive pages.
9. Write clean, idiomatic, production-quality code.
10. Use debug_get_callstack, debug_get_variables, and debug_list_breakpoints only when there is an active VS Code debug session (they will fail gracefully otherwise).
11. Use update_todo only for genuinely multi-step tasks. Skip it for focused one-file fixes. When a plan is useful, keep it concise (normally 2–4 items), update it as work completes, and do not expand scope without evidence. Use [~] for active, [x] for done, [!] for failed.
12. run_terminal commands are killed after a timeout (5 minutes by default). Never run servers, watchers or other long-running processes in the foreground. To start one, detach it and redirect its output, e.g. \`nohup npm start > server.log 2>&1 &\`, then check it with \`sleep 2; curl ...\` or by reading the log.
13. ${UNTRUSTED_CONTENT_RULE}

## Clarification

When the task is ambiguous, ask before proceeding using this block (renders as interactive UI):

\`\`\`
<clarify>
question: <your question>
type: single|multi
options:
- Option A
- Option B
free_input: true
</clarify>
\`\`\`

Do not emit tool calls in the same response as a \`<clarify>\` block.`;


export const MUTATION_ONLY_SYSTEM_PROMPT = `You are Codico, an autonomous coding assistant inside Visual Studio Code.

## Current phase — mutation required

Repository discovery and focused source reading are complete. The request requires a code change, and you already have enough source evidence to act.

## Available tools

Use only these fenced formats when provider-native tools are unavailable:

\`\`\`edit_file
filepath: <relative path>
old_str:
<exact string to replace>
new_str:
<replacement>
\`\`\`

\`\`\`write_file
filepath: <relative path>
content:
<complete file content>
\`\`\`

\`\`\`run_terminal
command: <focused test/build/verification command>
\`\`\`

\`\`\`get_diagnostics
filepath: <relative path, or omit for workspace>
\`\`\`

## Rules

1. Only the four tools listed above are valid in this phase. Do not issue any other function call or fenced tool block. Repository/source discovery is complete.
2. Make the smallest evidence-backed code change now. Prefer edit_file; use write_file only for a necessary whole-file rewrite.
3. If edit_file misses, use the fresh source context returned by the failed edit to retry. Do not restart discovery.
4. run_terminal is for verification only in this phase: tests, builds, lint/type checks, or other focused validation. Do not use cat, grep, rg, sed, awk, head, tail, git show, or similar commands to inspect source.
5. After a successful mutation, verify the requested behavior and preservation constraints before finishing.
6. Do not finish an explicit coding request without a successful code mutation.`;

/**
 * Streams a chat completion from OpenRouter.
 * Yields thinking chunks (from delta.reasoning or <think> tags) and content chunks separately.
 */
export function streamOpenRouter(
    apiKey: string,
    history: ChatMessage[],
    model: string,
    customSystemPromptPrefix?: string,
    signal?: AbortSignal,
    thinkingEffort: 'high' | 'medium' | 'low' = 'medium',
    overrideSystemPrompt?: string,
    nativeTools: NativeToolDefinition[] = [],
    endpoint: OpenRouterEndpoint = { protocol: 'https:', hostname: 'openrouter.ai', path: '/api/v1/chat/completions' },
    requestOptimizer?: ProviderRequestOptimizer
): AsyncIterable<StreamChunk> {
    const basePrompt = overrideSystemPrompt ?? SYSTEM_PROMPT;

    function systemPrompt(useNativeTools: boolean): string {
        const toolPrompt = useNativeTools ? `${basePrompt}\n\n${NATIVE_TOOL_PROMPT}` : basePrompt;
        return customSystemPromptPrefix
            ? `${toolPrompt}\n\n${customSystemPromptPrefix}`
            : toolPrompt;
    }

    return {
        [Symbol.asyncIterator]() {
            // Queue-based async iterator: events pushed by the HTTP response
            // are drained by successive next() calls.
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

            // Handle abort signal
            if (signal) {
                if (signal.aborted) {
                    push(null);
                } else {
                    signal.addEventListener('abort', () => { push(null); }, { once: true });
                }
            }

            // ── <think> tag state machine ─────────────────────────────────
            const think = new ThinkTagSplitter((type, text) => push({ type, text }));

            // ── Build request ─────────────────────────────────────────────
            let useNativeTools = nativeTools.length > 0;
            let nativeFallbackUsed = false;

            function buildBody(): Record<string, unknown> {
                const messages = toOpenAIMessages([
                    { role: 'system', content: systemPrompt(useNativeTools) },
                    ...history,
                ], useNativeTools);
                return {
                    model,
                    messages,
                    stream: true,
                    max_tokens: 131072,
                    include_reasoning: true,
                    reasoning: { effort: thinkingEffort },
                    stream_options: { include_usage: true },
                    // OpenRouter usage accounting: adds the request's actual cost to the final usage report
                    usage: { include: true },
                    // Claude models cache only when asked: the breakpoint follows the conversation's last
                    // block. Other providers (OpenAI, DeepSeek, Gemini, Grok…) cache automatically.
                    ...(/^~?anthropic\//.test(model) ? { cache_control: { type: 'ephemeral' } } : {}),
                    ...(useNativeTools ? {
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
            }

            let attempt = 0;
            const MAX_RETRIES = 3;
            const BASE_DELAY_MS = 5000;

            async function doRequest(): Promise<void> {
                if (signal?.aborted) { push(null); return; }
                attempt++;
                let requestBody = buildBody();
                if (requestOptimizer) {
                    try {
                        requestBody = await requestOptimizer.optimize('openai', requestBody);
                    } catch {
                        // Provider optimization is strictly fail-open. An unavailable or
                        // buggy optional optimizer must never prevent the model request.
                    }
                }
                if (signal?.aborted) { push(null); return; }
                const body = JSON.stringify(requestBody);
                const transport = endpoint.protocol === 'http:' ? http : https;
                const req = transport.request(
                {
                    hostname: endpoint.hostname,
                    port: endpoint.port,
                    path: endpoint.path ?? '/api/v1/chat/completions',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                        'HTTP-Referer': 'vscode-codico',
                        'X-Title': 'Codico',
                        'Content-Length': Buffer.byteLength(body),
                    },
                    signal: signal as AbortSignal,
                } as http.RequestOptions,
                (res) => {
                    // Retry on 429 with exponential backoff
                    if (res.statusCode === 429 && attempt <= MAX_RETRIES) {
                        const retryAfterHeader = res.headers['retry-after'];
                        // retry-after can be a number of seconds OR an HTTP-date string.
                        // parseInt('Sat, 07 Jun ...') = NaN → fall back to exponential backoff.
                        const parsedSeconds = retryAfterHeader
                            ? parseInt(retryAfterHeader as string, 10)
                            : NaN;
                        const waitMs = Number.isFinite(parsedSeconds) && parsedSeconds > 0
                            ? Math.min(parsedSeconds * 1000, 60_000)
                            : Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), 60_000);
                        push({ type: 'thinking', text: `\n[Rate limited — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${MAX_RETRIES})…]\n` });
                        res.resume(); // drain so socket is freed
                        setTimeout(() => { if (!signal?.aborted) { void doRequest(); } else { push(null); } }, waitMs);
                        return;
                    }

                    // If this model/provider rejects structured tools, retry once
                    // with the compatibility fenced protocol instead of failing the turn.
                    if (res.statusCode && res.statusCode >= 400) {
                        let errBody = '';
                        res.setEncoding('utf8'); // keeps characters split across chunks intact
                        res.on('data', (d: string) => { errBody += d.toString(); });
                        res.on('end', () => {
                            const toolCapabilityError = /tool|function|unsupported|not supported/i.test(errBody);
                            if (useNativeTools && !nativeFallbackUsed && toolCapabilityError && !signal?.aborted) {
                                nativeFallbackUsed = true;
                                useNativeTools = false;
                                push({
                                    type: 'thinking',
                                    text: '\n[Native tools unavailable for this model — retrying with compatibility tool format…]\n',
                                });
                                void doRequest();
                                return;
                            }
                            push(new Error(
                                `OpenRouter HTTP ${res.statusCode}: ${errBody.slice(0, 300)}`
                            ));
                        });
                        return;
                    }

                    let buffer = '';
                    const completion = new StreamCompletionGuard();
                    const nativeCalls = new OpenAIToolCallAccumulator();

                    function emitReadyNativeTools(final = false): void {
                        for (const call of nativeCalls.flushReady()) {
                            push({ type: 'native_tool', call });
                        }
                        if (final && nativeCalls.hasPending) {
                            push({
                                type: 'stream_error',
                                message: `OpenRouter returned malformed native tool arguments for: ${nativeCalls.pendingNames().join(', ')}`,
                            });
                        }
                    }
                    // Dedup terminal pushes: [DONE] in data + end event both call pushEnd
                    let streamEnded = false;
                    function pushEnd(): void { if (!streamEnded) { streamEnded = true; think.flush(); push(null); } }

                    function processSSELine(trimmed: string): void {
                        if (!trimmed) { return; }
                        if (trimmed === 'data: [DONE]') {
                            completion.markTerminal();
                            emitReadyNativeTools(true);
                            pushEnd();
                            return;
                        }
                        if (!trimmed.startsWith('data: ')) { return; }
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
                                | {
                                    reasoning?: string;
                                    content?: string;
                                    tool_calls?: Array<{
                                        index?: number;
                                        id?: string;
                                        function?: { name?: string; arguments?: string };
                                    }>;
                                }
                                | undefined;
                            if (delta?.reasoning) { push({ type: 'thinking', text: delta.reasoning }); }
                            if (typeof delta?.content === 'string') { think.push(delta.content); }
                            for (const toolCall of delta?.tool_calls ?? []) {
                                nativeCalls.add(toolCall);
                            }
                            const finishReason: string | undefined = json.choices?.[0]?.finish_reason;
                            if (finishReason) {
                                completion.markTerminal();
                                emitReadyNativeTools(true);
                                if (finishReason !== 'stop' && finishReason !== 'tool_calls') {
                                    push({ type: 'finish', reason: finishReason });
                                }
                            }
                            const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: unknown; prompt_tokens_details?: { cached_tokens?: number } } | undefined;
                            if (usage?.total_tokens) {
                                push({
                                    type: 'usage',
                                    promptTokens: usage.prompt_tokens ?? 0,
                                    completionTokens: usage.completion_tokens ?? 0,
                                    totalTokens: usage.total_tokens,
                                    ...(typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? { costUsd: usage.cost } : {}),
                                    ...(usage.prompt_tokens_details?.cached_tokens ? { cachedTokens: usage.prompt_tokens_details.cached_tokens } : {}),
                                });
                            }
                        } catch { /* ignore malformed SSE frames */ }
                    }

                    function flushBuffer(): void {
                        if (!buffer) { return; }
                        const remaining = buffer;
                        buffer = '';
                        for (const line of remaining.split('\n')) { processSSELine(line.trim()); }
                    }

                    res.setEncoding('utf8'); // keeps characters split across chunks intact
                    res.on('data', (data: string) => {
                        buffer += data.toString();
                        const lines = buffer.split('\n');
                        buffer = lines.pop() ?? '';
                        for (const line of lines) { processSSELine(line.trim()); }
                    });

                    res.on('end', () => {
                        flushBuffer();
                        if (!signal?.aborted) {
                            const interrupted = completion.unexpectedEofMessage('OpenRouter');
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
                            push({ type: 'stream_error', message: `OpenRouter stream transport error: ${err.message}` });
                            pushEnd();
                        }
                    });
                }
            );

                req.on('error', (err: Error) => {
                    if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR' || signal?.aborted) {
                        push(null);
                    } else {
                        push({ type: 'stream_error', message: `OpenRouter stream transport error: ${err.message}` });
                        push(null);
                    }
                });
                watchStreamStall(req);
                req.write(body);
                req.end();
            }

            void doRequest();

            // ── Async iterator implementation ─────────────────────────────
            return {
                async next(): Promise<IteratorResult<StreamChunk>> {
                    // Wait until at least one item is queued
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
