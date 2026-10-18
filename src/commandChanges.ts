/**
 * Files a shell command changed. The agent is meant to change files with edit_file and
 * write_file, which Codico records; a script run in the terminal (sed -i, a heredoc, a
 * Python one-off) changes them unseen, and without a recorded change none of the checks
 * that follow one run. Codico compares git's view of the working tree before and after
 * each command instead.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** How a command's result names the files it changed (the agent loop treats it as a code change). */
export const COMMAND_CHANGED_FILES = '[Files changed by this command]';

/** The text of changed files up to this size is kept, so their version before a command is known. */
const MAX_KEPT_BYTES = 512 * 1024;

export interface TreeState {
    /** The folder paths are relative to (the workspace folder). */
    root: string;
    /** Changed or new files (as git sees them), by path: their modification time and size, and their text when small. */
    files: Map<string, { stamp: string; text?: string }>;
}

const git = (cwd: string, args: string[]) => cp.spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** The changed and new files under `root`, or undefined when it is not in a git repository. */
export function treeState(root: string): TreeState | undefined {
    const status = git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--', '.']);
    if (status.status !== 0) { return undefined; }
    const prefix = git(root, ['rev-parse', '--show-prefix']).stdout.trim();
    const files = new Map<string, { stamp: string; text?: string }>();
    const entries = status.stdout.split('\0');
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.length < 4) { continue; }
        if (entry[0] === 'R' || entry[0] === 'C') { i++; } // the old name follows
        const file = entry.slice(3).slice(prefix.length);
        files.set(file, stampOf(root, file));
    }
    return { root, files };
}

function stampOf(root: string, file: string): { stamp: string; text?: string } {
    try {
        const stat = fs.statSync(path.join(root, file));
        if (!stat.isFile()) { return { stamp: 'other' }; }
        return { stamp: `${stat.mtimeMs}:${stat.size}`, ...(stat.size <= MAX_KEPT_BYTES ? { text: fs.readFileSync(path.join(root, file), 'utf8') } : {}) };
    } catch { return { stamp: 'deleted' }; }
}

/**
 * What changed between two states: each file with its text before (null: it did not exist)
 * and now. `known` gives a file's text as Codico last recorded it, for files it already knows.
 */
export function changesBetween(before: TreeState, after: TreeState, known: (file: string) => string | undefined): Array<{ path: string; before: string | null; after: string }> {
    const changes: Array<{ path: string; before: string | null; after: string }> = [];
    for (const [file, now] of after.files) {
        const then = before.files.get(file);
        if (then && then.stamp === now.stamp) { continue; }
        if (now.stamp === 'deleted' || now.stamp === 'other' || now.text === undefined) { continue; }
        const previous = then?.text ?? known(file) ?? committed(before.root, file);
        if (previous !== now.text) { changes.push({ path: file, before: previous, after: now.text }); }
    }
    return changes;
}

/** The file as last committed, or null when it is not in the last commit (a new file). */
function committed(root: string, file: string): string | null {
    const shown = git(root, ['show', `HEAD:./${file.replace(/\\/g, '/')}`]);
    return shown.status === 0 ? shown.stdout : null;
}
