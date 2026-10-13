import * as nodeCrypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { git, GitResult } from './backgroundGit';

/**
 * Snapshots of a whole workspace folder, kept in a git repository of Codico's own, outside
 * the project: the project's `.git` (if it has one) is never read or written. A snapshot
 * holds every file the project's own .gitignore does not exclude, whoever changed it:
 * the agent, a terminal command or the user.
 */

/** Folders that are rebuilt, not written: never worth copying, even in a project with no .gitignore. */
const ALWAYS_EXCLUDED = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.git/', '.hg/', '.svn/', '.DS_Store', 'Thumbs.db'];

export interface ChangedFile { status: 'modified' | 'added' | 'deleted'; path: string }

/** Where the snapshots of a workspace folder live: one repository per folder. */
export function shadowDir(storageRoot: string, workTree: string): string {
    const key = process.platform === 'win32' ? workTree.toLowerCase() : workTree;
    return path.join(storageRoot, nodeCrypto.createHash('sha256').update(key).digest('hex').slice(0, 16));
}

/**
 * Every command names the snapshot repository and the folder explicitly, and switches off
 * whatever the user's own git configuration would add: hooks, signing, line-ending
 * conversion. A snapshot must be the bytes on disk and must run nothing.
 */
function run(shadow: string, workTree: string, args: string[], timeoutMs = 120_000): Promise<GitResult> {
    return git(workTree, [
        `--git-dir=${shadow}`, `--work-tree=${workTree}`,
        '-c', `core.hooksPath=${path.join(shadow, 'no-hooks')}`, '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
        '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-c', 'user.name=Codico', '-c', 'user.email=codico@localhost', '-c', 'gc.auto=200', '-c', 'advice.addEmbeddedRepo=false',
        ...args], timeoutMs);
}

const sha = (text: string) => /^[0-9a-f]{40,64}$/.exec(text.trim())?.[0];

async function ensureRepository(shadow: string, workTree: string): Promise<boolean> {
    if (fs.existsSync(path.join(shadow, 'HEAD'))) { return true; }
    await fs.promises.mkdir(shadow, { recursive: true });
    const made = await run(shadow, workTree, ['init', '--quiet']);
    if (!made.ok) { return false; }
    await fs.promises.mkdir(path.join(shadow, 'info'), { recursive: true });
    await fs.promises.writeFile(path.join(shadow, 'info', 'exclude'), ALWAYS_EXCLUDED.join('\n') + '\n');
    // So that someone looking at the folder knows what it is and that it can be deleted
    await fs.promises.writeFile(path.join(shadow, 'CODICO-CHECKPOINTS.txt'), `Codico checkpoints of ${workTree}\nSafe to delete: only the ability to rewind to earlier messages is lost.\n`);
    return true;
}

/** Records the folder as it is now. Returns the snapshot's id, or undefined when git is missing or failed. */
export async function takeSnapshot(storageRoot: string, workTree: string, label: string): Promise<string | undefined> {
    const shadow = shadowDir(storageRoot, workTree);
    if (!await ensureRepository(shadow, workTree)) { return undefined; }
    const added = await run(shadow, workTree, ['add', '--all', '--ignore-errors', '.']);
    if (!added.ok && !/ignored|embedded/i.test(added.stderr)) {
        // Some files could not be read (locked, vanished meanwhile): the snapshot holds the rest
        if (!fs.existsSync(path.join(shadow, 'index'))) { return undefined; }
    }
    const committed = await run(shadow, workTree, ['commit', '--quiet', '--allow-empty', '--no-verify', '-m', label.slice(0, 200) || 'checkpoint']);
    if (!committed.ok) { return undefined; }
    return sha((await run(shadow, workTree, ['rev-parse', 'HEAD'])).stdout);
}

export async function snapshotExists(storageRoot: string, workTree: string, snapshot: string): Promise<boolean> {
    const shadow = shadowDir(storageRoot, workTree);
    if (!sha(snapshot) || !fs.existsSync(path.join(shadow, 'HEAD'))) { return false; }
    return (await run(shadow, workTree, ['cat-file', '-e', `${snapshot}^{commit}`])).ok;
}

/** What differs between two snapshots, as seen from the newer one: what going back would undo. */
export async function changesBetween(storageRoot: string, workTree: string, older: string, newer: string): Promise<ChangedFile[]> {
    const diff = await run(shadowDir(storageRoot, workTree), workTree, ['diff', '--name-status', '--no-renames', '-z', older, newer]);
    if (!diff.ok) { return []; }
    const parts = diff.stdout.split('\0').filter(Boolean);
    const files: ChangedFile[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
        files.push({ status: parts[i] === 'A' ? 'added' : parts[i] === 'D' ? 'deleted' : 'modified', path: parts[i + 1] });
    }
    return files;
}

/**
 * Makes the folder what it was at the snapshot: changed files are put back, files created
 * since are deleted, deleted files return. Files excluded from snapshots are not touched.
 * The folder must have been snapshotted just before, so that nothing in it is unrecorded.
 */
export async function restoreSnapshot(storageRoot: string, workTree: string, snapshot: string): Promise<{ error?: string }> {
    const shadow = shadowDir(storageRoot, workTree);
    const reset = await run(shadow, workTree, ['reset', '--hard', '--quiet', snapshot]);
    return reset.ok ? {} : { error: reset.stderr.trim().split('\n')[0] || 'git could not restore the snapshot' };
}

/** Keeps a snapshot from being cleaned up although nothing follows it any more (the state before a rewind). */
export async function keepSnapshot(storageRoot: string, workTree: string, name: string, snapshot: string): Promise<void> {
    await run(shadowDir(storageRoot, workTree), workTree, ['update-ref', `refs/codico/${name}`, snapshot]);
}

export async function keptSnapshot(storageRoot: string, workTree: string, name: string): Promise<string | undefined> {
    const shadow = shadowDir(storageRoot, workTree);
    if (!fs.existsSync(path.join(shadow, 'HEAD'))) { return undefined; }
    return sha((await run(shadow, workTree, ['rev-parse', '--verify', '--quiet', `refs/codico/${name}`])).stdout);
}

export async function deleteSnapshots(storageRoot: string, workTree: string): Promise<void> {
    await fs.promises.rm(shadowDir(storageRoot, workTree), { recursive: true, force: true });
}
