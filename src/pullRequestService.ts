import * as cp from 'child_process';
import * as vscode from 'vscode';
import { git } from './backgroundGit';
import { getGithubToken } from './prContextProvider';
import { parseGitHubRemote, pullRequestBody, pullRequestTitle, Repo, REVIEW_THREADS_QUERY, reviewTaskPrompt, reviewThreadsText, unresolvedThreads } from './pullRequests';
import { wrapUntrusted } from './untrustedContent';
import { ApiAnswer, GITHUB, GitHubApi, githubRequest } from './githubApi';

export { GITHUB, githubRequest } from './githubApi';
export type { ApiAnswer, GitHubApi } from './githubApi';

const apiMessage = (answer: ApiAnswer) => {
    const json = answer.json as { message?: unknown; errors?: Array<{ message?: unknown }> } | null;
    const detail = json?.errors?.map(error => error?.message).filter(Boolean).join('; ');
    return `${typeof json?.message === 'string' ? json.message : `HTTP ${answer.status}`}${detail ? ` (${detail})` : ''}`;
};

/** The token Codico already uses for pull requests, or the one the GitHub CLI holds when it is signed in. */
export async function githubToken(context: vscode.ExtensionContext): Promise<string | undefined> {
    const stored = await getGithubToken(context);
    if (stored) { return stored; }
    return new Promise(resolve => cp.execFile('gh', ['auth', 'token'], { timeout: 5000 }, (error, stdout) => resolve(error ? undefined : String(stdout).trim() || undefined)));
}

const NO_TOKEN = 'Codico needs a GitHub token for this. Set one with "Codico: Set GitHub Token" (it needs access to pull requests), or sign in to the GitHub CLI with "gh auth login".';

async function repository(cwd: string): Promise<Repo | undefined> {
    const remote = await git(cwd, ['remote', 'get-url', 'origin'], 10_000);
    return remote.ok ? parseGitHubRemote(remote.stdout) : undefined;
}

export interface PullRequestInput { cwd: string; branch: string; baseBranch?: string; prompt: string; stat: string }

/**
 * Pushes the branch and opens a pull request for it, after a confirmation that shows what
 * will be published and where. Returns the pull request's address.
 */
export async function openPullRequest(context: vscode.ExtensionContext, input: PullRequestInput, api: GitHubApi = GITHUB): Promise<string | undefined> {
    const repo = await repository(input.cwd);
    if (!repo) { void vscode.window.showWarningMessage('Codico: this repository has no "origin" remote on github.com, so there is nowhere to open a pull request.'); return undefined; }
    const token = await githubToken(context);
    if (!token) { void vscode.window.showWarningMessage(NO_TOKEN); return undefined; }
    let base = input.baseBranch;
    if (!base) {
        const about = await githubRequest(api, 'GET', `/repos/${repo.owner}/${repo.repo}`, token);
        base = (about.json as { default_branch?: string } | null)?.default_branch;
        if (!base) { void vscode.window.showErrorMessage(`Codico: GitHub did not say which branch ${repo.owner}/${repo.repo} uses by default: ${apiMessage(about)}`); return undefined; }
    }
    if (base === input.branch) { void vscode.window.showWarningMessage(`Codico: "${input.branch}" is the branch a pull request would go into. Work on another branch first.`); return undefined; }
    const title = pullRequestTitle(input.prompt);
    // Publishing: the code leaves the machine and other people are notified. Shown first, never assumed
    const choice = await vscode.window.showWarningMessage(`Open a pull request on ${repo.owner}/${repo.repo}?`,
        { modal: true, detail: `${input.branch} → ${base}\n\n${title}\n\n${input.stat.trim() || 'no file changed'}\n\nThe branch is pushed to "origin" first. A draft is not yet a request for review.` }, 'Create Draft', 'Create Pull Request');
    if (!choice) { return undefined; }
    const pushed = await git(input.cwd, ['-c', 'credential.interactive=false', 'push', '--set-upstream', 'origin', input.branch], 120_000);
    if (!pushed.ok) { void vscode.window.showErrorMessage(`Codico: the branch could not be pushed, so no pull request was opened: ${pushed.stderr.trim().split('\n').pop() ?? 'git push failed'}`); return undefined; }
    const created = await githubRequest(api, 'POST', `/repos/${repo.owner}/${repo.repo}/pulls`, token,
        { title, head: input.branch, base, body: pullRequestBody(input.prompt, input.stat), draft: choice === 'Create Draft' });
    let url = (created.json as { html_url?: string } | null)?.html_url;
    if (created.status === 422 && /already exists/i.test(apiMessage(created))) {
        const existing = await githubRequest(api, 'GET', `/repos/${repo.owner}/${repo.repo}/pulls?head=${encodeURIComponent(`${repo.owner}:${input.branch}`)}&state=open`, token);
        url = (existing.json as Array<{ html_url?: string }> | null)?.[0]?.html_url;
        if (url) { void vscode.window.showInformationMessage(`Codico: a pull request for ${input.branch} was already open; the branch has been pushed to it.`, 'Open').then(pick => { if (pick) { void vscode.env.openExternal(vscode.Uri.parse(url as string)); } }); return url; }
    }
    if (!url) { void vscode.window.showErrorMessage(`Codico: the branch was pushed, but GitHub did not open the pull request: ${apiMessage(created)}`); return undefined; }
    void vscode.window.showInformationMessage(`Codico: ${choice === 'Create Draft' ? 'draft pull request' : 'pull request'} opened.`, 'Open').then(pick => { if (pick) { void vscode.env.openExternal(vscode.Uri.parse(url as string)); } });
    return url;
}

