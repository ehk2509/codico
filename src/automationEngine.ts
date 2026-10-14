import * as nodeCrypto from 'crypto';
import * as fs from 'fs';
import { AutomationConfig, DEFAULT_CONFIG, decide, Job, jobPrompt, JobSource, pullRequestFor, replies, replyBody, resumePrompt, sourceKey } from './automations';
import { commitTaskWork, git, taskChanges } from './backgroundGit';
import { BackgroundPermissions, BackgroundTask } from './backgroundTasks';
import { BackgroundTaskStore } from './backgroundTaskStore';
import { GitHubEvents } from './githubEvents';
import { wrapUntrusted } from './untrustedContent';

/** What is kept per repository: whether it is watched, how, what was seen, and the jobs. */
export interface AutomationData {
    enabled: boolean;
    config: AutomationConfig;
    /** Events already acted on (sourceKey), so each happens once. */
    seen: string[];
    jobs: Job[];
}

export const emptyData = (): AutomationData => ({ enabled: false, config: { ...DEFAULT_CONFIG }, seen: [], jobs: [] });
/** Finished jobs kept for the list. */
export const MAX_DONE_JOBS = 30;

/** What the engine needs from the editor: where the repository and GitHub are, how tasks run, and the user. */
export interface AutomationHost {
    readonly store: BackgroundTaskStore;
    repoRoot(): Promise<string | undefined>;
    /** GitHub for this repository, or why it cannot be reached (no token, no GitHub remote). */
    github(): Promise<GitHubEvents | { error: string }>;
    load(): AutomationData;
    save(data: AutomationData): Promise<void>;
    createTask(options: { prompt: string; permissions: BackgroundPermissions; name?: string; from?: string; automation?: boolean }): Promise<BackgroundTask | { error: string }>;
    launch(task: BackgroundTask): void;
    resume(task: BackgroundTask, text: string): Promise<void>;
    permissions(): BackgroundPermissions;
    /** A job is ready to be published and publishing is "ask": the user is asked, and their answer calls publish(). */
    askToPublish(job: Job, stat: string): void;
    /** Something the user should know (a pull request opened, a job that needs them). */
    tell(text: string, job?: Job): void;
    now?(): number;
}

const MAX_LOG = 40;

/**
 * The automations of one repository: each tick reads GitHub, starts jobs for new events,
 * publishes finished work and follows the pull requests, resuming a job's agent when CI fails
 * or a reviewer asks for changes. Its state is saved after every tick.
 */
export class AutomationEngine {
    private _ticking = false;
    private readonly _publishing = new Set<string>();
    /** Why the last tick could not read GitHub; shown in the list. */
    lastProblem: string | undefined;

    constructor(private readonly _host: AutomationHost) {}

    private _now(): number { return this._host.now?.() ?? Date.now(); }

    private _log(job: Job, text: string): void {
        job.log.push({ at: this._now(), text });
        if (job.log.length > MAX_LOG) { job.log.splice(0, job.log.length - MAX_LOG); }
        job.updatedAt = this._now();
    }

    private _set(job: Job, state: Job['state'], note?: string): void {
        job.state = state; job.note = note;
        this._log(job, note ? `${state}: ${note}` : state);
    }

    /** One round: jobs moved on, pull requests read, new events turned into jobs. Never runs twice at once. */
    async tick(): Promise<void> {
        if (this._ticking) { return; }
        this._ticking = true;
        try {
            const data = this._host.load();
            if (!data.enabled) { return; }
            const github = await this._host.github();
            if ('error' in github) { this.lastProblem = github.error; return; }
            this.lastProblem = undefined;
            for (const job of data.jobs) { await this._advance(job, data, github); }
            await this._newEvents(data, github);
            // Old finished jobs go, so the list and the file stay small
            const done = data.jobs.filter(job => job.state === 'done');
            if (done.length > MAX_DONE_JOBS) { const drop = new Set(done.slice(0, done.length - MAX_DONE_JOBS).map(job => job.id)); data.jobs = data.jobs.filter(job => !drop.has(job.id)); }
            await this._host.save(data);
        } finally { this._ticking = false; }
    }

