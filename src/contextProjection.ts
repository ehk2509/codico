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
    deduplicateExactResults?: boolean;
    minDuplicateChars?: number;
}

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
    const deduplicateExactResults = options.deduplicateExactResults ?? true;
    const minDuplicateChars = Math.max(1000, options.minDuplicateChars ?? 2000);
    const targetsByCallId = callTargets(history);

    let omittedMessages = 0;
    let omittedChars = 0;
    let retainedLargeChars = 0;
    let retainedWorkingSetChars = 0;
    let preservedLargeResults = 0;
    let preservedTargetResults = 0;
    const seenTargets = new Set<string>();
    // Only remove a result when an identical, target-matched copy remains verbatim.
    // This is lossless at the provider evidence level; canonical history is unchanged.
    const latestExactResults = new Map<string, string>();
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
        if (content.length <= largeResultChars && !deduplicateExactResults) { continue; }

        const target = resultTarget(message, targetsByCallId);
        if (deduplicateExactResults && target && content.length >= minDuplicateChars &&
            latestExactResults.get(target) === content) {
            omittedMessages++;
            omittedChars += content.length;
            projected[index] = {
                ...message,
                content: compactMarker(`repeated ${isNativeTool ? message.toolName : 'compatibility tool'} result (identical newer evidence retained)`, content.length),
            } as ChatMessage;
            continue;
        }
        if (content.length <= largeResultChars) {
            if (target && content.length >= minDuplicateChars && !latestExactResults.has(target)) {
                latestExactResults.set(target, content);
            }
            continue;
        }
        // Only a verbatim retained result can serve as an exact deduplication anchor.
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
            if (target && content.length >= minDuplicateChars) { latestExactResults.set(target, content); }
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
