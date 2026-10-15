import { BackgroundTask, WorkerRole } from './backgroundTasks';

/**
 * Agent teams: the agent in the panel (the orchestrator) plans the work, hands parts of it
 * to workers (developers and testers, each a background task with its own worktree and
 * window), reads their reports, has their changes reviewed, merges them and checks the
 * result. This file holds the `team` tool and the rules about it; nothing here touches
 * VS Code, git or the disk.
 */
export type TeamAction = 'start' | 'wait' | 'changes' | 'review' | 'message' | 'merge' | 'integrate' | 'publish';
export const TEAM_ACTIONS: readonly TeamAction[] = ['start', 'wait', 'changes', 'review', 'message', 'merge', 'integrate', 'publish'];

export interface TeamTool {
    type: 'team';
    action: TeamAction;
    /** start: what the worker is. */
    role?: WorkerRole;
    /** start: a short name for the worker, after its part of the work ("backend"). */
    name?: string;
    /** start: the repository the worker works in (one of several); integrate: where the command runs. */
    repo?: string;
    /** integrate: the integrated test command. */
    command?: string;
    /** start: the worker's task. message: the text sent. review: what to look at most. */
    text?: string;
    /** The worker acted on (its id); start: the worker whose branch the new one starts from. */
    worker?: string;
    /** wait: the workers waited for; all of the team's unmerged workers when absent. */
    workers?: string[];
    timeoutSeconds?: number;
}

export const DEFAULT_WAIT_SECONDS = 600;
export const MAX_WAIT_SECONDS = 1800;
/** How much of a worker's patch the orchestrator reads at once. */
export const MAX_PATCH_CHARS = 30_000;

/** The worker's id for the orchestrator: short, and unique enough within a team. */
export const workerId = (task: Pick<BackgroundTask, 'id'>) => task.id.slice(0, 8);
/** A worker's name: lowercase letters, digits and dashes, up to 24 characters. */
export const cleanWorkerName = (name: string | undefined) => (name ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || undefined;
/** How the orchestrator and the user see a worker: its name and id, or its id. */
export const workerLabel = (task: Pick<BackgroundTask, 'id' | 'name'>) => task.name ? `${task.name} (${workerId(task)})` : workerId(task);

/** The worker a name the model gave stands for: its name, its id, or the start of its id. The newest worker of that name wins. */
export function findWorker(tasks: readonly BackgroundTask[], name: string | undefined): BackgroundTask | undefined {
    const wanted = (name ?? '').trim().toLowerCase().replace(/^#/, '').replace(/\s*\([0-9a-f]+\)$/, '');
    const named = tasks.filter(task => task.name && task.name === cleanWorkerName(wanted));
    if (named.length > 0) { return named.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)); }
    if (wanted.length < 4) { return undefined; }
    const matches = tasks.filter(task => task.id.startsWith(wanted));
    return matches.length === 1 ? matches[0] : undefined;
}

const isAction = (value: unknown): value is TeamAction => typeof value === 'string' && (TEAM_ACTIONS as readonly string[]).includes(value);
const isRole = (value: unknown): value is WorkerRole => value === 'developer' || value === 'tester';

/** The call from the model's arguments (native tool calling); null when it cannot be run. */
export function teamToolFromArgs(args: Record<string, unknown>): TeamTool | null {
    const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
    if (!isAction(action)) { return null; }
    const str = (key: string) => typeof args[key] === 'string' && (args[key] as string).trim() ? (args[key] as string).trim() : undefined;
    const role = str('role')?.toLowerCase();
    const workers = Array.isArray(args.workers) ? args.workers.filter((w): w is string => typeof w === 'string' && w.trim() !== '').map(w => w.trim())
        : str('workers')?.split(/[\s,]+/).filter(Boolean);
    const seconds = typeof args.timeout_seconds === 'number' ? args.timeout_seconds : Number(str('timeout_seconds'));
    return {
        type: 'team', action,
        ...(isRole(role) ? { role } : {}),
        ...(cleanWorkerName(str('name')) ? { name: cleanWorkerName(str('name')) } : {}),
        ...(str('repo') ? { repo: str('repo') } : {}),
        ...(str('command') ? { command: str('command') } : {}),
        ...(str('text') ? { text: str('text') } : {}),
        ...(str('worker') ? { worker: str('worker') } : {}),
        ...(workers && workers.length ? { workers } : {}),
        ...(Number.isFinite(seconds) && seconds > 0 ? { timeoutSeconds: seconds } : {}),
    };
}

