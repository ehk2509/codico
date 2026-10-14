/**
 * Background tasks: a task the agent works on in a git worktree of its own, in a second
 * window, while the user carries on in the first. This file holds what a task is and the
 * rules about it; nothing here touches VS Code, git or the disk.
 */
export type BackgroundStatus =
    | 'starting'   // worktree made, its window is opening
    | 'running'    // the agent is working
    | 'waiting'    // the agent needs an answer or an approval in its window
    | 'finished'   // the first reply is complete
    | 'failed';    // the task could not be started, or ended with an error

/** Whether the task may change files and run commands without asking, in its own worktree. */
export type BackgroundPermissions = 'ask' | 'edits' | 'all';

export interface BackgroundTask {
    id: string;
    /** What the user asked for. */
    prompt: string;
    /** The repository the task was started from. */
    repoRoot: string;
    /** The task's own checkout and branch. */
    worktree: string;
    branch: string;
    /** The commit the branch started at: what the task's changes are measured against. */
    baseCommit: string;
    /** The branch that was checked out in the repository when the task started. */
    baseBranch?: string;
    permissions: BackgroundPermissions;
    status: BackgroundStatus;
    createdAt: number;
    updatedAt: number;
    /** Written by the task's window while it runs: a task whose window closed stops beating. */
    heartbeat?: number;
    /** A line about how it ended or what it waits for. */
    note?: string;
    tokens?: number;
    requests?: number;
    /** A worker of an agent team: what it was started as, and the team (the orchestrating window's session) it belongs to. */
    role?: WorkerRole;
    /** A team worker's short name ("backend"). */
    name?: string;
    team?: string;
    /** The worker this one started from (a tester checks a developer's branch). */
    basedOn?: string;
    /** The worker's last reply, for the orchestrator. */
    report?: string;
    /** Messages to the worker; `inboxRead` of them have been given to it. */
    inbox?: Array<{ at: number; text: string }>;
    inboxRead?: number;
    /** Set once the orchestrator merged the worker's branch. */
    merged?: boolean;
}

export type WorkerRole = 'developer' | 'tester';

export const HEARTBEAT_MS = 10_000;
/** A running task with no heartbeat for this long has lost its window. */
export const STALE_AFTER_MS = 45_000;
export const BRANCH_PREFIX = 'codico/';
/** A task still not started after this long is waiting for its window: almost always for the folder to be trusted there. */
export const TRUST_WAIT_MS = 20_000;

/** True when the task's window has opened but has not taken the task up. */
export function waitingForItsWindow(task: BackgroundTask, now: number): boolean {
    return task.status === 'starting' && now - task.createdAt > TRUST_WAIT_MS;
}

/** A short name for the branch and the folder, from the first words of the task. */
export function taskSlug(prompt: string): string {
    const words = prompt.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
    const slug = words.slice(0, 5).join('-').slice(0, 36).replace(/-+$/, '');
    return slug || 'task';
}

export function branchName(prompt: string, id: string): string {
    return `${BRANCH_PREFIX}${taskSlug(prompt)}-${id.slice(0, 6)}`;
}

/** The folder of the task's worktree: <root>/<repository name>/<slug>-<id>. */
export function worktreeFolderName(prompt: string, id: string): string {
    return `${taskSlug(prompt)}-${id.slice(0, 6)}`;
}

/** True when the task says it is active but its window has stopped reporting. */
export function lostItsWindow(task: BackgroundTask, now: number): boolean {
    if (task.status !== 'running' && task.status !== 'waiting') { return false; }
    return now - (task.heartbeat ?? task.updatedAt) > STALE_AFTER_MS;
}

/** The status as shown to the user. */
export function statusLabel(task: BackgroundTask, now: number): string {
    if (lostItsWindow(task, now)) { return 'stopped (its window was closed)'; }
    switch (task.status) {
        case 'starting': return waitingForItsWindow(task, now) ? 'waiting for you: trust its folder in its window' : 'starting';
        case 'running': return 'running';
        case 'waiting': return 'needs you';
        case 'finished': return 'finished';
        case 'failed': return 'failed';
    }
}

