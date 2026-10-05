import type { ChatMessage } from './openRouterClient';

export interface HistoryProjection {
    history: ChatMessage[];
    omittedMessages: number;
    omittedChars: number;
}

export interface HistoryProjectionOptions {
    recentMessages?: number;
    largeResultChars?: number;
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
    const recentStart = Math.max(0, history.length - recentMessages);

    let omittedMessages = 0;
    let omittedChars = 0;

    const projected = history.map((message, index): ChatMessage => {
        if (index >= recentStart) { return message; }

        if (message.role === 'tool' && message.content.length > largeResultChars) {
            omittedMessages++;
            omittedChars += message.content.length;
            return {
                ...message,
                content: compactMarker(`prior ${message.toolName} result`, message.content.length),
            };
        }

        if (
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.startsWith('[Tool Results]') &&
            message.content.length > largeResultChars
        ) {
            omittedMessages++;
            omittedChars += message.content.length;
            return {
                ...message,
                content: compactMarker('prior compatibility tool results', message.content.length),
            };
        }

        return message;
    });

    return { history: projected, omittedMessages, omittedChars };
}