/** "Codico: Create Pull Request": for the branch checked out in this window, from its commits. */
export async function createPullRequestForCurrentBranch(context: vscode.ExtensionContext, api: GitHubApi = GITHUB): Promise<string | undefined> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const branch = cwd ? (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 10_000)).stdout.trim() : '';
    if (!cwd || !branch) { void vscode.window.showWarningMessage('Codico: open a git repository with a branch checked out first.'); return undefined; }
    const dirty = (await git(cwd, ['status', '--porcelain'], 10_000)).stdout.split('\n').filter(line => line.trim()).length;
    if (dirty > 0) {
        const go = await vscode.window.showWarningMessage(`${dirty} uncommitted ${dirty === 1 ? 'change is' : 'changes are'} not part of the pull request.`, { modal: true, detail: 'Only what is committed on the branch is published. Commit first if they belong to it.' }, 'Continue');
        if (go !== 'Continue') { return undefined; }
    }
    const upstream = (await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', 'origin/HEAD'], 10_000)).stdout.trim().replace(/^origin\//, '');
    const range = upstream ? `origin/${upstream}..HEAD` : 'HEAD~1..HEAD';
    const subjects = (await git(cwd, ['log', '--format=%s', '--reverse', range], 10_000)).stdout.trim();
    const stat = (await git(cwd, ['diff', '--stat', upstream ? `origin/${upstream}...HEAD` : 'HEAD~1'], 10_000)).stdout;
    return openPullRequest(context, { cwd, branch, baseBranch: upstream || undefined, prompt: subjects || branch, stat }, api);
}

/**
 * "Codico: Address Review Comments": the open review threads of this branch's pull request,
 * given to the agent as a task. Nothing is posted back to GitHub.
 */
export async function addressReviewComments(context: vscode.ExtensionContext, send: (text: string) => Promise<void>, api: GitHubApi = GITHUB): Promise<number | undefined> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const branch = cwd ? (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 10_000)).stdout.trim() : '';
    const repo = cwd ? await repository(cwd) : undefined;
    if (!cwd || !branch || !repo) { void vscode.window.showWarningMessage('Codico: open a repository whose "origin" is on github.com, with the pull request\'s branch checked out.'); return undefined; }
    const token = await githubToken(context);
    if (!token) { void vscode.window.showWarningMessage(NO_TOKEN); return undefined; }
    const open = await githubRequest(api, 'GET', `/repos/${repo.owner}/${repo.repo}/pulls?head=${encodeURIComponent(`${repo.owner}:${branch}`)}&state=open`, token);
    const pr = (open.json as Array<{ number?: number; title?: string }> | null)?.[0];
    if (!pr?.number) { void vscode.window.showInformationMessage(open.status === 200 ? `Codico: no open pull request for branch ${branch}.` : `Codico: GitHub did not answer about pull requests: ${apiMessage(open)}`); return undefined; }
    const answer = await githubRequest(api, 'POST', '/graphql', token, { query: REVIEW_THREADS_QUERY, variables: { owner: repo.owner, repo: repo.repo, number: pr.number } });
    const threads = unresolvedThreads(answer.json);
    if (threads.length === 0) { void vscode.window.showInformationMessage(answer.status === 200 ? `Codico: pull request #${pr.number} has no open review comments.` : `Codico: the review comments could not be read: ${apiMessage(answer)}`); return 0; }
    await send(`${reviewTaskPrompt({ number: pr.number, title: pr.title ?? '' }, threads.length)}\n\n${wrapUntrusted(`review comments on pull request #${pr.number}`, reviewThreadsText(threads))}`);
    return threads.length;
}