    private async _advance(job: Job, data: AutomationData, github: GitHubEvents): Promise<void> {
        if (job.state === 'working') {
            const task = await this._host.store.get(job.taskId);
            if (!task) { this._set(job, 'needs-you', 'its task was discarded'); return; }
            if (task.status === 'failed') { this._set(job, 'needs-you', `its task failed: ${task.note ?? 'see the Agents view'}`); this._host.tell(`Codico automation: ${this._what(job)} needs you: its task failed.`, job); return; }
            if (task.status === 'waiting') { if (job.note !== 'waits for you in the Agents view') { job.note = 'waits for you in the Agents view'; this._host.tell(`Codico automation: ${this._what(job)} waits for you (${task.note ?? 'an answer or an approval'}).`, job); } return; }
            if (task.status !== 'finished') { return; }
            job.note = undefined;
            await this._ready(job, data, task);
            return;
        }
        if (job.state === 'watching' && job.pr && data.config.prFeedback) {
            const feedback = await github.feedback(job.pr.number);
            if (!feedback) { return; }
            const decision = decide(job, feedback, data.config.maxResumes);
            if (decision.kind === 'finish') { this._set(job, 'done', decision.why); return; }
            if (decision.kind === 'stop') { this._set(job, 'needs-you', decision.why); this._host.tell(`Codico automation: pull request #${job.pr.number} needs you: ${decision.why}.`, job); return; }
            if (decision.kind === 'resume') {
                const task = await this._host.store.get(job.taskId);
                if (!task) { this._set(job, 'needs-you', 'its task was discarded'); return; }
                job.handledSha = decision.sha;
                job.handledReviews.push(...decision.reviews);
                job.handledThreads.push(...decision.threads);
                job.pendingReplies = data.config.replyToReviews && decision.replies.length ? decision.replies : undefined;
                job.resumes++;
                const missing = await this._ensureWorktree(task);
                if (missing) { this._set(job, 'needs-you', missing); return; }
                const prompt = resumePrompt(job.pr, decision);
                this._set(job, 'working', `resumed (${job.resumes} of ${data.config.maxResumes}) for feedback on pull request #${job.pr.number}`);
                await this._host.resume(task, `${prompt.task}\n\n${wrapUntrusted(prompt.outsideLabel, prompt.outside)}`);
            }
        }
    }

    /** A job's agent finished: its work is published (or offered), or there was nothing to publish. */
    private async _ready(job: Job, data: AutomationData, task: BackgroundTask): Promise<void> {
        const changes = await taskChanges(task.worktree, task.baseCommit);
        if ('error' in changes) { this._set(job, 'needs-you', changes.error); return; }
        if (!job.pr && changes.files === 0) {
            this._set(job, 'done', 'the agent changed nothing (see its report in the Agents view)');
            this._host.tell(`Codico automation: ${this._what(job)} ended without a change. Its report says why.`, job);
            return;
        }
        this._set(job, 'publishing', data.config.publish === 'ask' ? 'waiting for you to publish it' : undefined);
        if (data.config.publish === 'ask') { this._host.askToPublish(job, changes.stat); return; }
        await this.publish(job.id, data);
    }

