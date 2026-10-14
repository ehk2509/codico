import * as vscode from 'vscode';
import { runTask } from './backgroundTaskRunner';
import { BackgroundTask, lostItsWindow } from './backgroundTasks';
import { BackgroundTaskStore } from './backgroundTaskStore';
import { ExtensionMessage, TeamWorkerAction, TeamWorkerView, WebviewMessage } from './chatProtocol';
import { workerId } from './teamTools';
import { WorkerAgent, WorkerDeps } from './workerAgent';

/** Steps and words kept per worker for the Agents view. */
export const WORKER_LOG_ENTRIES = 30;
const VIEW_THROTTLE_MS = 300;

interface Running {
    task: BackgroundTask;
    agent: WorkerAgent;
    end: AbortController;
    view: TeamWorkerView;
    /** The reply being written, and the tokens of its earlier replies. */
    text: string;
    tokensBefore: number;
    stopped: boolean;
}

/** Keeps the last `max` entries. */
const pushLog = (view: TeamWorkerView, entry: TeamWorkerView['log'][number]) => { view.log.push(entry); if (view.log.length > WORKER_LOG_ENTRIES) { view.log.splice(0, view.log.length - WORKER_LOG_ENTRIES); } };
const withoutToolBlocks = (text: string) => text.replace(/(`{3,})[a-z_]+\n[\s\S]*?(?:\1|$)/g, '').replace(/<\/?clarify>/g, '').trim();

/**
 * A team's workers running in this window, next to the orchestrator: each is a WorkerAgent in
 * its own worktree, driven like a background task (so waiting, messages and merging work the
 * same), and shown in the panel's Agents view with its steps, tokens and questions. Background tasks started with /background run here the same way.
 */
export class TeamWorkers implements vscode.Disposable {
    private readonly _running = new Map<string, Running>();
    private _timer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly _store: BackgroundTaskStore,
        private readonly _deps: Omit<WorkerDeps, 'post' | 'historyFile' | 'untrusted'> & { sandboxRequired?(): boolean; /** Headless: every question is answered no. */ declineQuestions?: boolean },
        /** To the panel: the Agents view, and the questions workers ask. */
        private readonly _post: (message: ExtensionMessage) => void,
        private readonly _openWindow: (task: BackgroundTask) => Promise<void>,
    ) {}

    /**
     * Starts an agent for a task: a team's worker, a background task or an automation's job.
     * @param first a message to go on from, in place of the task (a resumed job, its conversation reloaded)
     */
    launch(task: BackgroundTask, first?: string): void {
        const id = task.id;
        this._running.get(id)?.end.abort();
        const view: TeamWorkerView = { id: workerId(task), name: task.name, role: task.role ?? (task.team ? 'developer' : task.automation ? 'automation' : 'background task'), task: task.prompt, branch: task.branch, status: 'starting', steps: 0, tokens: 0, log: [] };
        const agent = new WorkerAgent(task, { ...this._deps, post: message => this._event(id, message), historyFile: this._store.historyFile(id),
            // An automation works from others' words: unattended commands only inside the sandbox
            untrusted: task.automation ? () => !this._deps.sandboxRequired?.() : undefined });
        const running: Running = { task, agent, end: new AbortController(), view, text: '', tokensBefore: 0, stopped: false };
        this._running.set(id, running);
        this._changed();
        void runTask(this._store, task, agent, running.end.signal, first).then(() => this._changed(), () => this._changed());
    }

    /**
     * Gives a task more to do with its conversation so far: told to its agent when it is here,
     * otherwise its agent is started again from its saved conversation.
     */
    async resume(task: BackgroundTask, text: string): Promise<void> {
        await this._store.update(task.id, { status: 'running', note: undefined, heartbeat: Date.now() });
        const running = this._running.get(task.id);
        if (running && !running.stopped) { await running.agent.teamMessage(text); this._changed(); return; }
        this.launch({ ...task, status: 'running' }, text);
    }

    /** What a worker said or did: kept for the Agents view, and its questions passed on to the panel. */
    private _event(id: string, message: ExtensionMessage): void {
        const running = this._running.get(id);
        if (!running) { return; }
        const { view } = running;
        switch (message.type) {
            case 'startMessage': running.text = ''; running.tokensBefore = view.tokens; view.status = 'running'; break;
            case 'appendContent': running.text = (running.text + message.text).slice(-6000); break;
            case 'toolStart': view.steps++; view.activity = `${message.tool} ${message.label}`.trim(); break;
            case 'toolResult': view.activity = undefined; pushLog(view, { tool: message.tool, label: message.label, ok: message.success, error: message.error }); break;
            case 'fileWriteResult': view.activity = undefined; pushLog(view, { tool: 'write_file', label: message.filepath, ok: message.granted, error: message.error }); break;
            // Processes its commands left running: shown on its row, ended with it
            case 'backgroundProcesses': view.processes = message.processes.length; break;
            case 'tokenUsage': if (!message.subagent || message.taskTokens !== undefined) { view.tokens = running.tokensBefore + (message.taskTokens ?? message.totalTokens); view.costUsd = message.taskCostUsd ?? view.costUsd; } break;
            case 'error': pushLog(view, { error: message.message }); break;
            case 'endMessage': {
                const said = withoutToolBlocks(running.text);
                if (said) { pushLog(view, { text: said.length > 600 ? '…' + said.slice(-600) : said }); }
                running.text = ''; view.activity = undefined;
                view.verdict = running.agent.passport?.verdict;
                break;
            }
            // Its questions are asked in the panel, in its place in the Agents view; with nobody at the screen, declined
            case 'writePermissionRequest': case 'terminalPermissionRequest': case 'checkpoint':
                if (this._deps.declineQuestions) {
                    if (message.type === 'checkpoint') { running.agent.approvals.answerCheckpoint(false); }
                    else if (message.type === 'writePermissionRequest') { running.agent.approvals.answerWrite(message.permId, { granted: false }); }
                    else { running.agent.approvals.answerCommand(message.permId, false); }
                    pushLog(view, { error: `declined (nobody to ask): ${message.type === 'terminalPermissionRequest' ? message.command : message.type === 'writePermissionRequest' ? message.filepath : 'continue past the token budget'}` });
                    break;
                }
                view.status = 'waiting';
                this._post({ ...message, worker: id });
                break;
        }
        this._changed();
    }

    /** The panel's answer to a worker's question; false when the question is not a worker's. */
    answerWrite(permId: string, granted: boolean, editedContent?: string): boolean {
        for (const running of this._running.values()) {
            if (running.agent.approvals.has(permId)) { running.agent.approvals.answerWrite(permId, { granted, editedContent }); this._resume(running); return true; }
        }
        return false;
    }

    answerCommand(permId: string, granted: boolean): boolean {
        for (const running of this._running.values()) {
            if (running.agent.approvals.has(permId)) { running.agent.approvals.answerCommand(permId, granted); this._resume(running); return true; }
        }
        return false;
    }

    /**
     * The panel's answers to the workers' questions, and the Agents view's buttons. True when the
     * message was for a worker; anything else is the orchestrator's.
     */
    async route(message: WebviewMessage): Promise<boolean> {
        switch (message.type) {
            case 'writePermissionResponse': return this.answerWrite(message.permId, message.granted);
            case 'writePermissionEdit': return this.answerWrite(message.permId, true, message.content);
            // "Allow all" is not offered on a worker's card; an old card's answer counts for that one question only
            case 'allowAllWrites': return this.answerWrite(message.permId, true);
            case 'allowAllTerminal': return this.answerCommand(message.permId, true);
            case 'terminalPermissionResponse': {
                if (!this._owner(message.permId)) { return false; }
                await this._deps.approvedCommands().answered(message.permId, message.granted ? message.remember : undefined);
                return this.answerCommand(message.permId, message.granted);
            }
            case 'teamWorker': await this.act(message.worker, message.action, message.text); return true;
            default: return false;
        }
    }

    private _owner(permId: string): Running | undefined { return [...this._running.values()].find(running => running.agent.approvals.has(permId)); }

    private _resume(running: Running): void { if (running.view.status === 'waiting') { running.view.status = 'running'; this._changed(); } }

    /** A button on a worker in the Agents view. */
    has(id: string): boolean { return this._running.has(id); }

    /** Whether any agent here is still working on its turn. */
    get busy(): boolean { return [...this._running.values()].some(running => running.agent.busy); }

    /** Brings the Agents view forward in the panel. */
    async show(): Promise<void> {
        await vscode.commands.executeCommand('workbench.view.extension.codico-container');
        this._post({ type: 'teamReveal' });
    }

    async act(worker: string, action: TeamWorkerAction, given?: string): Promise<void> {
        const entry = [...this._running.entries()].find(([, running]) => running.view.id === worker);
        if (!entry) { return; }
        const [id, running] = entry;
        if (action === 'continue' || action === 'halt') { running.agent.approvals.answerCheckpoint(action === 'continue'); this._resume(running); return; }
        // For a look at its files: the worker goes on here, and that window does not run it again
        if (action === 'open') { await this._openWindow(running.task); return; }
        if (action === 'stop') { await this.stop(id); return; }
        if (action === 'reply') {
            const name = running.task.name ?? running.task.prompt.replace(/\s+/g, ' ').slice(0, 50);
            const text = (given ?? await vscode.window.showInputBox({ title: `Message to ${name}`, prompt: running.agent.busy ? 'It is working: it reads this at its next step.' : 'An answer to its question, or what to do next.', ignoreFocusOut: true }))?.trim();
            if (!text) { return; }
            await running.agent.teamMessage(`[Message from the user]\n${text}`);
            if (!running.agent.busy) { await this._store.update(id, { status: 'running', note: undefined, heartbeat: Date.now() }); }
            this._changed();
            return;
        }
        if (action === 'dismiss' && !running.agent.busy) { this._end(running); this._running.delete(id); this._changed(); }
    }

    /** Stops a worker: its turn, its questions, and its reading of messages. Its work so far stays on its branch. */
    async stop(id: string): Promise<void> {
        const running = this._running.get(id);
        if (!running || running.stopped) { return; }
        running.stopped = true;
        running.agent.stop();
        for (let i = 0; i < 50 && running.agent.busy; i++) { await new Promise(resolve => setTimeout(resolve, 100)); }
        this._end(running);
        // After the runner's last write about the reply that was stopped
        await new Promise(resolve => setTimeout(resolve, 200));
        await this._store.update(id, { status: 'failed', note: 'stopped by the user', heartbeat: Date.now() });
        running.view.status = 'stopped';
        this._changed();
    }

    private _end(running: Running): void { running.end.abort(); running.agent.dispose(); }

    /** Shows the panel what changed, a few times a second at most. */
    private _changed(): void {
        if (this._timer) { return; }
        this._timer = setTimeout(() => { this._timer = undefined; void this.postState(); }, VIEW_THROTTLE_MS);
    }

    /** The Agents view now: the workers' own state, with what their task files say about them. */
    async postState(): Promise<void> {
        const now = Date.now();
        const workers: TeamWorkerView[] = [];
        for (const [id, running] of this._running) {
            const task = await this._store.get(id);
            const view = running.view;
            if (task && !running.stopped && view.status !== 'waiting') {
                view.status = lostItsWindow(task, now) ? 'stopped' : task.status;
                view.note = task.note;
            }
            view.merged = task?.merged;
            if (!task && !running.stopped) { view.status = 'stopped'; view.note = 'discarded'; }
            workers.push({ ...view, log: [...view.log] });
        }
        this._post({ type: 'teamState', workers });
    }

    dispose(): void {
        for (const running of this._running.values()) { this._end(running); }
        this._running.clear();
        if (this._timer) { clearTimeout(this._timer); }
    }
}
