/**
 * Whether a check that passes now also passes without the turn's change. Codico finds out
 * itself: it runs the check in a scratch worktree holding the workspace as it is, with the
 * turn's changes undone except those to tests. A failure there shows that the tests catch the
 * problem the change fixes, so the agent need not undo and redo its own work to show it.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isTestFile } from './agentEfficiency';
import { exitCodeHidden, testSummary } from './patchPassport';

/** Dependencies installed in the workspace, shared with the scratch worktree rather than copied. */
const SHARED = ['node_modules', '.venv', 'venv'];

export { isTestFile };

export interface TurnChange { path: string; before: string | null; after: string }

const git = (cwd: string, args: string[]) => cp.spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/**
 * A scratch worktree of the workspace without the turn's changes to files other than tests,
 * and the folder in it that stands for `root`. Undefined when there is no git repository.
 */
export function withoutChange(root: string, changes: readonly TurnChange[]): { dir: string; root: string; remove(): void } | undefined {
    const top = git(root, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0) { return undefined; }
    const repo = top.stdout.trim();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-repro-'));
    const remove = (): void => { git(repo, ['worktree', 'remove', '--force', dir]); fs.rmSync(dir, { recursive: true, force: true }); git(repo, ['worktree', 'prune']); };
    if (git(repo, ['worktree', 'add', '--detach', '--quiet', dir, 'HEAD']).status !== 0) { fs.rmSync(dir, { recursive: true, force: true }); return undefined; }
    try {
        // What is not committed is part of the workspace: it is copied as it is now
        const entries = git(repo, ['status', '--porcelain', '-z', '--untracked-files=all']).stdout.split('\0');
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.length < 4) { continue; }
            const [code, file] = [entry.slice(0, 2), entry.slice(3)];
            if (code.startsWith('R') || code.startsWith('C')) { i++; } // the old name follows
            const target = path.join(dir, file);
            if (code.includes('D')) { fs.rmSync(target, { force: true }); continue; }
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(repo, file), target);
        }
        // The turn's changes are undone, except to tests: they are what shows the problem
        for (const change of changes) {
            const relative = path.relative(repo, path.isAbsolute(change.path) ? change.path : path.join(root, change.path));
            if (relative.startsWith('..') || isTestFile(relative)) { continue; }
            const target = path.join(dir, relative);
            if (change.before === null) { fs.rmSync(target, { force: true }); continue; }
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, change.before);
        }
        for (const name of SHARED) {
            const source = path.join(repo, name);
            if (fs.existsSync(source) && !fs.existsSync(path.join(dir, name))) { fs.symlinkSync(source, path.join(dir, name), 'dir'); }
        }
        return { dir, root: path.join(dir, path.relative(repo, root)), remove };
    } catch {
        remove();
        return undefined;
    }
}

/** The command as it would run in `to` instead of `from`: an absolute path into the workspace points into the scratch worktree. */
export function commandIn(command: string, from: string, to: string): string {
    const variants = [...new Set([from, safeRealpath(from)])].sort((a, b) => b.length - a.length);
    return variants.reduce((text, variant) => text.split(variant).join(to), command);
}

const safeRealpath = (p: string): string => { try { return fs.realpathSync.native(p); } catch { return p; } };

/**
 * What a run without the change says. Only a test failure counts as the problem shown: a run that
 * fails without a test summary may have failed for another reason (a missing tool, the scratch copy).
 */
export function outcomeWithoutChange(command: string, exitCode: number | null, output: string): 'failed' | 'passed' | 'unknown' {
    // The scratch worktree has no build output (it is ignored by git): a test that loads it fails for that alone
    if (/Cannot find module|MODULE_NOT_FOUND|No module named|ModuleNotFoundError/.test(output)) { return 'unknown'; }
    // A pass is believed only from the tests' own summary: an exit code of 0 can be another command's
    const summary = testSummary(output);
    if (summary) { return summary.failed > 0 ? 'failed' : exitCode === 0 || exitCodeHidden(command) ? 'passed' : 'unknown'; }
    return 'unknown';
}