/**
 * The fenced form: "key: value" lines, then "text:" running to the end of the block.
 *   ```team
 *   action: start
 *   role: developer
 *   text:
 *   Add a /health endpoint…
 *   ```
 */
export function parseTeamFence(body: string): TeamTool | null {
    const at = body.search(/^text:/m);
    const head = at >= 0 ? body.slice(0, at) : body;
    const args: Record<string, unknown> = {};
    for (const line of head.split('\n')) {
        const match = line.match(/^\s*([a-z_]+)\s*:\s*(.*?)\s*$/);
        if (match) { args[match[1]] = match[2]; }
    }
    if (at >= 0) { args.text = body.slice(at + 'text:'.length).trim(); }
    return teamToolFromArgs(args);
}

/** What a call is about, for the panel's step line. */
export function teamLabel(tool: TeamTool): string {
    const first = (tool.text ?? '').split('\n')[0].slice(0, 70);
    switch (tool.action) {
        case 'start': return `${tool.name ?? tool.role ?? 'developer'}: ${first}`;
        case 'wait': return tool.workers?.length ? `waiting for ${tool.workers.join(', ')}` : 'waiting for the workers';
        case 'message': return `to ${tool.worker ?? '?'}: ${first}`;
        default: return `${tool.action} ${tool.worker ?? ''}`.trim();
    }
}

export const TEAM_TOOL_DESCRIPTION = 'Lead a team of workers. Each worker is another Codico agent with its own git worktree, branch and window, working in parallel with you; ' +
    'you plan, hand out parts of the work, read their reports, review and merge their changes, and check the result. Actions: ' +
    '"start" a worker (role developer or tester, name = a short name for its part such as backend or frontend, text = its complete task; worker = an existing worker whose branch it starts from, so a tester checks a developer\'s work); ' +
    '"wait" until workers have finished (workers = ids, all by default); "changes" shows a worker\'s patch; "review" has a read-only reviewer check a worker\'s patch (text = what to look at); ' +
    '"message" sends a worker a follow-up or an answer (text); "merge" merges a worker\'s branch into its repository after the user approves. ' +
    'Across several repositories: "start" with repo = the repository; "integrate" checks every repository out side by side with the workers\' branches merged in and runs command (in repo, by default the last in dependency order); ' +
    '"publish" pushes each repository\'s worker branch and opens linked draft pull requests in dependency order (workers = which, by default all unmerged).';

/** What the orchestrator is told, in a team turn. */
export function teamPromptSection(maxWorkers: number): string {
    return `[Agent team]
You lead a team for this task. You are the orchestrator: you plan, delegate and verify; workers do the implementation and testing.
Each worker is another Codico agent in its own git worktree, branch and editor window. It sees nothing of this conversation: give it a complete, self-contained task (goal, files and conventions that matter, how to check its work, what to report).
At most ${maxWorkers} workers run at once. Split the work so that workers change different files: parallel changes to the same lines conflict when merged.
How to run the team:
1. Plan: read what you need, then state the parts and which worker does each.
2. start a developer for each independent part, named after it (backend, frontend, docs…); refer to workers by name. A tester starts from a developer's branch (worker: <developer id>) once that developer has finished.
3. wait, then read each report. Use changes or review to check a worker's patch; use message to send a worker a correction or an answer to its question, then wait again.
4. merge each accepted worker. A merge that conflicts is undone: message the worker to rebase its work on the current state, or make the fix yourself.
5. Acceptance gate: after merging, run the project's build and tests in the workspace yourself, and fix or delegate what fails. Report done only when they pass.
Workers are not to be started for trivial work: a change you can make in a few edits, you make yourself.
Fenced form, when native tool calls are not available:
\`\`\`team
action: start
role: developer
name: backend
text:
<the complete task>
\`\`\`
\`\`\`team
action: wait
workers: <id> <id>
\`\`\`
\`\`\`team
action: merge
worker: <id>
\`\`\``;
}

/** One worker, as the orchestrator reads it. */
export function workerSummary(task: BackgroundTask, status: string, stat?: string): string {
    const lines = [`### Worker ${workerLabel(task)}, ${task.role ?? 'developer'}: ${status}${task.merged ? ', merged' : ''}`,
        `Task: ${task.prompt.replace(/\s+/g, ' ').trim().slice(0, 200)}`, `Branch: ${task.branch}`];
    if (task.note && task.status !== 'finished') { lines.push(`Note: ${task.note}`); }
    if (stat !== undefined) { lines.push(stat ? `Changes:\n${stat}` : 'Changes: none'); }
    if (task.report) { lines.push(`Report:\n${task.report.trim()}`); }
    return lines.join('\n');
}
