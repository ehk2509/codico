import * as fs from 'fs';
import * as path from 'path';
import { commitTaskWork, git, taskChanges } from './backgroundGit';
import { BackgroundTask } from './backgroundTasks';
import { GitHubEvents } from './githubEvents';
import { dependencyOrder, readManifests, RepositoryInfo } from './repositories';
import { workerLabel } from './teamTools';

/** What cross-repository work needs from the turn: running a command, GitHub for a repository, and the user's say. */
export interface CrossRepoCall {
    signal: AbortSignal;
    /** Runs a command as run_terminal does (asked for like one); null exit code when it was declined or did not finish. */
    runCommand(command: string, cwd: string): Promise<{ exitCode: number | null; output: string; declined?: boolean }>;
    github(repoRoot: string): Promise<GitHubEvents | { error: string }>;
    /** Shows the plan of what is published; true when the user agrees. */
    approvePublish(plan: string): Promise<boolean>;
}

const tail = (text: string, chars = 6000) => text.length > chars ? `…${text.slice(-chars)}` : text;
const firstLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 72);
const IDENTITY = ['-c', 'user.name=Codico', '-c', 'user.email=codico@localhost'];

/** The repositories with what their manifests say. */
export function describe(repos: Array<{ name: string; root: string }>): RepositoryInfo[] {
    return repos.map(repo => ({ ...repo, ...readManifests(repo.root) }));
}

/**
 * Integration: every repository side by side in one folder (so that "../sdk" between them
 * resolves as it does next to each other), each at what it has now with the workers' branches
 * of that repository merged in; then the command, in the repository named. Rebuilt each time.
 */
