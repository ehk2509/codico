import type { ChatMessage } from './openRouterClient';
import type { NativeToolCall } from './nativeTools';

export interface NativeToolExecution {
    call: NativeToolCall & { id: string };
    result: string;
}

export function appendAssistantIteration(
    history: ChatMessage[],
    content: string,
    nativeExecutions: NativeToolExecution[],
    fallbackContent: string
): void {
    history.push({
        role: 'assistant',
        content: content || (nativeExecutions.length > 0 ? '' : fallbackContent),
        ...(nativeExecutions.length > 0
            ? { nativeToolCalls: nativeExecutions.map(execution => execution.call) }
            : {}),
    });

    for (const execution of nativeExecutions) {
        history.push({
            role: 'tool',
            content: execution.result,
            toolCallId: execution.call.id,
            toolName: execution.call.name,
        });
    }
}

export function lastHistoryText(history: ChatMessage[]): string {
    const last = history[history.length - 1];
    if (!last) { return ''; }
    if (last.role === 'tool') { return last.content; }
    if (typeof last.content === 'string') { return last.content; }
    return last.content
        .filter(part => part.type === 'text')
        .map(part => part.type === 'text' ? part.text : '')
        .join('');
}
