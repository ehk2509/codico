import type { ChatMessage } from './openRouterClient';

export interface HistoryProjection {
    history: ChatMessage[];
    omittedMessages: number;
    omittedChars: number;
}

export interface HistoryProjectionOptions {
    recentMessages?: number;
    largeResultChars?: number;
    maxLargeResultChars?: number;
    preserveNewestLargeResults?: number;
    preserveNewestTargetResults?: number;
    maxWorkingSetChars?: number;
}

/** Shorter results cost less than the note that would replace them. */
const MIN_DEDUPLICATED_CHARS = 400;
const DUPLICATE_MARKER = '[Result omitted: identical to a later result in this conversation (the content was unchanged when it was read again).]';

function compactMarker(label: string, omittedChars: number): string {
    return `[${label} compacted: ${omittedChars.toLocaleString()} chars omitted from older context. Re-run the tool only if exact content is still needed.]`;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nativeCallTarget(name: string, args: Record<string, unknown>): string | null {
    switch (name) {
        case 'read_file': {
            const filepath = stringArg(args, 'filepath');
            if (!filepath) { return null; }
            const start = numberArg(args, 'start_line');
            const end = numberArg(args, 'end_line');
            const range = start || end ? `:${start ?? 1}-${end ?? '*'}` : '';
            return `read_file:${filepath}${range}`;
        }
        case 'list_directory': {
            const dirpath = stringArg(args, 'dirpath');
            return dirpath ? `list_directory:${dirpath}` : null;
        }
        case 'search_files': {
            const pattern = stringArg(args, 'pattern');
            if (!pattern) { return null; }
            return `search_files:${pattern}:${stringArg(args, 'glob') ?? ''}`;
        }
        case 'find_files': {
            const pattern = stringArg(args, 'pattern');
            if (!pattern) { return null; }
            return `find_files:${pattern}:${stringArg(args, 'dirpath') ?? ''}`;
        }
        case 'get_diagnostics':
            return `get_diagnostics:${stringArg(args, 'filepath') ?? 'workspace'}`;
        case 'lsp_symbol': {
            const query = stringArg(args, 'query');
            return query ? `lsp_symbol:${query}` : null;
        }
        default:
            return null;
    }
}

function callTargets(history: ChatMessage[]): Map<string, string> {
    const targets = new Map<string, string>();

    for (const message of history) {
        if (message.role !== 'assistant' || !message.nativeToolCalls) { continue; }
        for (const call of message.nativeToolCalls) {
            if (!call.id) { continue; }
            const target = nativeCallTarget(call.name, call.arguments ?? {});
            if (target) { targets.set(call.id, target); }
        }
    }

    return targets;
}

function compatibilityTarget(content: string): string | null {
    const firstLine = content.split('\n', 1)[0] ?? '';
    const read = /^\[read_file:\s*([^\]]+?)(?:\s+lines\s+(\d+)–(\d+)\s+of\s+\d+)?\]$/i.exec(firstLine);
    if (read) {
        const range = read[2] && read[3] ? `:${read[2]}-${read[3]}` : '';
        return `read_file:${read[1].trim()}${range}`;
    }

    const generic = /^\[([a-z_]+):\s*([^\]]+)\]/i.exec(firstLine);
    return generic ? `${generic[1]}:${generic[2].trim()}` : null;
}

function resultTarget(
    message: ChatMessage,
    targetsByCallId: Map<string, string>,
): string | null {
    if (message.role === 'tool') {
        return targetsByCallId.get(message.toolCallId) ?? `${message.toolName}:${message.toolCallId}`;
    }

    if (message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('[Tool Results]')) {
        return compatibilityTarget(message.content.slice('[Tool Results]'.length).trimStart());
    }

    return null;
}

/**
 * Builds a provider-facing copy of conversation history without mutating the
 * canonical session history.
 *
 * Compaction is working-set aware: the newest large result for several distinct
 * tool targets is retained even after it falls outside the last few messages.
 * This prevents an agent from forgetting a source file it just inspected and
 * then repeatedly re-reading it because a different large result became newer.
 */
export function projectHistoryForModel(
    history: ChatMessage[],
    options: HistoryProjectionOptions = {},
): HistoryProjection {
    const recentMessages = Math.max(2, options.recentMessages ?? 6);
    const largeResultChars = Math.max(1000, options.largeResultChars ?? 6000);
    const maxLargeResultChars = Math.max(largeResultChars, options.maxLargeResultChars ?? 40_000);
    const preserveNewestLargeResults = Math.max(0, options.preserveNewestLargeResults ?? 1);
    const preserveNewestTargetResults = Math.max(0, options.preserveNewestTargetResults ?? 6);
    const maxWorkingSetChars = Math.max(maxLargeResultChars, options.maxWorkingSetChars ?? 80_000);
    const recentStart = Math.max(0, history.length - recentMessages);
    const targetsByCallId = callTargets(history);

    let omittedMessages = 0;
    let omittedChars = 0;
    let retainedLargeChars = 0;
    let retainedWorkingSetChars = 0;
    let preservedLargeResults = 0;
    let preservedTargetResults = 0;
    const seenTargets = new Set<string>();
    // Results seen later in the conversation: an older identical copy is sent only once
    const laterResults = new Set<string>();
    const projected = [...history];

    for (let index = history.length - 1; index >= 0; index--) {
        const message = history[index];
        const isNativeTool = message.role === 'tool';
        const isCompatibilityTool =
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.startsWith('[Tool Results]');
        if (!isNativeTool && !isCompatibilityTool) { continue; }

        const content = message.content as string;
        // The same result again (e.g. a file re-read while unchanged): keep only the newest copy
        if (content.length >= MIN_DEDUPLICATED_CHARS) {
            if (laterResults.has(content)) {
                omittedMessages++;
                omittedChars += content.length;
                projected[index] = { ...message, content: DUPLICATE_MARKER };
                continue;
            }
            laterResults.add(content);
        }
        if (content.length <= largeResultChars) { continue; }

        const target = resultTarget(message, targetsByCallId);
        const newestForTarget = Boolean(target && !seenTargets.has(target));
        if (target) { seenTargets.add(target); }

        const preserveNewest = preservedLargeResults < preserveNewestLargeResults;
        const preserveTarget =
            newestForTarget &&
            preservedTargetResults < preserveNewestTargetResults &&
            retainedWorkingSetChars + content.length <= maxWorkingSetChars;
        const withinRecentBudget =
            index >= recentStart &&
            retainedLargeChars + content.length <= maxLargeResultChars;

        if (preserveNewest || preserveTarget || withinRecentBudget) {
            preservedLargeResults++;
            retainedLargeChars += content.length;
            if (preserveTarget) {
                preservedTargetResults++;
                retainedWorkingSetChars += content.length;
            }
            continue;
        }

        omittedMessages++;
        omittedChars += content.length;
        projected[index] = isNativeTool
            ? {
                ...message,
                content: compactMarker(`prior ${message.toolName} result`, content.length),
            }
            : {
                ...message,
                content: compactMarker('prior compatibility tool results', content.length),
            };
    }

    return { history: projected, omittedMessages, omittedChars };
}
