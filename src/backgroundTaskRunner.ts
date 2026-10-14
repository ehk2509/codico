import * as fs from 'fs';
import * as vscode from 'vscode';
import { ExtensionMessage } from './chatProtocol';
import { BackgroundTask, HEARTBEAT_MS, taskPreface } from './backgroundTasks';
import { BackgroundTaskStore } from './backgroundTaskStore';

/** What the runner needs from the agent of this window. */
export interface BackgroundAgent {
    readonly ready: boolean;
    backgroundPermissions: BackgroundTask['permissions'];
    backgroundListener?: (message: ExtensionMessage) => void;
    sendMessage(text: string): Promise<void>;
    lastReplyUsage(): { tokens?: number; requests?: unknown[] } | undefined;
    /** The agent's last reply, for the team's orchestrator. */
    lastReplyText?(): string;
    /** A message from the orchestrator: taken in at the next step when the agent is working, otherwise answered as a new message. */
    teamMessage?(text: string): Promise<'steered' | 'answered'>;
}

/** How much of a worker's reply the orchestrator is given. */
export const MAX_REPORT_CHARS = 6000;
export const INBOX_POLL_MS = 2000;
const report = (agent: BackgroundAgent) => { const text = agent.lastReplyText?.() ?? ''; return text.length > MAX_REPORT_CHARS ? text.slice(-MAX_REPORT_CHARS) : text; };

/** One spelling per folder: links and short names resolved, and no difference of case where the system has none. */
const realPath = (folder: string) => {
    let real = folder;
    try { real = fs.realpathSync.native(folder); } catch { /* not there (yet): compare as written */ }
    return process.platform === 'win32' ? real.toLowerCase() : real;
};

/** The task this window was opened for, if its folder is a task's worktree. */
export async function taskOfThisWindow(store: BackgroundTaskStore, folder: string | undefined): Promise<BackgroundTask | undefined> {
    if (!folder) { return undefined; }
    const here = realPath(folder);
    return (await store.all()).find(task => realPath(task.worktree) === here);
}

/** What the agent's messages say about the task's state. */
export function statusFromMessage(message: ExtensionMessage): { status: 'waiting' | 'running'; note?: string } | undefined {
    switch (message.type) {
        case 'writePermissionRequest': return { status: 'waiting', note: 'approve a file change' };
        case 'terminalPermissionRequest': return { status: 'waiting', note: 'approve a command' };
        case 'checkpoint': return { status: 'waiting', note: 'confirm that it should keep going' };
        case 'toolResult': case 'fileWriteResult': case 'toolStart': return { status: 'running' };
        default: return undefined;
    }
}

/**
 * In the task's own window: starts the task once the panel is there, and keeps its file up
 * to date (running, waiting for the user, finished) so the window that started it can tell.
 */
export async function runTaskOfThisWindow(store: BackgroundTaskStore, agent: BackgroundAgent, wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Promise<BackgroundTask | undefined> {
    const task = await taskOfThisWindow(store, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    // Only a task that has not been started: reopening the window of an old task must not run it again
    if (!task || task.status !== 'starting') { return task; }
    await store.update(task.id, { status: 'running', heartbeat: Date.now(), note: undefined });
    await vscode.commands.executeCommand('workbench.view.extension.codico-container');
    for (let tries = 0; tries < 100 && !agent.ready; tries++) { await wait(150); }
    if (!agent.ready) { return store.update(task.id, { status: 'failed', note: 'the Codico panel did not open in the task\'s window' }); }
    return runTask(store, task, agent);
}

/**
 * Runs a task with an agent and keeps its file up to date: in the task's own window, or for a
 * team's worker in the window of the team. A team's worker goes on reading the orchestrator's
 * messages after its first reply, until `end` is aborted (or for as long as its window is open).
 */
export async function runTask(store: BackgroundTaskStore, task: BackgroundTask, agent: BackgroundAgent, end?: AbortSignal, first?: string): Promise<BackgroundTask | undefined> {
    if (task.status === 'starting') { await store.update(task.id, { status: 'running', heartbeat: Date.now(), note: undefined }); }
    agent.backgroundPermissions = task.permissions;
    let current: string = 'running';
    // One write at a time, in the order things happened: a later status must not be overtaken by an earlier one
    let writes: Promise<unknown> = Promise.resolve();
    const put = (change: Partial<BackgroundTask>) => { writes = writes.then(() => store.update(task.id, change), () => undefined); return writes; };
    let question = false;
    let failure: string | undefined;
    let firstDone = false;
    agent.backgroundListener = message => {
        // After the first reply, a team worker's later replies (answers to the orchestrator) update its report too
        // A reply that ends with a question to the user is not finished work, and an error is not either
        if (message.type === 'appendContent' && message.text.includes('<clarify>')) { question = true; }
        if (firstDone && message.type === 'endMessage') {
            const after = question ? { status: 'waiting' as const, note: 'answer its question' } : { status: 'finished' as const, note: undefined };
            current = after.status; question = false;
            void put({ ...after, heartbeat: Date.now(), report: report(agent) });
            return;
        }
        if (message.type === 'error') { failure = message.message; }
        const next = statusFromMessage(message);
        if (!next || next.status === current) { return; }
        current = next.status;
        void put({ status: next.status, note: next.note, heartbeat: Date.now() });
    };
    const beat = setInterval(() => { void put({ heartbeat: Date.now() }); }, HEARTBEAT_MS);
    // A team worker reads its inbox for as long as its window is open: messages from the orchestrator
    let reading = false;
    const inbox = task.team ? setInterval(() => {
        if (reading) { return; }
        reading = true;
        void (async () => {
            try {
                const now = await store.get(task.id);
                const unread = (now?.inbox ?? []).slice(now?.inboxRead ?? 0);
                if (!now || unread.length === 0 || !agent.teamMessage) { return; }
                await put({ inboxRead: (now.inboxRead ?? 0) + unread.length });
                // Its status and report follow from the replies (see the listener): nothing to wait for here
                for (const message of unread) { await agent.teamMessage(`[Message from the orchestrator]\n${message.text}`); }
            } finally { reading = false; }
        })();
    }, INBOX_POLL_MS) : undefined;
    const close = () => { clearInterval(beat); if (inbox) { clearInterval(inbox); } agent.backgroundListener = undefined; };
    end?.addEventListener('abort', close, { once: true });
    try {
        // A resumed task (its conversation reloaded) goes on from a new message, not from its task again
        await agent.sendMessage(first ?? `${taskPreface(task)}\n\n${task.prompt}`);
        const usage = agent.lastReplyUsage();
        const outcome = failure ? { status: 'failed' as const, note: failure.slice(0, 200) }
            : question ? { status: 'waiting' as const, note: 'answer its question' }
            : { status: 'finished' as const, note: undefined };
        await put({ ...outcome, heartbeat: Date.now(), tokens: usage?.tokens, requests: usage?.requests?.length, report: report(agent) });
        current = outcome.status;
        firstDone = true;
        return await store.get(task.id);
    } catch (error) {
        await put({ status: 'failed', note: error instanceof Error ? error.message : String(error) });
        return await store.get(task.id);
    } finally {
        // A team worker keeps beating, listening and reading its inbox after the task: the orchestrator may send
        // follow-ups. All of it ends with its window
        // A task run in the window that started it (a team's worker, or a background task there) also keeps listening: it can be answered later
        if ((!task.team && !end) || end?.aborted) { close(); }
    }
}
