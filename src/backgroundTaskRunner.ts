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
}

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

    agent.backgroundPermissions = task.permissions;
    let current: string = 'running';
    let question = false;
    let failure: string | undefined;
    agent.backgroundListener = message => {
        // A reply that ends with a question to the user is not finished work, and an error is not either
        if (message.type === 'appendContent' && message.text.includes('<clarify>')) { question = true; }
        if (message.type === 'error') { failure = message.message; }
        const next = statusFromMessage(message);
        if (!next || next.status === current) { return; }
        current = next.status;
        void store.update(task.id, { status: next.status, note: next.note, heartbeat: Date.now() });
    };
    const beat = setInterval(() => { void store.update(task.id, { heartbeat: Date.now() }); }, HEARTBEAT_MS);
    try {
        await agent.sendMessage(`${taskPreface(task)}\n\n${task.prompt}`);
        const usage = agent.lastReplyUsage();
        const outcome = failure ? { status: 'failed' as const, note: failure.slice(0, 200) }
            : question ? { status: 'waiting' as const, note: 'answer its question' }
            : { status: 'finished' as const, note: undefined };
        return await store.update(task.id, { ...outcome, heartbeat: Date.now(), tokens: usage?.tokens, requests: usage?.requests?.length });
    } catch (error) {
        return await store.update(task.id, { status: 'failed', note: error instanceof Error ? error.message : String(error) });
    } finally {
        clearInterval(beat);
        agent.backgroundListener = undefined;
    }
}