    /**
     * Commits the job's work, pushes its branch and opens its pull request (a draft), or pushes
     * to the pull request it has. Called by a tick (publish: auto) or by the user's answer.
     */
    async publish(jobId: string, given?: AutomationData): Promise<string> {
        if (this._publishing.has(jobId)) { return 'Already being published.'; }
        this._publishing.add(jobId);
        const data = given ?? this._host.load();
        const job = data.jobs.find(j => j.id === jobId);
        try {
            if (!job || job.state !== 'publishing') { return 'There is nothing to publish for it.'; }
            const task = await this._host.store.get(job.taskId);
            const github = await this._host.github();
            if (!task) { this._set(job, 'needs-you', 'its task was discarded'); return job.note ?? ''; }
            if ('error' in github) { this._set(job, 'needs-you', github.error); return github.error; }
            const missing = await this._ensureWorktree(task);
            if (missing) { this._set(job, 'needs-you', missing); return missing; }
            const committed = await commitTaskWork(task.worktree, `Codico: ${job.source.kind === 'issue' ? `fix #${job.source.number}` : `fix ${job.source.workflow}`}${job.resumes ? ` (after feedback ${job.resumes})` : ''}`);
            if ('error' in committed) { this._set(job, 'needs-you', committed.error); return committed.error; }
            const pushed = await git(task.worktree, ['-c', 'credential.interactive=false', 'push', '--set-upstream', 'origin', task.branch], 120_000);
            if (!pushed.ok) { const why = `the branch could not be pushed: ${pushed.stderr.trim().split('\n').pop() ?? 'git push failed'}`; this._set(job, 'needs-you', why); this._host.tell(`Codico automation: ${why}`, job); return why; }
            if (job.pr) {
                // The answers to the review comments go in their threads once the change they describe is pushed
                const answered = await this._reply(job, task, github);
                this._set(job, 'watching', `${committed.committed ? `pushed to pull request #${job.pr.number}` : `no new change for pull request #${job.pr.number}`}${answered ? `; answered ${answered} review comment${answered === 1 ? '' : 's'}` : ''}`);
                this._host.tell(`Codico automation: ${committed.committed ? `pushed the changes to pull request #${job.pr.number}` : `nothing changed for the feedback on pull request #${job.pr.number}; see its report`}.`, job);
                return job.note ?? '';
            }
            const base = job.source.kind === 'ci' ? job.source.branch : await github.defaultBranch();
            if (!base) { this._set(job, 'needs-you', 'GitHub did not say which branch the pull request should go into'); return job.note ?? ''; }
            const stat = await taskChanges(task.worktree, task.baseCommit);
            const pr = pullRequestFor(job.source, task.report ?? '', 'error' in stat ? '' : stat.stat);
            const created = await github.createPull({ ...pr, head: task.branch, base, draft: true });
            if ('error' in created) { this._set(job, 'needs-you', `the pull request was not opened: ${created.error}`); return job.note ?? ''; }
            job.pr = created;
            job.handledSha = undefined;
            this._set(job, 'watching', `draft pull request #${created.number} opened`);
            this._host.tell(`Codico automation: opened draft pull request #${created.number} for ${this._what(job)}. It follows CI and reviews there.`, job);
            return job.note ?? '';
        } finally {
            this._publishing.delete(jobId);
            if (!given) { await this._host.save(data); }
        }
    }

    /**
     * The job's worktree, made again from its pushed branch when it is gone (a fresh checkout,
     * as in each run of a CI workflow). Returns what went wrong, or undefined.
     */
    private async _ensureWorktree(task: BackgroundTask): Promise<string | undefined> {
        if (fs.existsSync(task.worktree)) { return undefined; }
        const root = await this._host.repoRoot();
        if (!root) { return 'its worktree is gone, and this folder is not a git repository to make it again'; }
        await git(root, ['worktree', 'prune']);
        const fetched = await git(root, ['-c', 'credential.interactive=false', 'fetch', 'origin', `+${task.branch}:refs/remotes/origin/${task.branch}`], 120_000);
        if (!fetched.ok) { return `its worktree is gone and its branch ${task.branch} could not be fetched`; }
        const added = await git(root, ['worktree', 'add', '-B', task.branch, task.worktree, `origin/${task.branch}`], 120_000);
        return added.ok ? undefined : `its worktree could not be made again: ${added.stderr.trim().split('\n').pop() ?? 'git worktree add failed'}`;
    }

    private async _reply(job: Job, task: BackgroundTask, github: GitHubEvents): Promise<number> {
        const pending = job.pendingReplies ?? [];
        job.pendingReplies = undefined;
        if (pending.length === 0) { return 0; }
        const answers = replies(task.report ?? '');
        let posted = 0;
        for (const { threadId, n } of pending) {
            const text = answers.get(n);
            if (text && await github.replyToThread(threadId, replyBody(text))) { posted++; }
        }
        if (posted < pending.length) { this._log(job, `${pending.length - posted} review comment${pending.length - posted === 1 ? ' was' : 's were'} not answered (no reply for ${pending.length - posted === 1 ? 'it' : 'them'} in the agent's report, or GitHub refused)`); }
        return posted;
    }

    /** The user stops a job: its pull request is no longer followed (it stays open on GitHub). */
    async stop(jobId: string): Promise<void> {
        const data = this._host.load();
        const job = data.jobs.find(j => j.id === jobId);
        if (job && job.state !== 'done') { this._set(job, 'done', 'stopped by the user'); await this._host.save(data); }
    }

    private async _newEvents(data: AutomationData, github: GitHubEvents): Promise<void> {
        const active = () => data.jobs.filter(job => job.state === 'working' || job.state === 'publishing').length;
        if (active() >= data.config.maxJobs) { return; }
        const seen = new Set(data.seen);
        const candidates: Array<{ source: JobSource; outside?: string }> = [];
        if (data.config.issueLabel) { candidates.push(...(await github.issues(data.config.issueLabel)).filter(issue => !seen.has(sourceKey(issue))).map(source => ({ source }))); }
        if (data.config.ciFailures && candidates.length === 0) {
            const branch = await github.defaultBranch();
            // A failure on a branch Codico is already fixing is not a new job
            if (branch) { candidates.push(...(await github.ciFailures(branch)).filter(found => !seen.has(sourceKey(found.event))).map(found => ({ source: found.event, outside: found.log }))); }
        }
        for (const candidate of candidates) {
            if (active() >= data.config.maxJobs) { break; }
            await this._start(candidate.source, candidate.outside, data, github);
        }
    }

    private async _start(source: JobSource, ciLog: string | undefined, data: AutomationData, github: GitHubEvents): Promise<void> {
        data.seen.push(sourceKey(source));
        if (data.seen.length > 500) { data.seen.splice(0, data.seen.length - 500); }
        // Jobs start from what is on GitHub, not from what is checked out here
        const base = source.kind === 'ci' ? source.branch : await github.defaultBranch();
        const root = await this._host.repoRoot();
        let from: string | undefined;
        if (root && base) { const fetched = await git(root, ['-c', 'credential.interactive=false', 'fetch', 'origin', base], 120_000); if (fetched.ok) { from = `origin/${base}`; } }
        const prompt = jobPrompt(source);
        const outside = source.kind === 'ci' ? (ciLog || '(the log could not be read)') : prompt.outside;
        const name = source.kind === 'issue' ? `issue-${source.number}` : `ci-${source.workflow.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 16)}`;
        const task = await this._host.createTask({ prompt: `${prompt.task}\n\n${wrapUntrusted(prompt.outsideLabel, outside)}`, permissions: this._host.permissions(), name, from, automation: true });
        const now = this._now();
        const job: Job = { id: nodeCrypto.randomBytes(6).toString('hex'), source, taskId: 'error' in task ? '' : task.id, branch: 'error' in task ? '' : task.branch,
            state: 'working', handledReviews: [], handledThreads: [], resumes: 0, createdAt: now, updatedAt: now, log: [] };
        data.jobs.push(job);
        if ('error' in task) { this._set(job, 'needs-you', `its task could not be started: ${task.error}`); return; }
        this._log(job, `started from ${from ?? 'the last local commit'}`);
        this._host.launch(task);
        this._host.tell(`Codico automation: working on ${this._what(job)} (in the Agents view).`, job);
    }

    private _what(job: Job): string { return job.source.kind === 'issue' ? `issue #${job.source.number}` : `the CI failure of ${job.source.workflow}`; }
}