export function statusIcon(task: BackgroundTask, now: number): string {
    if (lostItsWindow(task, now)) { return '$(debug-disconnect)'; }
    if (waitingForItsWindow(task, now)) { return '$(bell-dot)'; }
    return { starting: '$(loading~spin)', running: '$(sync~spin)', waiting: '$(bell-dot)', finished: '$(check)', failed: '$(error)' }[task.status];
}

export function isActive(task: BackgroundTask, now: number): boolean {
    return (task.status === 'starting' || task.status === 'running' || task.status === 'waiting') && !lostItsWindow(task, now);
}

/** "3 running, 1 needs you" for the status bar; empty when nothing is active. */
export function activeSummary(tasks: readonly BackgroundTask[], now: number): string {
    const active = tasks.filter(task => isActive(task, now));
    const waiting = active.filter(task => task.status === 'waiting' || waitingForItsWindow(task, now)).length;
    const running = active.length - waiting;
    return [running ? `${running} running` : '', waiting ? `${waiting} ${waiting === 1 ? 'needs' : 'need'} you` : ''].filter(Boolean).join(', ');
}

/** A status change worth telling the user about in the window that started the task. */
export function announcement(before: BackgroundTask | undefined, after: BackgroundTask): string | undefined {
    if (!before || before.status === after.status) { return undefined; }
    const name = after.prompt.replace(/\s+/g, ' ').trim();
    const short = name.length > 60 ? name.slice(0, 60) + '…' : name;
    if (after.status === 'finished') { return `Codico finished a background task: "${short}"`; }
    if (after.status === 'waiting') { return `A Codico background task needs you: "${short}"${after.note ? ` (${after.note})` : ''}`; }
    if (after.status === 'failed') { return `A Codico background task failed: "${short}"${after.note ? ` (${after.note})` : ''}`; }
    return undefined;
}

/** What the agent is told before the user's own words: where it is and what is different there. */
const ROLE_BRIEF: Record<WorkerRole, string> = {
    developer: '[Team: developer] You are the developer in a team led by another Codico agent (the orchestrator). Implement the task below completely, then check it: build it, and run or write the tests that show it works. ' +
        'Keep to the task; other workers may be changing other parts of the project at the same time. Finish with a short report: what you changed, how you checked it, and anything left open.\n',
    tester: '[Team: tester] You are the tester in a team led by another Codico agent (the orchestrator). Your branch starts from the work under test. Write the tests that the task below calls for, run them, and report exactly what passes and what fails, with the failing output. ' +
        'Change the code under test only if the task says so; otherwise report the faults for the developer to fix. Finish with a short report.\n',
};

export function taskPreface(task: Pick<BackgroundTask, 'branch' | 'baseBranch' | 'role'>): string {
    return (task.role ? ROLE_BRIEF[task.role] : '') + '[Background task] You are working in a separate git worktree of the project, on its own branch ' +
        `"${task.branch}"${task.baseBranch ? ` (started from "${task.baseBranch}")` : ''}. ` +
        'It is a fresh checkout: files that are not in git (installed dependencies, build output, local settings such as .env) are not here, ' +
        'so install or build what you need before running tests. The user is working elsewhere and will review the result on this branch. ' +
        'Do not switch branches, and do not push or merge.';
}

/** A task read from disk is used only if it has the shape this module writes. */
export function parseTask(text: string): BackgroundTask | undefined {
    let value: unknown;
    try { value = JSON.parse(text); } catch { return undefined; }
    if (!value || typeof value !== 'object') { return undefined; }
    const task = value as Record<string, unknown>;
    const strings = ['id', 'prompt', 'repoRoot', 'worktree', 'branch', 'baseCommit', 'status', 'permissions'];
    if (!strings.every(key => typeof task[key] === 'string' && task[key] !== '')) { return undefined; }
    if (!/^[a-f0-9]{8,64}$/.test(task.id as string)) { return undefined; }
    if (!['starting', 'running', 'waiting', 'finished', 'failed'].includes(task.status as string)) { return undefined; }
    if (!['ask', 'edits', 'all'].includes(task.permissions as string)) { return undefined; }
    if (!(task.branch as string).startsWith(BRANCH_PREFIX)) { return undefined; }
    if (typeof task.createdAt !== 'number' || typeof task.updatedAt !== 'number') { return undefined; }
    return value as BackgroundTask;
}
