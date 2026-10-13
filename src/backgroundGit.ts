import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** The git operations background tasks need. Each runs `git` with arguments, never through a shell. */

export interface GitResult { ok: boolean; stdout: string; stderr: string }

export function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
    return new Promise(resolve => {
        cp.execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
            resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (error ? error.message : '') });
        });
    });
}

const firstLine = (text: string) => text.trim().split('\n')[0]?.trim() ?? '';
/** git's own reason: the line it marks as fatal or error, without the progress lines around it. */
const gitReason = (text: string) => text.split('\n').map(line => line.trim()).find(line => /^(?:fatal|error):/i.test(line))?.replace(/^(?:fatal|error):\s*/i, '') ?? firstLine(text);

/** The top folder of the repository that holds `folder`, or undefined when it is not in one. */
export async function repositoryRoot(folder: string): Promise<string | undefined> {
    const result = await git(folder, ['rev-parse', '--show-toplevel']);
    return result.ok ? firstLine(result.stdout) || undefined : undefined;
}

export interface NewWorktree { baseCommit: string; baseBranch?: string }

/** Creates the task's branch at the current commit and checks it out in a new folder. */
export async function createWorktree(repoRoot: string, worktree: string, branch: string): Promise<NewWorktree | { error: string }> {
    const head = await git(repoRoot, ['rev-parse', 'HEAD']);
    if (!head.ok) { return { error: 'This repository has no commit yet. Commit something first: a background task starts from the last commit.' }; }
    const current = await git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    await fs.promises.mkdir(path.dirname(worktree), { recursive: true });
    const added = await git(repoRoot, ['worktree', 'add', '-b', branch, worktree, 'HEAD']);
    if (!added.ok) { return { error: gitReason(added.stderr) || 'git could not create the worktree' }; }
    return { baseCommit: firstLine(head.stdout), baseBranch: current.ok ? firstLine(current.stdout) || undefined : undefined };
}

/** Files that differ from the last commit in the repository the task starts from: the task will not see these changes. */
export async function uncommittedCount(repoRoot: string): Promise<number> {
    const status = await git(repoRoot, ['status', '--porcelain']);
    return status.ok ? status.stdout.split('\n').filter(line => line.trim()).length : 0;
}

/** Everything the task changed since it started, committed or not, as a patch and a summary. */
export async function taskChanges(worktree: string, baseCommit: string): Promise<{ patch: string; stat: string; files: number } | { error: string }> {
    // New files count too: mark them as "to be added" so that the diff shows them (nothing is committed)
    await git(worktree, ['add', '--intent-to-add', '--all']);
    const patch = await git(worktree, ['diff', '--no-color', baseCommit]);
    if (!patch.ok) { return { error: gitReason(patch.stderr) || 'git could not compare the task with where it started' }; }
    const stat = await git(worktree, ['diff', '--no-color', '--stat', baseCommit]);
    const names = await git(worktree, ['diff', '--name-only', baseCommit]);
    return { patch: patch.stdout, stat: stat.stdout.trimEnd(), files: names.stdout.split('\n').filter(Boolean).length };
}

/** Commits whatever the task left uncommitted in its worktree, so that its branch holds all of its work. */
export async function commitTaskWork(worktree: string, message: string): Promise<{ committed: boolean } | { error: string }> {
    await git(worktree, ['add', '--all']);
    const staged = await git(worktree, ['diff', '--cached', '--quiet']);
    if (staged.ok) { return { committed: false }; }
    const commit = await git(worktree, ['-c', 'user.name=Codico', '-c', 'user.email=codico@localhost', 'commit', '--no-verify', '-m', message]);
    return commit.ok ? { committed: true } : { error: gitReason(commit.stderr) || firstLine(commit.stdout) || 'git could not commit the task\'s work' };
}

/**
 * Merges the task's branch into what is checked out in the repository. On a conflict the
 * merge is undone, so the repository is left as it was.
 */
export async function mergeTask(repoRoot: string, branch: string): Promise<{ merged: true } | { error: string }> {
    const merge = await git(repoRoot, ['merge', '--no-ff', '--no-edit', branch]);
    if (merge.ok) { return { merged: true }; }
    const reason = /CONFLICT|Automatic merge failed/.test(merge.stdout + merge.stderr)
        ? 'the task\'s changes conflict with changes made here since it started'
        : gitReason(merge.stderr) || firstLine(merge.stdout) || 'git could not merge the branch';
    await git(repoRoot, ['merge', '--abort']);
    return { error: reason };
}

/** Removes the task's worktree and, unless asked to keep it, its branch. */
export async function removeWorktree(repoRoot: string, worktree: string, branch: string, keepBranch: boolean): Promise<{ error?: string }> {
    const removed = await git(repoRoot, ['worktree', 'remove', '--force', worktree]);
    if (!removed.ok && fs.existsSync(worktree)) { return { error: gitReason(removed.stderr) || 'git could not remove the worktree' }; }
    await git(repoRoot, ['worktree', 'prune']);
    if (!keepBranch) { await git(repoRoot, ['branch', '-D', branch]); }
    return {};
}
