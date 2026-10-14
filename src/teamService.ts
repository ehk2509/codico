import { commitTaskWork, mergeTask, taskChanges, uncommittedCount } from './backgroundGit';
import { BackgroundPermissions, BackgroundTask, isActive, lostItsWindow, statusLabel, waitingForItsWindow, WorkerRole } from './backgroundTasks';
import { BackgroundTaskStore } from './backgroundTaskStore';
import { cleanWorkerName, DEFAULT_WAIT_SECONDS, findWorker, MAX_PATCH_CHARS, MAX_WAIT_SECONDS, TeamTool, workerLabel, workerSummary } from './teamTools';

/** What the team needs from the editor: where tasks are kept, how they are made and opened, and the settings. */
export interface TeamHost {
    readonly store: BackgroundTaskStore;
    createTask(options: { prompt: string; permissions: BackgroundPermissions; role?: WorkerRole; name?: string; team?: string; from?: string; basedOn?: string }): Promise<BackgroundTask | { error: string }>;
    /** Starts the worker's agent: in this window, or in a window of its own. */
    launch(task: BackgroundTask): Promise<void>;
    settings(): { maxWorkers: number; permissions: BackgroundPermissions };
    /** Where workers run, said to the orchestrator: "in this window" or "in its own window". */
    where?(): string;
    sleep?(ms: number): Promise<void>;
    now?(): number;
}

/** What one call needs from the turn that makes it. */
export interface TeamCall {
    /** The team: the orchestrating conversation. */
    team: string;
    /** The repository the orchestrator works in: a worker is merged here. */
    repoRoot: string | undefined;
    signal: AbortSignal;
    /** Asks the user before a worker's branch is merged into the workspace. */
    approveMerge(task: BackgroundTask, stat: string): Promise<boolean>;
    /** Runs a read-only reviewer on a task and returns its report. */
    review(task: string): Promise<string>;
}

export const WAIT_POLL_MS = 3_000;

/** Not running any more, for now: finished, failed, gone, or waiting for the user or an answer. */
export function settled(task: BackgroundTask, now: number): boolean {
    return !isActive(task, now) || task.status === 'waiting' || waitingForItsWindow(task, now);
}

const firstLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 72);

/** Runs the orchestrator's `team` calls. Each result is text for the model; nothing here throws for a bad call. */
export class TeamService {
    constructor(private readonly _host: TeamHost) {}

    private _now(): number { return this._host.now?.() ?? Date.now(); }
    private _sleep(ms: number): Promise<void> { return this._host.sleep?.(ms) ?? new Promise(resolve => setTimeout(resolve, ms)); }

    async workers(team: string): Promise<BackgroundTask[]> {
        return (await this._host.store.all()).filter(task => task.team === team).sort((a, b) => a.createdAt - b.createdAt);
    }

