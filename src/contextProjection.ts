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
}

function compactMarker(label: string, omittedChars: number): string {
    return `[${label} compacted: ${omittedChars.toLocaleString()} chars omitted from older context. Re-run the tool if exact content is needed.]`;
}

/**
 * Builds a provider-facing copy of conversation history without mutating the
 * canonical session history. Large, old tool results are recoverable evidence:
 * replaying them on every agent iteration wastes context and makes stale reads
 * increasingly expensive, so only the recent working set stays verbatim.
 */
export function projectHistoryForModel(
    history: ChatMessage[],
    options: HistoryProjectionOptions = {},
): HistoryProjection {
    const recentMessages = Math.max(2, options.recentMessages ?? 6);
    const largeResultChars = Math.max(1000, options.largeResultChars ?? 6000);
    const maxLargeResultChars = Math.max(largeResultChars, options.maxLargeResultChars ?? 40_000);
    const preserveNewestLargeResults = Math.max(0, options.preserveNewestLargeResults ?? 1);
    const recentStart = Math.max(0, history.length - recentMessages);

    let omittedMessages = 0;
    let omittedChars = 0;
    let retainedLargeChars = 0;
    let preservedLargeResults = 0;
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
        if (content.length <= largeResultChars) { continue; }

        const preserveNewest = preservedLargeResults < preserveNewestLargeResults;
        const withinRecentBudget =
            index >= recentStart &&
            retainedLargeChars + content.length <= maxLargeResultChars;

        if (preserveNewest || withinRecentBudget) {
            preservedLargeResults++;
            retainedLargeChars += content.length;
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
