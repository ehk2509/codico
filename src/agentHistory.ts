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

/**
 * Reduce replay cost without imposing a task/token/iteration limit.
 *
 * Old tool payloads are the largest source of quadratic prompt growth in an
 * agent loop. Keep recent tool results byte-for-byte and turn older payloads
 * into small receipts. Assistant/user decisions remain untouched, so the
 * model retains the task, plan and mutations while avoiding repeated transfer
 * of stale file/terminal/search bodies.
 *
 * Tool-call/result pairs must stay provider-valid, therefore we keep the tool
 * message and only replace its content. Error results are retained longer
 * because they often contain the evidence needed to recover.
 */
export function compactSupersededToolResults(
    history: ChatMessage[],
    keepRecentToolResults = 6,
    keepRecentErrors = 3,
    minChars = 1200
): number {
    let toolsSeen = 0;
    let errorsSeen = 0;
    let savedChars = 0;

    for (let i = history.length - 1; i >= 0; i--) {
        const message = history[i];
        if (message.role !== 'tool') { continue; }

        toolsSeen++;
        const content = message.content;
        const looksLikeError = /\b(error|failed|exception|traceback|fatal|cannot|unable)\b/i.test(content);
        if (looksLikeError) { errorsSeen++; }

        if (toolsSeen <= keepRecentToolResults || (looksLikeError && errorsSeen <= keepRecentErrors)) {
            continue;
        }
        if (content.length < minChars || content.startsWith('[Earlier tool result compacted;')) {
            continue;
        }

        const toolName = message.toolName ?? 'tool';
        const receipt = `[Earlier tool result compacted; ${toolName} completed and its full ${content.length}-character output was already available to the agent. Re-run only if current workspace state requires fresh evidence.]`;
        savedChars += content.length - receipt.length;
        message.content = receipt;
    }

    return savedChars;
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
