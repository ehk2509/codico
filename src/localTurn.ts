import * as vscode from 'vscode';
import { ChatMessage, StreamChunk } from './openRouterClient';
import { NativeToolDefinition } from './nativeTools';
import { streamOllama } from './ollamaClient';
import { streamLocalOpenAICompat } from './directProviderClient';
import { localServerWarning, probeLocalServer } from './localServer';

/** How a turn talks to a local model server, settled once before its first request. */
export interface LocalTurn {
    /** Tools are offered natively (codico.ollamaNativeTools), not as text formats. */
    nativeTools: boolean;
    stream(history: ChatMessage[], prefix: string | undefined, override: string | undefined, tools: NativeToolDefinition[], effort: 'high' | 'medium' | 'low', signal: AbortSignal): AsyncIterable<StreamChunk>;
}

/** Warnings already shown in this session: each once. */
const shown = new Set<string>();

/**
 * Asks the local server what it is, which models it has and the context window it runs the
 * model with; sizes compaction to that window, warns once about a setup that does not do what
 * the settings say, and returns how this turn sends its requests. Not a local model: undefined.
 */
export async function prepareLocalTurn(
    isLocal: boolean,
    config: vscode.WorkspaceConfiguration,
    baseUrl: string,
    model: string,
    compaction: { contextLength: number | undefined }
): Promise<LocalTurn | undefined> {
    if (!isLocal) { compaction.contextLength = undefined; return undefined; }
    const configuredCtx = Math.max(0, Math.floor(config.get<number>('ollamaContextLength', 0) ?? 0));
    const info = await probeLocalServer(baseUrl, model);
    // Only Ollama's native endpoint takes a context size: any other server keeps its own
    const numCtx = info.kind === 'openai' ? 0 : configuredCtx;
    compaction.contextLength = numCtx > 0 ? numCtx : info.contextLength;
    const warning = localServerWarning(info, baseUrl, model, configuredCtx);
    if (warning && !shown.has(warning)) { shown.add(warning); void vscode.window.showWarningMessage(`Codico: ${warning}`); }
    // Native tools go through the OpenAI-compatible endpoint, which takes no context size
    const nativeTools = config.get<boolean>('ollamaNativeTools', false) === true && numCtx === 0;
    return {
        nativeTools,
        stream: (history, prefix, override, tools, effort, signal) => tools.length > 0
            ? streamLocalOpenAICompat(baseUrl, history, model, prefix, signal, effort, override, tools)
            : streamOllama(baseUrl, history, model, prefix, signal, override, { numCtx, effort }),
    };
}
