import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { CiEvent, checksState, failedJobs, Feedback, IssueEvent, labelledIssues, logTail, newCiFailures, pullState, reviews } from './automations';
import { GitHubApi, githubRequest } from './githubApi';
import { Repo, REVIEW_THREADS_QUERY, reviewThreadsText, unresolvedThreads } from './pullRequests';

/** Logs read per failed check, at most. */
const MAX_LOGS = 3;

/** A text download that follows GitHub's redirect to where the file is (logs live in signed blob storage, read without the token). */
function download(api: GitHubApi, path: string, token: string): Promise<string | undefined> {
    const get = (url: URL, auth: boolean, hops: number): Promise<string | undefined> => new Promise(resolve => {
        const request = (url.protocol === 'https:' ? https : http).get(url, {
            timeout: 20_000, headers: { 'User-Agent': 'Codico', ...(auth ? { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' } : {}) },
        }, response => {
            const status = response.statusCode ?? 0;
            if (status >= 300 && status < 400 && response.headers.location && hops > 0) {
                response.resume();
                const next = new URL(response.headers.location, url);
                // The token goes to GitHub only, never to the storage it redirects to
                resolve(get(next, next.host === url.host && auth, hops - 1));
                return;
            }
            if (status !== 200) { response.resume(); resolve(undefined); return; }
            const chunks: Buffer[] = []; let size = 0;
            response.on('data', (chunk: Buffer) => { size += chunk.length; if (size < 20 * 1024 * 1024) { chunks.push(chunk); } });
            response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        request.on('timeout', () => { request.destroy(); resolve(undefined); });
        request.on('error', () => resolve(undefined));
    });
    return get(new URL(`${api.protocol}//${api.host}${api.port ? `:${api.port}` : ''}${path}`), true, 3);
}

/** What the automations read from GitHub, for one repository. Every method answers, never throws: a failed read is "nothing new". */
export class GitHubEvents {
    constructor(private readonly _api: GitHubApi, private readonly _token: string, private readonly _repo: Repo) {}

    private get _base() { return `/repos/${this._repo.owner}/${this._repo.repo}`; }

    private async _get(path: string): Promise<unknown> {
        try {
            const answer = await githubRequest(this._api, 'GET', path, this._token);
            return answer.status === 200 ? answer.json : undefined;
        } catch { return undefined; }
    }

    /** The branch pull requests go into. */
    async defaultBranch(): Promise<string | undefined> {
        const about = await this._get(this._base) as { default_branch?: unknown } | undefined;
        return typeof about?.default_branch === 'string' ? about.default_branch : undefined;
    }

    async issues(label: string): Promise<IssueEvent[]> {
        return labelledIssues(await this._get(`${this._base}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=30&sort=created&direction=asc`));
    }

    /** New CI failures on the branch, each with its failed jobs and the end of their logs. */
    async ciFailures(branch: string): Promise<Array<{ event: CiEvent; log: string }>> {
        const found = newCiFailures(await this._get(`${this._base}/actions/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=30`), branch);
        const result: Array<{ event: CiEvent; log: string }> = [];
        for (const failure of found) {
            const jobs = failedJobs(await this._get(`${this._base}/actions/runs/${failure.runId}/jobs?filter=latest`));
            const logs: string[] = [];
            for (const job of jobs.slice(0, MAX_LOGS)) {
                const log = await download(this._api, `${this._base}/actions/jobs/${job.id}/logs`, this._token);
                if (log) { logs.push(`--- ${job.name}${job.steps.length ? ` (failed step: ${job.steps.join(', ')})` : ''} ---\n${logTail(log)}`); }
            }
            result.push({ event: { ...failure, failedJobs: jobs }, log: logs.join('\n\n') });
        }
        return result;
    }

    /** Everything about a pull request the automation acts on; undefined when it cannot be read. */
    async feedback(number: number): Promise<Feedback | undefined> {
        const pull = pullState(await this._get(`${this._base}/pulls/${number}`));
        if (!pull) { return undefined; }
        const checks = checksState(await this._get(`${this._base}/commits/${pull.headSha}/check-runs?per_page=100`));
        const list = reviews(await this._get(`${this._base}/pulls/${number}/reviews?per_page=100`));
        let threads: Feedback['threads'] = [];
        try {
            const answer = await githubRequest(this._api, 'POST', '/graphql', this._token, { query: REVIEW_THREADS_QUERY, variables: { owner: this._repo.owner, repo: this._repo.repo, number } });
            threads = unresolvedThreads(answer.json).map(thread => ({
                key: crypto.createHash('sha1').update(`${thread.path}\n${thread.comments[0]?.author}\n${thread.comments[0]?.body}`).digest('hex').slice(0, 16),
                text: reviewThreadsText([thread]).replace(/^1\. /, ''),
            }));
        } catch { /* review threads are read again next time */ }
        const logs = new Map<string, string>();
        if (pull.state === 'open' && checks.pending === 0) {
            for (const check of checks.failed.slice(0, MAX_LOGS)) {
                if (check.detailsId === undefined) { continue; }
                const log = await download(this._api, `${this._base}/actions/jobs/${check.detailsId}/logs`, this._token);
                if (log) { logs.set(check.name, logTail(log)); }
            }
        }
        return { pull, checks, reviews: list, threads, logs };
    }

    /** Opens a pull request; returns its number and address, or GitHub's reason. */
    async createPull(input: { title: string; body: string; head: string; base: string; draft: boolean }): Promise<{ number: number; url: string } | { error: string }> {
        try {
            const created = await githubRequest(this._api, 'POST', `${this._base}/pulls`, this._token, input);
            const pr = created.json as { number?: unknown; html_url?: unknown; message?: unknown } | null;
            if (typeof pr?.number === 'number' && typeof pr.html_url === 'string') { return { number: pr.number, url: pr.html_url }; }
            return { error: typeof pr?.message === 'string' ? pr.message : `HTTP ${created.status}` };
        } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
    }
}
