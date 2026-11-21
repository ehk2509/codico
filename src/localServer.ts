import * as http from 'http';
import * as https from 'https';
import type { StreamChunk } from './openRouterClient';

/**
 * What a local model server (Ollama, llama.cpp, vLLM, LM Studio…) says about itself: which API it
 * speaks, which models it serves, and the context window it runs the selected model with.
 */
export interface LocalServerInfo {
    /** 'ollama': Ollama's own API answers. 'openai': only the OpenAI-compatible API. 'unreachable': neither. */
    kind: 'ollama' | 'openai' | 'unreachable';
    /** The models the server lists. */
    models: string[];
    /** The context window (tokens) the server runs the selected model with, when it says. */
    contextLength?: number;
}

const PROBE_TTL_MS = 60_000;
const probes = new Map<string, { at: number; info: Promise<LocalServerInfo> }>();

/** One GET (or POST) returning parsed JSON, or undefined on any failure: a probe never throws. */
function getJson(baseUrl: string, path: string, timeoutMs: number): Promise<unknown> {
    return new Promise(resolve => {
        let url: URL;
        try { url = new URL(baseUrl); } catch { resolve(undefined); return; }
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request({
            hostname: url.hostname,
            port: url.port ? Number(url.port) : undefined,
            path: `${url.pathname.replace(/\/$/, '')}${path}`,
            method: 'GET',
        }, res => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => { data += chunk; if (data.length > 1_000_000) { req.destroy(); resolve(undefined); } });
            res.on('end', () => {
                if (!res.statusCode || res.statusCode >= 400) { resolve(undefined); return; }
                try { resolve(JSON.parse(data)); } catch { resolve(undefined); }
            });
            res.on('error', () => resolve(undefined));
        });
        req.setTimeout(timeoutMs, () => { req.destroy(); resolve(undefined); });
        req.on('error', () => resolve(undefined));
        req.end();
    });
}

/** Ollama names default to the `latest` tag: "qwen3" and "qwen3:latest" are the same model. */
export function sameLocalModel(a: string, b: string): boolean {
    const norm = (name: string): string => (name.includes(':') ? name : `${name}:latest`).toLowerCase();
    return norm(a) === norm(b);
}

const positive = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

/** The context window an OpenAI-style model entry states, in whichever field its server uses. */
function contextOfEntry(entry: Record<string, unknown>): number | undefined {
    const meta = entry.meta as Record<string, unknown> | undefined;
    return positive(entry.context_length) ?? positive(entry.max_model_len) ?? positive(entry.max_context_length)
        ?? positive(entry.loaded_context_length) ?? positive(meta?.n_ctx);
}

async function probe(baseUrl: string, model: string, timeoutMs: number): Promise<LocalServerInfo> {
    const tags = await getJson(baseUrl, '/api/tags', timeoutMs) as { models?: Array<{ name?: string; model?: string }> } | undefined;
    if (tags && Array.isArray(tags.models)) {
        const models = tags.models.map(m => m.name ?? m.model ?? '').filter(Boolean);
        // The loaded model's context, when this Ollama reports it (it is only known once loaded)
        const ps = await getJson(baseUrl, '/api/ps', timeoutMs) as { models?: Array<{ name?: string; model?: string; context_length?: number }> } | undefined;
        const loaded = ps?.models?.find(m => sameLocalModel(m.name ?? m.model ?? '', model));
        return { kind: 'ollama', models, contextLength: positive(loaded?.context_length) };
    }
    const list = await getJson(baseUrl, '/v1/models', timeoutMs) as { data?: Array<Record<string, unknown>> } | undefined;
    if (list && Array.isArray(list.data)) {
        const models = list.data.map(entry => String(entry.id ?? '')).filter(Boolean);
        // A server with one model answers with it whatever the request names
        const entry = list.data.find(e => String(e.id ?? '') === model) ?? (list.data.length === 1 ? list.data[0] : undefined);
        return { kind: 'openai', models, contextLength: entry ? contextOfEntry(entry) : undefined };
    }
    return { kind: 'unreachable', models: [] };
}

/** What the server says about itself; asked at most once a minute per server and model. */
export function probeLocalServer(baseUrl: string, model: string, timeoutMs = 3000): Promise<LocalServerInfo> {
    const key = `${baseUrl}\n${model}`;
    const cached = probes.get(key);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) { return cached.info; }
    const info = probe(baseUrl, model, timeoutMs);
    probes.set(key, { at: Date.now(), info });
    return info;
}

