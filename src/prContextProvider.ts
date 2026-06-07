/**
 * PR Context Provider
 *
 * Fetches GitHub Pull Request context for the current branch:
 *   - PR title, description, author, labels, status
 *   - Changed files list
 *   - Recent review comments
 *
 * Requires a GitHub Personal Access Token stored in VS Code secrets as
 * `codico.githubToken` (or the GITHUB_TOKEN env variable as fallback).
 *
 * Exported:
 *   buildPrContext()  — async, returns a formatted string for injection into
 *                       the AI system prompt / user message
 *   getPrUrl()        — returns the PR URL if one is open for the current branch
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as https from 'https';

// ── Git helpers ───────────────────────────────────────────────────────────────

function _exec(cmd: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve) => {
        cp.execFile(cmd, args, { cwd, timeout: 5000 }, (err, stdout) => {
            resolve(err ? '' : stdout.trim());
        });
    });
}

async function _getGitInfo(): Promise<{ cwd: string; branch: string; remote: string } | null> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return null; }

    const cwd    = folders[0].uri.fsPath;
    const branch = await _exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (!branch || branch === 'HEAD') { return null; }

    const remote = await _exec('git', ['remote', 'get-url', 'origin'], cwd);
    return { cwd, branch, remote };
}

/** Parse `owner/repo` from a git remote URL. */
export function _parseRepo(remoteUrl: string): { owner: string; repo: string } | null {
    // Handles https://github.com/owner/repo.git and git@github.com:owner/repo.git
    const m =
        remoteUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/) ??
        remoteUrl.match(/github\.com\/([\w.-]+)\/([\w.-]+)/);
    if (!m) { return null; }
    return { owner: m[1], repo: m[2] };
}

// ── GitHub API ────────────────────────────────────────────────────────────────

export function _ghGet(path: string, token: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: 'api.github.com',
                path,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github+json',
                    'User-Agent': 'vscode-codico',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            },
            (res) => {
                const parts: Buffer[] = [];
                res.on('data', (c: Buffer) => parts.push(c));
                res.on('end', () => {
                    try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); }
                    catch (e) { reject(e); }
                });
            }
        );
        req.on('error', reject);
        req.setTimeout(10_000, () => req.destroy(new Error('GitHub API timeout')));
        req.end();
    });
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface PrSummary {
    number: number;
    title: string;
    url: string;
    state: string;
    author: string;
    body: string;
    labels: string[];
    /** Changed file paths. */
    files: string[];
    /** Recent review comments (up to 5). */
    reviewComments: Array<{ author: string; file: string; line: number; body: string }>;
    /** Commits on this branch relative to base (up to 10). */
    commits: string[];
}

/**
 * Return the GitHub token from secrets or GITHUB_TOKEN env variable.
 * Returns `undefined` if none is available.
 */
export async function getGithubToken(context: vscode.ExtensionContext): Promise<string | undefined> {
    const secret = await context.secrets.get('codico.githubToken');
    if (secret) { return secret; }
    return process.env['GITHUB_TOKEN'];
}

/**
 * Fetch PR context for the current branch.
 * Returns `null` if no open PR is found or GitHub is unreachable.
 */
export async function fetchPrContext(
    context: vscode.ExtensionContext
): Promise<PrSummary | null> {
    const token = await getGithubToken(context);
    if (!token) { return null; }

    const git = await _getGitInfo();
    if (!git) { return null; }

    const parsed = _parseRepo(git.remote);
    if (!parsed) { return null; }

    const { owner, repo } = parsed;

    // Find open PR for current branch
    let prs: Array<{ number: number; title: string; html_url: string; state: string; user: { login: string }; body: string | null; labels: Array<{ name: string }> }>;
    try {
        const result = await _ghGet(
            `/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(owner + ':' + git.branch)}&state=open&per_page=1`,
            token
        ) as typeof prs;
        prs = result;
    } catch { return null; }

    if (!Array.isArray(prs) || prs.length === 0) { return null; }
    const pr = prs[0];

    // Fetch changed files
    let files: string[] = [];
    try {
        const filesResult = await _ghGet(`/repos/${owner}/${repo}/pulls/${pr.number}/files?per_page=50`, token) as Array<{ filename: string }>;
        files = filesResult.map(f => f.filename);
    } catch { /* skip */ }

    // Fetch review comments (condensed)
    let reviewComments: PrSummary['reviewComments'] = [];
    try {
        const comments = await _ghGet(`/repos/${owner}/${repo}/pulls/${pr.number}/comments?per_page=20`, token) as Array<{
            user: { login: string }; path: string; line?: number; original_line?: number; body: string;
        }>;
        reviewComments = comments.slice(0, 5).map(c => ({
            author: c.user.login,
            file:   c.path,
            line:   c.line ?? c.original_line ?? 0,
            body:   c.body.slice(0, 300),
        }));
    } catch { /* skip */ }

    // Fetch commits
    let commits: string[] = [];
    try {
        const commitsResult = await _ghGet(`/repos/${owner}/${repo}/pulls/${pr.number}/commits?per_page=10`, token) as Array<{ commit: { message: string } }>;
        commits = commitsResult.map(c => c.commit.message.split('\n')[0]);
    } catch { /* skip */ }

    return {
        number:  pr.number,
        title:   pr.title,
        url:     pr.html_url,
        state:   pr.state,
        author:  pr.user.login,
        body:    (pr.body ?? '').slice(0, 1000),
        labels:  pr.labels.map(l => l.name),
        files,
        reviewComments,
        commits,
    };
}

/**
 * Format a `PrSummary` into a context block suitable for injection into the AI prompt.
 */
export function formatPrContext(pr: PrSummary): string {
    const lines: string[] = [
        `[GitHub PR #${pr.number}: ${pr.title}]`,
        `URL: ${pr.url}`,
        `Author: ${pr.author}  |  State: ${pr.state}${pr.labels.length > 0 ? `  |  Labels: ${pr.labels.join(', ')}` : ''}`,
    ];

    if (pr.body) {
        lines.push(`\nDescription:\n${pr.body}`);
    }

    if (pr.commits.length > 0) {
        lines.push(`\nCommits (${pr.commits.length}):\n${pr.commits.map(c => `  • ${c}`).join('\n')}`);
    }

    if (pr.files.length > 0) {
        lines.push(`\nChanged files (${pr.files.length}):\n${pr.files.slice(0, 20).map(f => `  ${f}`).join('\n')}${pr.files.length > 20 ? `\n  … and ${pr.files.length - 20} more` : ''}`);
    }

    if (pr.reviewComments.length > 0) {
        const commentLines = pr.reviewComments.map(
            c => `  [${c.author}] ${c.file}:${c.line}\n  > ${c.body.replace(/\n/g, '  \n  ')}`
        );
        lines.push(`\nReview comments:\n${commentLines.join('\n\n')}`);
    }

    return lines.join('\n');
}

/**
 * All-in-one: fetch + format PR context.
 * Returns an empty string if no PR is found or on error.
 */
export async function buildPrContext(context: vscode.ExtensionContext): Promise<string> {
    try {
        const pr = await fetchPrContext(context);
        if (!pr) { return ''; }
        return formatPrContext(pr);
    } catch { return ''; }
}