    async run(tool: TeamTool, call: TeamCall): Promise<string> {
        const tag = `[team ${tool.action}]`;
        try {
            switch (tool.action) {
                case 'start': return await this._start(tool, call, tag);
                case 'wait': return await this._wait(tool, call, tag);
                case 'changes': return await this._changes(tool, call, tag);
                case 'review': return await this._review(tool, call, tag);
                case 'message': return await this._message(tool, call, tag);
                case 'merge': return await this._merge(tool, call, tag);
            }
        } catch (error) {
            return `${tag} ERROR: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private async _worker(tool: TeamTool, call: TeamCall, tag: string): Promise<BackgroundTask | string> {
        const team = await this.workers(call.team);
        const task = findWorker(team, tool.worker);
        if (task) { return task; }
        const known = team.length ? `This team's workers: ${team.map(task => `${workerLabel(task)} (${task.role ?? 'developer'})`).join(', ')}.` : 'This team has no worker yet.';
        return `${tag} ERROR: no worker "${tool.worker ?? ''}". ${known}`;
    }

    private async _start(tool: TeamTool, call: TeamCall, tag: string): Promise<string> {
        const prompt = tool.text?.trim();
        if (!prompt) { return `${tag} ERROR: give the worker its task in "text": complete and self-contained, since it sees nothing of this conversation.`; }
        const { maxWorkers, permissions } = this._host.settings();
        const now = this._now();
        const running = (await this._host.store.all()).filter(task => task.team && isActive(task, now) && !settled(task, now));
        if (running.length >= maxWorkers) {
            return `${tag} ERROR: ${running.length} workers are already running, the most allowed at once (the codico.teamMaxWorkers setting). Wait for one to finish first.`;
        }
        let from: string | undefined; let basedOn: string | undefined; let baseLabel = ''; let note = '';
        if (tool.worker) {
            const base = await this._worker(tool, call, tag);
            if (typeof base === 'string') { return base; }
            if (!settled(base, now)) { return `${tag} ERROR: worker ${workerLabel(base)} is still running. Wait for it, then start a worker from its branch.`; }
            // Whatever the base worker left uncommitted is part of what the new one starts from
            const committed = await commitTaskWork(base.worktree, `Codico: ${firstLine(base.prompt)}`);
            if ('error' in committed) { return `${tag} ERROR: ${committed.error}`; }
            from = base.branch; basedOn = base.id; baseLabel = workerLabel(base);
        } else if (call.repoRoot && await uncommittedCount(call.repoRoot) > 0) {
            note = ' Note: it starts from the last commit, so uncommitted changes in the workspace are not part of it.';
        }
        const role = tool.role ?? 'developer';
        // A name already used in the team gets a number: the orchestrator tells workers apart by it
        const taken = new Set((await this.workers(call.team)).map(task => task.name));
        const wanted = cleanWorkerName(tool.name);
        let name = wanted; for (let n = 2; name && taken.has(name); n++) { name = `${wanted}-${n}`; }
        const task = await this._host.createTask({ prompt, permissions, role, name, team: call.team, from, basedOn });
        if ('error' in task) { return `${tag} ERROR: the worker could not be started: ${task.error}`; }
        await this._host.launch(task);
        return `${tag} Started worker ${workerLabel(task)} (${role}) on branch ${task.branch}${basedOn ? `, from worker ${baseLabel}'s work` : ''}${this._host.where ? ` ${this._host.where()}` : ''}.${note} ` +
            'Start other independent workers now if there are any, then wait for them.';
    }

    private async _wait(tool: TeamTool, call: TeamCall, tag: string): Promise<string> {
        const team = await this.workers(call.team);
        let targets: BackgroundTask[];
        if (tool.workers?.length) {
            targets = [];
            for (const name of tool.workers) {
                const task = findWorker(team, name);
                if (!task) { return `${tag} ERROR: no worker "${name}" in this team. Its workers: ${team.map(task => workerLabel(task)).join(', ') || 'none'}.`; }
                targets.push(task);
            }
        } else { targets = team.filter(task => !task.merged); }
        if (targets.length === 0) { return `${tag} No worker to wait for: start one first.`; }
        const seconds = Math.min(tool.timeoutSeconds ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
        const until = this._now() + seconds * 1000;
        let current = targets;
        for (;;) {
            current = (await Promise.all(targets.map(task => this._host.store.get(task.id)))).map((task, i) => task ?? { ...targets[i], status: 'failed' as const, note: 'discarded by the user' });
            const now = this._now();
            if (current.every(task => settled(task, now)) || now >= until || call.signal.aborted) { break; }
            await this._sleep(WAIT_POLL_MS);
        }
        const now = this._now();
        const parts: string[] = [];
        for (const task of current) {
            const changes = await taskChanges(task.worktree, task.baseCommit).catch(() => ({ error: 'unknown' }));
            parts.push(workerSummary(task, this._status(task, now), 'error' in changes ? undefined : changes.stat));
        }
        const pending = current.filter(task => !settled(task, now)).length;
        const head = call.signal.aborted ? 'Stopped waiting.' : pending ? `Still running after ${seconds} s: ${pending} of ${current.length}. Wait again, or read what is there.` : 'All of them have stopped.';
        return `${tag} ${head}\n\n${parts.join('\n\n')}`;
    }

    private _status(task: BackgroundTask, now: number): string {
        if (lostItsWindow(task, now)) { return 'stopped: its window was closed'; }
        if (task.status === 'waiting') { return /question/.test(task.note ?? '') ? 'asks a question (answer it with message)' : `waiting for the user in its window (${task.note ?? 'an approval'})`; }
        return statusLabel(task, now);
    }

    private async _changes(tool: TeamTool, call: TeamCall, tag: string): Promise<string> {
        const task = await this._worker(tool, call, tag);
        if (typeof task === 'string') { return task; }
        const changes = await taskChanges(task.worktree, task.baseCommit);
        if ('error' in changes) { return `${tag} ERROR: ${changes.error}`; }
        if (changes.files === 0) { return `${tag} Worker ${workerLabel(task)} has not changed any file.`; }
        const patch = changes.patch.length > MAX_PATCH_CHARS ? `${changes.patch.slice(0, MAX_PATCH_CHARS)}\n… (cut: ${changes.patch.length - MAX_PATCH_CHARS} more characters; read the files on branch ${task.branch} for the rest)` : changes.patch;
        return `${tag} Worker ${workerLabel(task)}, ${changes.files} file${changes.files === 1 ? '' : 's'}:\n${changes.stat}\n\n\`\`\`diff\n${patch}\n\`\`\``;
    }

    private async _review(tool: TeamTool, call: TeamCall, tag: string): Promise<string> {
        const task = await this._worker(tool, call, tag);
        if (typeof task === 'string') { return task; }
        const changes = await taskChanges(task.worktree, task.baseCommit);
        if ('error' in changes) { return `${tag} ERROR: ${changes.error}`; }
        if (changes.files === 0) { return `${tag} Worker ${workerLabel(task)} has not changed any file: nothing to review.`; }
        const patch = changes.patch.slice(0, MAX_PATCH_CHARS);
        const report = await call.review(`You are the reviewer of an agent team. Review the patch below, made by a worker for this task: "${task.prompt.trim().slice(0, 1500)}".\n` +
            'The files you can read are the project before this patch. Look for bugs, missed requirements, broken callers and missing tests; read the surrounding code where the patch depends on it. ' +
            `${tool.text ? `Look most at: ${tool.text}\n` : ''}Report each problem with its file and line and why it is wrong, most serious first, then say whether the patch can be merged as it is.\n\n` +
            `\`\`\`diff\n${patch}\n\`\`\`${changes.patch.length > MAX_PATCH_CHARS ? '\n(The patch was cut here.)' : ''}`);
        return `${tag} Review of worker ${workerLabel(task)}:\n\n${report}`;
    }

    private async _message(tool: TeamTool, call: TeamCall, tag: string): Promise<string> {
        const task = await this._worker(tool, call, tag);
        if (typeof task === 'string') { return task; }
        const text = tool.text?.trim();
        if (!text) { return `${tag} ERROR: give the message in "text".`; }
        if (task.merged) { return `${tag} ERROR: worker ${workerLabel(task)} was merged already. Start a new worker for more work.`; }
        const now = this._now();
        if (lostItsWindow(task, now) || task.status === 'failed') { return `${tag} ERROR: worker ${workerLabel(task)} is not running any more (${this._status(task, now)}). Start a new worker instead.`; }
        const inbox = [...(task.inbox ?? []), { at: now, text }];
        // Running until it has answered: a wait right after this must not return its earlier report
        const idle = task.status === 'finished' || (task.status === 'waiting' && /question/.test(task.note ?? ''));
        await this._host.store.update(task.id, idle ? { inbox, status: 'running', note: undefined, heartbeat: now } : { inbox });
        return `${tag} Sent to worker ${workerLabel(task)}. It reads it at its next step (or now, if it was done). Wait for it to see its answer.`;
    }

    private async _merge(tool: TeamTool, call: TeamCall, tag: string): Promise<string> {
        const task = await this._worker(tool, call, tag);
        if (typeof task === 'string') { return task; }
        if (task.merged) { return `${tag} Worker ${workerLabel(task)} was merged already.`; }
        if (!settled(task, this._now())) { return `${tag} ERROR: worker ${workerLabel(task)} is still running. Wait for it first.`; }
        if (!call.repoRoot) { return `${tag} ERROR: the workspace is not in a git repository.`; }
        const changes = await taskChanges(task.worktree, task.baseCommit);
        if ('error' in changes) { return `${tag} ERROR: ${changes.error}`; }
        if (changes.files === 0) { return `${tag} Worker ${workerLabel(task)} has not changed any file: nothing to merge.`; }
        if (!await call.approveMerge(task, changes.stat)) { return `${tag} The user declined the merge of worker ${workerLabel(task)}. Do not merge it; ask the user what to change, or go on without it.`; }
        const committed = await commitTaskWork(task.worktree, `Codico: ${firstLine(task.prompt)}`);
        if ('error' in committed) { return `${tag} ERROR: ${committed.error}`; }
        const merged = await mergeTask(call.repoRoot, task.branch);
        if ('error' in merged) {
            return `${tag} Not merged: ${merged.error}. The merge was undone and nothing in the workspace changed. ` +
                'Message the worker to bring its branch up to date with the current state and resolve the conflict, or make the change yourself.';
        }
        await this._host.store.update(task.id, { merged: true });
        return `${tag} Merged worker ${workerLabel(task)} (${changes.files} file${changes.files === 1 ? '' : 's'}) into the workspace:\n${changes.stat}\n\n` +
            'Acceptance gate: run the build and the tests in the workspace now, before reporting the task as done.';
    }
}
