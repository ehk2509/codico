import { ChatMessage } from './openRouterClient';
import { DisplayMessage, ThreadEntry } from './chatProtocol';

/** An independent copy of a thread: its index entry plus its own conversation. */
export interface ThreadDuplicate {
    entry: ThreadEntry;
    /** The model's view of the conversation, cloned so the two threads share nothing. */
    history: ChatMessage[];
    /** What the panel shows, cloned so the two threads share nothing. */
    display: DisplayMessage[];
}

/** The storage a duplication reads from and writes to (a VS Code Memento fits this). */
export interface ThreadStorage {
    get<T>(key: string, fallback: T): T;
    update(key: string, value: unknown): PromiseLike<void>;
}

/** Where the thread index, the active id and each thread's two payloads live. */
export interface ThreadKeys {
    index: string;
    activeId: string;
    history(threadId: string): string;
    display(threadId: string): string;
}

/** The thread currently loaded in memory, saved before it is replaced by the copy. */
export interface ActiveThread {
    id: string;
    history: ChatMessage[];
    display: DisplayMessage[];
}

/**
 * Builds an independent copy of a thread: the same conversation the panel shows and
 * the model sees, named "<name> (copy)". The copy is never pinned, even when the
 * original is, and its history and transcript are deep-cloned so later changes to
 * either thread cannot affect the other.
 */
export function duplicateThread(
    source: ThreadEntry,
    history: ChatMessage[],
    display: DisplayMessage[],
    id: string,
    now: number,
): ThreadDuplicate {
    return {
        entry: {
            id,
            name: `${source.name} (copy)`,
            createdAt: now,
            updatedAt: now,
            messageCount: source.messageCount,
            preview: source.preview,
            // Keep the "<name> (copy)" label: the copy must not auto-rename from its first message.
            hasBeenNamed: true,
        },
        history: clone(history),
        display: clone(display),
    };
}

/**
 * Copies a thread and stores it next to the original, making the copy the active
 * thread. `active` is saved first so copying the thread that is open captures its
 * latest conversation. Returns undefined when the source thread no longer exists.
 */
export async function duplicateStoredThread(
    storage: ThreadStorage,
    keys: ThreadKeys,
    sourceId: string,
    active: ActiveThread,
    id: string,
    now: number,
): Promise<ThreadDuplicate | undefined> {
    await storage.update(keys.history(active.id), active.history);
    await storage.update(keys.display(active.id), active.display);

    const threads = storage.get<ThreadEntry[]>(keys.index, []);
    const source = threads.find(t => t.id === sourceId);
    if (!source) { return undefined; }

    const copy = duplicateThread(
        source,
        storage.get<ChatMessage[]>(keys.history(sourceId), []),
        storage.get<DisplayMessage[]>(keys.display(sourceId), []),
        id,
        now,
    );
    threads.push(copy.entry);
    await storage.update(keys.index, threads);
    await storage.update(keys.history(copy.entry.id), copy.history);
    await storage.update(keys.display(copy.entry.id), copy.display);
    await storage.update(keys.activeId, copy.entry.id);
    return copy;
}

/** Deep-copies JSON-shaped data (Memento values), so the copies share no nested state. */
function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}