/** Forgets what earlier probes found (tests; a server that was restarted with other settings). */
export function clearLocalServerProbes(): void { probes.clear(); }

/**
 * The prompt size at which to compact: the configured threshold, but never more than 60% of the
 * model's context window. The rest is left for the next reply (with its thinking) and the tool
 * results that come before the next check.
 */
export function compactThreshold(configured: number, contextLength?: number): number {
    if (!contextLength || contextLength <= 0) { return configured; }
    return Math.min(configured, Math.max(2048, Math.floor(contextLength * 0.6)));
}

/** Characters per token assumed when sizing text for a context window (code and prose average more). */
const CHARS_PER_TOKEN = 3;

/**
 * How much a compaction keeps and sends, for a model with this context window (unknown: the
 * defaults). The kept steps take at most a quarter of the window and the summarizer's transcript
 * 40%, so neither the summary request nor the compacted conversation overflows a small model.
 */
export function compactionBudgets(contextLength?: number): { maxTailChars?: number; transcriptChars: number; summaryTokens: number } {
    if (!contextLength || contextLength <= 0) { return { transcriptChars: 40_000, summaryTokens: 4000 }; }
    return {
        maxTailChars: Math.min(60_000, Math.floor(contextLength * CHARS_PER_TOKEN * 0.25)),
        transcriptChars: Math.min(40_000, Math.floor(contextLength * CHARS_PER_TOKEN * 0.4)),
        summaryTokens: Math.min(4000, Math.max(512, Math.floor(contextLength * 0.15))),
    };
}

const CONTEXT_OVERFLOW_RE = /exceeds? (?:the |its )?(?:available )?context|context (?:window|length|size) (?:is )?exceeded|context_length_exceeded|exceed_context_size|maximum context length|prompt is too long|too many tokens|input (?:is )?too long/i;

/** True when an error says the request did not fit the model's context window. */
export function isContextOverflow(message: string): boolean {
    return CONTEXT_OVERFLOW_RE.test(message);
}

/**
 * The stream, with a request refused for not fitting the context window turned into a
 * stream_error chunk instead of a thrown error, so the agent loop can compact and retry.
 * Any other error is thrown as before.
 */
export async function* overflowAsChunk(stream: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    try {
        for await (const chunk of stream) { yield chunk; }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isContextOverflow(message)) { throw err; }
        yield { type: 'stream_error', message };
    }
}

/**
 * A warning about a setup that does not do what the settings say, or undefined when it does:
 * a model the server does not have, or an Ollama-only setting sent to a server that is not Ollama.
 */
export function localServerWarning(info: LocalServerInfo, baseUrl: string, model: string, numCtx: number): string | undefined {
    if (info.kind === 'unreachable') { return undefined; } // the request itself reports it
    const listed = info.models.slice(0, 5).map(m => `"${m}"`).join(', ') + (info.models.length > 5 ? ', …' : '');
    if (info.kind === 'ollama' && info.models.length > 0 && !info.models.some(m => sameLocalModel(m, model))) {
        return `Ollama at ${baseUrl} has no model "${model}" (pull it with "ollama pull ${model}"). It has ${listed}.`;
    }
    if (info.kind === 'ollama' && numCtx <= 0 && info.contextLength && info.contextLength < 16_384) {
        return `Ollama runs "${model}" with a ${info.contextLength.toLocaleString('en-US')}-token context window, too small for agent work: ` +
            'Codico compacts the conversation early to fit it. Set codico.ollamaContextLength to 16384 or more (or OLLAMA_CONTEXT_LENGTH on the server).';
    }
    if (info.kind === 'openai') {
        const notes: string[] = [];
        if (info.models.length > 0 && !info.models.includes(model)) {
            notes.push(`it serves ${listed}, not "${model}": it either answers with ${info.models.length === 1 ? 'that model' : 'one of those'} or refuses the request`);
        }
        if (numCtx > 0) {
            notes.push(`codico.ollamaContextLength only works with Ollama, so it is ignored: the server sets its own context window${info.contextLength ? ` (${info.contextLength.toLocaleString('en-US')} tokens)` : ''}`);
        }
        if (notes.length > 0) { return `The server at ${baseUrl} is not Ollama (it has no /api/tags): ${notes.join('; ')}.`; }
    }
    return undefined;
}
