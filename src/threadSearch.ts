import { DisplayMessage } from './chatProtocol';

export interface ThreadSearchResult {
    threadId: string;
    threadName: string;
    snippets: Array<{ role: string; snippet: string }>;
}

/** At most this many snippets are shown per thread. */
const MAX_SNIPPETS = 3;

/**
 * Searches every thread's transcript (and name) for the text, without regard to case.
 * A thread matches when its name or any message contains it.
 */
export function searchThreads(
    threads: Array<{ id: string; name: string }>,
    messagesOf: (threadId: string) => DisplayMessage[],
    query: string,
): ThreadSearchResult[] {
    const q = query.trim().toLowerCase();
    if (!q) { return []; }
    const results: ThreadSearchResult[] = [];
    for (const thread of threads) {
        const snippets: ThreadSearchResult['snippets'] = [];
        for (const msg of messagesOf(thread.id)) {
            const lower = msg.text.toLowerCase();
            let pos = lower.indexOf(q);
            while (pos !== -1 && snippets.length < MAX_SNIPPETS) {
                const start = Math.max(0, pos - 60);
                const end = Math.min(msg.text.length, pos + q.length + 80);
                snippets.push({ role: msg.role, snippet: (start > 0 ? '…' : '') + msg.text.slice(start, end) + (end < msg.text.length ? '…' : '') });
                pos = lower.indexOf(q, pos + 1);
            }
            if (snippets.length >= MAX_SNIPPETS) { break; }
        }
        if (snippets.length > 0 || thread.name.toLowerCase().includes(q)) {
            results.push({ threadId: thread.id, threadName: thread.name, snippets });
        }
    }
    return results;
}
