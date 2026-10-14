import * as vscode from 'vscode';
import { ChatMessage } from './openRouterClient';
import { EditProposalManager } from './editProposalManager';
import { DisplayMessage, ExtensionMessage, ThreadEntry } from './chatProtocol';
import { TaskUsage } from './taskUsage';
import { duplicateStoredThread } from './threadDuplication';

/** Where threads are kept in the editor's storage. */
export const THREADS_INDEX_KEY = 'codico.threads';
export const ACTIVE_THREAD_KEY = 'codico.activeThreadId';
export const threadKey = (id: string) => `codico.thread.${id}`;
export const threadDisplayKey = (id: string) => `codico.threadDisplay.${id}`;

/** The open conversation and what thread operations need besides it. */
export interface ThreadHost {
    /** Workspace or global storage, as the codico.globalHistory setting says. */
    readonly store: vscode.Memento;
    activeThreadId: string;
    history: ChatMessage[];
    displayMessages: DisplayMessage[];
    editsMode: boolean;
    readonly editProposals: EditProposalManager;
    post(message: ExtensionMessage): void;
    newId(): string;
}

/** The thread list: creating, opening, renaming, deleting and duplicating threads, and their saved metadata. */
export class ThreadManager {
    constructor(private readonly _host: ThreadHost) {}