export async function integrate(input: { repos: Array<{ name: string; root: string }>; workers: BackgroundTask[]; folder: string; command: string; runIn: string }, call: CrossRepoCall): Promise<string> {
    const lines: string[] = [];
    fs.mkdirSync(input.folder, { recursive: true });
    for (const repo of input.repos) {
        const target = path.join(input.folder, repo.name);
        // The integration from last time goes: this one starts from what each repository has now
        if (fs.existsSync(target)) { await git(repo.root, ['worktree', 'remove', '--force', target]); fs.rmSync(target, { recursive: true, force: true }); }
        await git(repo.root, ['worktree', 'prune']);
        const added = await git(repo.root, ['worktree', 'add', '--detach', target, 'HEAD'], 120_000);
        if (!added.ok) { return `ERROR: ${repo.name} could not be checked out for the integration: ${added.stderr.trim().split('\n').pop()}`; }
        const mine = input.workers.filter(task => path.resolve(task.repoRoot) === path.resolve(repo.root));
        const merged: string[] = [];
        for (const task of mine) {
            const committed = await commitTaskWork(task.worktree, `Codico: ${firstLine(task.prompt)}`);
            if ('error' in committed) { lines.push(`✗ ${repo.name}: worker ${workerLabel(task)}'s work could not be committed: ${committed.error}`); continue; }
            const merge = await git(target, [...IDENTITY, 'merge', '--no-ff', '--no-edit', task.branch], 120_000);
            if (merge.ok) { merged.push(workerLabel(task)); continue; }
            await git(target, ['merge', '--abort']);
            lines.push(`✗ ${repo.name}: worker ${workerLabel(task)}'s branch conflicts with ${merged.length ? `the other workers' (${merged.join(', ')})` : 'what the repository has now'}; it is left out`);
        }
        lines.push(`${repo.name}: ${merged.length ? `with ${merged.join(', ')}` : 'as it is (no worker in it)'}`);
    }
    const runIn = input.repos.find(repo => repo.name === input.runIn);
    if (!runIn) { return `ERROR: no repository "${input.runIn}". The repositories: ${input.repos.map(r => r.name).join(', ')}.`; }
    const result = await call.runCommand(input.command, path.join(input.folder, runIn.name));
    if (result.declined) { return `The integration was built (${input.folder}), but the user declined the command.\n${lines.join('\n')}`; }
    const verdict = result.exitCode === 0 ? 'PASSED' : `FAILED (exit ${result.exitCode ?? 'none: it did not finish'})`;
    return `Integrated test ${verdict}: \`${input.command}\` in ${runIn.name}, with every repository side by side in ${input.folder}:\n${lines.join('\n')}\n\nOutput:\n${tail(result.output)}`;
}

/** A pull request of a change across repositories: which it is, the others, and the order they are merged in. */
export function linkedBody(own: { repo: string; number: number }, all: Array<{ repo: string; number: number; name: string }>, summary: string): string {
    const index = all.findIndex(pr => pr.repo === own.repo && pr.number === own.number);
    const before = all.slice(0, index);
    const list = all.map((pr, i) => `${i + 1}. ${pr.repo}#${pr.number} (${pr.name})${i === index ? ' — this pull request' : ''}`).join('\n');
    return `Part of one change across ${all.length} repositories. Merge them in this order:\n\n${list}\n\n` +
        (before.length ? `**Depends on** ${before.map(pr => `${pr.repo}#${pr.number}`).join(', ')}: merge ${before.length === 1 ? 'it' : 'them'} first.\n\n` : '**Merge this one first**: the others depend on it.\n\n') +
        `## What changed here\n\n${summary.trim().slice(0, 5000) || '(no summary)'}\n\n---\nOpened by Codico's agent team; the pull requests were made and tested together.`;
}

/**
 * Publishing a change across repositories: each repository's worker branch pushed and opened
 * as a draft pull request, a dependency first, and each pull request then told of all the
 * others and of the order to merge them in. One worker per repository.
 */
export async function publish(input: { repos: Array<{ name: string; root: string }>; workers: BackgroundTask[] }, call: CrossRepoCall): Promise<string> {
    const byRepo = new Map<string, BackgroundTask[]>();
    for (const task of input.workers) {
        const repo = input.repos.find(r => path.resolve(r.root) === path.resolve(task.repoRoot));
        if (!repo) { return `ERROR: worker ${workerLabel(task)} works in ${task.repoRoot}, which is not one of the repositories.`; }
        byRepo.set(repo.name, [...(byRepo.get(repo.name) ?? []), task]);
    }
    const crowded = [...byRepo].filter(([, tasks]) => tasks.length > 1);
    if (crowded.length) { return `ERROR: one worker per repository can be published; ${crowded.map(([name, tasks]) => `${name} has ${tasks.map(workerLabel).join(', ')}`).join('; ')}. Name the workers to publish (workers: …), or have one worker build on the other's branch.`; }
    const order = dependencyOrder(describe(input.repos.filter(r => byRepo.has(r.name)))).order;
    const plan: Array<{ repo: { name: string; root: string }; task: BackgroundTask; github: GitHubEvents; slug: string; base: string; stat: string }> = [];
    for (const name of order) {
        const repo = input.repos.find(r => r.name === name)!;
        const task = byRepo.get(name)![0];
        const github = await call.github(repo.root);
        if ('error' in github) { return `ERROR: ${name}: ${github.error}.`; }
        const base = await github.defaultBranch();
        if (!base) { return `ERROR: ${name}: GitHub did not say which branch pull requests go into.`; }
        const changes = await taskChanges(task.worktree, task.baseCommit);
        if ('error' in changes || changes.files === 0) { return `ERROR: worker ${workerLabel(task)} in ${name} has ${'error' in changes ? `no readable changes: ${changes.error}` : 'not changed any file'}.`; }
        const slug = (await git(repo.root, ['config', '--get', 'remote.origin.url'])).stdout.trim().replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '');
        plan.push({ repo, task, github, slug, base, stat: changes.stat });
    }
    const summary = plan.map((step, i) => `${i + 1}. ${step.slug}: push ${step.task.branch} and open a draft pull request into ${step.base}\n${step.stat.split('\n').map(l => `     ${l}`).join('\n')}`).join('\n');
    if (!await call.approvePublish(`Push ${plan.length} branch${plan.length === 1 ? '' : 'es'} and open ${plan.length} linked draft pull request${plan.length === 1 ? '' : 's'}, in this order:\n${summary}`)) {
        return 'The user declined publishing. Nothing was pushed.';
    }
    const opened: Array<{ repo: string; number: number; url: string; name: string; github: GitHubEvents; task: BackgroundTask }> = [];
    for (const step of plan) {
        const committed = await commitTaskWork(step.task.worktree, `Codico: ${firstLine(step.task.prompt)}`);
        if ('error' in committed) { return `ERROR: ${step.repo.name}: ${committed.error}. Published before it: ${opened.map(pr => pr.url).join(', ') || 'none'}.`; }
        const pushed = await git(step.task.worktree, ['-c', 'credential.interactive=false', 'push', '--set-upstream', 'origin', step.task.branch], 120_000);
        if (!pushed.ok) { return `ERROR: ${step.repo.name}: the branch could not be pushed: ${pushed.stderr.trim().split('\n').pop()}. Published before it: ${opened.map(pr => pr.url).join(', ') || 'none'}.`; }
        const created = await step.github.createPull({ title: firstLine(step.task.prompt), body: 'Linking the other pull requests…', head: step.task.branch, base: step.base, draft: true });
        if ('error' in created) { return `ERROR: ${step.repo.name}: the pull request was not opened: ${created.error}. Published before it: ${opened.map(pr => pr.url).join(', ') || 'none'}.`; }
        opened.push({ repo: step.slug, number: created.number, url: created.url, name: step.repo.name, github: step.github, task: step.task });
    }
    // Now that every pull request has a number, each says where it stands
    const unlinked: string[] = [];
    for (const pr of opened) {
        const body = linkedBody(pr, opened, pr.task.report ?? pr.task.prompt);
        if (!await pr.github.updatePull(pr.number, { body })) { unlinked.push(`${pr.repo}#${pr.number}`); }
    }
    return `Opened ${opened.length} linked draft pull request${opened.length === 1 ? '' : 's'}, to be merged in this order:\n${opened.map((pr, i) => `${i + 1}. ${pr.url} (${pr.name})`).join('\n')}` +
        (unlinked.length ? `\nThe links could not be written into ${unlinked.join(', ')}.` : '');
}