    initSync(): void {
        const store = this._host.store;
        let threads = store.get<ThreadEntry[]>(THREADS_INDEX_KEY, []);

        if (threads.length === 0) {
            // First launch: migrate old history or create fresh thread
            const oldWs = store.get<ChatMessage[]>('codico.history', []);
            const oldGlobal = store.get<ChatMessage[]>('codico.history.global', []);
            const oldHistory = oldWs.length > 0 ? oldWs : oldGlobal;
            const thread: ThreadEntry = {
                id: this._host.newId(),
                name: oldHistory.length > 0 ? 'Previous Chat' : 'New Chat',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                messageCount: oldHistory.length,
                preview: '',
            };
            threads = [thread];
            void store.update(THREADS_INDEX_KEY, threads);
            void store.update(ACTIVE_THREAD_KEY, thread.id);
            void store.update(threadKey(thread.id), oldHistory);
            void store.update(threadDisplayKey(thread.id), []);
            // Remove old flat-history keys
            if (oldWs.length > 0) { void store.update('codico.history', undefined); }
            if (oldGlobal.length > 0) { void store.update('codico.history.global', undefined); }
            this._host.activeThreadId = thread.id;
            this._host.history = oldHistory;
            this._host.displayMessages = [];
        } else {
            const activeId = store.get<string>(ACTIVE_THREAD_KEY, threads[0].id);
            this._host.activeThreadId = threads.some(t => t.id === activeId) ? activeId : threads[0].id;
            this._host.history = store.get<ChatMessage[]>(threadKey(this._host.activeThreadId), []);
            this._host.displayMessages = store.get<DisplayMessage[]>(threadDisplayKey(this._host.activeThreadId), []);
        }
    }
    list(): Array<ThreadEntry & { active: boolean }> {
        // Pinned first, then the most recently used
        return this._host.store.get<ThreadEntry[]>(THREADS_INDEX_KEY, [])
            .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)
            .map(t => ({ ...t, active: t.id === this._host.activeThreadId }));
    }
    /** @param usage a finished task's tokens and cost, added to the thread's totals */
    async updateMeta(userText: string, usage?: TaskUsage): Promise<void> {
        const store = this._host.store;
        const threads = store.get<ThreadEntry[]>(THREADS_INDEX_KEY, []);
        const idx = threads.findIndex(t => t.id === this._host.activeThreadId);
        if (idx === -1) { return; }
        const userDisplayCount = this._host.displayMessages.filter(m => m.role === 'user').length;
        // Auto-name from first user message if this thread has never been explicitly named
        let name = threads[idx].name;
        let hasBeenNamed = threads[idx].hasBeenNamed ?? false;
        const isDefaultName = !hasBeenNamed && (
            name === 'New Chat' || name === 'New Session' || name === 'Previous Chat' || /^Thread \d+$/.test(name)
        );
        if (isDefaultName && userText.trim().length > 0) {
            const cleaned = userText.replace(/\n/g, ' ').trim();
            name = cleaned.length > 60 ? cleaned.slice(0, 60) + '\u2026' : cleaned;
            hasBeenNamed = true;
        }
        threads[idx] = {
            ...threads[idx],
            name,
            hasBeenNamed,
            updatedAt: Date.now(),
            messageCount: userDisplayCount,
            preview: userText.slice(0, 80).replace(/\n/g, ' '),
            tokens: (threads[idx].tokens ?? 0) + (usage?.tokens ?? 0),
            costUsd: usage?.costUsd !== undefined ? (threads[idx].costUsd ?? 0) + usage.costUsd : threads[idx].costUsd,
        };
        await store.update(THREADS_INDEX_KEY, threads);
    }
    async create(name?: string): Promise<void> {
        // Save current thread first
        await this._host.store.update(threadKey(this._host.activeThreadId), this._host.history);
        await this._host.store.update(threadDisplayKey(this._host.activeThreadId), this._host.displayMessages);

        const threads = this._host.store.get<ThreadEntry[]>(THREADS_INDEX_KEY, []);
        const threadName = name?.trim() || `Thread ${threads.length + 1}`;
        const thread: ThreadEntry = {
            id: this._host.newId(),
            name: threadName,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageCount: 0,
            preview: '',
        };
        threads.push(thread);
        await this._host.store.update(THREADS_INDEX_KEY, threads);
        await this._host.store.update(ACTIVE_THREAD_KEY, thread.id);
        await this._host.store.update(threadKey(thread.id), []);
        await this._host.store.update(threadDisplayKey(thread.id), []);

        this._host.activeThreadId = thread.id;
        this._host.history = [];
        this._host.displayMessages = [];
        this._host.post({ type: 'threadLoaded', id: thread.id, name: thread.name, displayMessages: [] });
        this._host.post({ type: 'threadList', threads: this.list() });
    }
    async switchTo(id: string): Promise<void> {
        if (id === this._host.activeThreadId) { return; }
        const threads = this._host.store.get<ThreadEntry[]>(THREADS_INDEX_KEY, []);
        const target = threads.find(t => t.id === id);
        if (!target) { return; }
        // Discard any pending proposals from the outgoing thread
        if (this._host.editsMode) {
            this._host.editsMode = false;
            this._host.editProposals.rejectAll();
            this._host.post({ type: 'allProposalsResolved' });
        }
        // Save current
        await this._host.store.update(threadKey(this._host.activeThreadId), this._host.history);
        await this._host.store.update(threadDisplayKey(this._host.activeThreadId), this._host.displayMessages);
        // Load target
        this._host.activeThreadId = id;
        this._host.history = this._host.store.get<ChatMessage[]>(threadKey(id), []);
        this._host.displayMessages = this._host.store.get<DisplayMessage[]>(threadDisplayKey(id), []);
        await this._host.store.update(ACTIVE_THREAD_KEY, id);
        this._host.post({ type: 'threadLoaded', id, name: target.name, displayMessages: this._host.displayMessages });
        this._host.post({ type: 'threadList', threads: this.list() });
    }
    async rename(id: string, name: string): Promise<void> {
        const store = this._host.store;
        const threads = store.get<ThreadEntry[]>(THREADS_INDEX_KEY, []);
        const idx = threads.findIndex(t => t.id === id);
        if (idx === -1) { return; }
        threads[idx] = { ...threads[idx], name, hasBeenNamed: true };
        await store.update(THREADS_INDEX_KEY, threads);
        this._host.post({ type: 'threadList', threads: this.list() });
    }
    async remove(id: string): Promise<void> {
        const store = this._host.store;
        let threads = store.get<ThreadEntry[]>(THREADS_INDEX_KEY, []);
        if (threads.length <= 1) {
            // Clear instead of delete — can't remove last thread; reset to a fresh session
            this._host.history = [];
            this._host.displayMessages = [];
            threads[0] = { ...threads[0], name: 'New Session', hasBeenNamed: false, messageCount: 0, preview: '', updatedAt: Date.now() };
            await store.update(THREADS_INDEX_KEY, threads);
            await store.update(threadKey(id), []);
            await store.update(threadDisplayKey(id), []);
            this._host.post({ type: 'threadLoaded', id, name: 'New Session', displayMessages: [] });
            this._host.post({ type: 'threadList', threads: this.list() });
            return;
        }
        threads = threads.filter(t => t.id !== id);
        await store.update(THREADS_INDEX_KEY, threads);
        await store.update(threadKey(id), undefined);
        await store.update(threadDisplayKey(id), undefined);
        // If deleted thread was active, switch to most recent remaining thread
        if (id === this._host.activeThreadId) {
            const next = threads.sort((a, b) => b.updatedAt - a.updatedAt)[0];
            this._host.activeThreadId = next.id;
            this._host.history = store.get<ChatMessage[]>(threadKey(next.id), []);
            this._host.displayMessages = store.get<DisplayMessage[]>(threadDisplayKey(next.id), []);
            await store.update(ACTIVE_THREAD_KEY, next.id);
            this._host.post({ type: 'threadLoaded', id: next.id, name: next.name, displayMessages: this._host.displayMessages });
        }
        this._host.post({ type: 'threadList', threads: this.list() });
    }
    /** Copies a thread into a new, unpinned, active thread; nothing happens when it is gone. */
    async duplicate(id: string): Promise<void> {
        if (this._host.editsMode) { this._host.editsMode = false; this._host.editProposals.rejectAll(); this._host.post({ type: 'allProposalsResolved' }); }
        const copy = await duplicateStoredThread(this._host.store, {
            index: THREADS_INDEX_KEY, activeId: ACTIVE_THREAD_KEY,
            history: threadId => threadKey(threadId), display: threadId => threadDisplayKey(threadId),
        }, id, { id: this._host.activeThreadId, history: this._host.history, display: this._host.displayMessages }, this._host.newId(), Date.now());
        if (!copy) { return; }
        this._host.activeThreadId = copy.entry.id; this._host.history = copy.history; this._host.displayMessages = copy.display;
        this._host.post({ type: 'threadLoaded', id: copy.entry.id, name: copy.entry.name, displayMessages: copy.display });
        this._host.post({ type: 'threadList', threads: this.list() });
    }
    async contextMenu(id: string): Promise<void> {
        const threads = this._host.store.get<ThreadEntry[]>(THREADS_INDEX_KEY, []);
        const thread = threads.find(t => t.id === id);
        if (!thread) { return; }
        // Show inline context menu in the webview (no VS Code modal)
        this._host.post({ type: 'threadContextMenuRequest', id, name: thread.name });
    }
}
