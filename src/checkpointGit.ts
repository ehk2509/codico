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
const REBUILT = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.git/', '.hg/', '.svn/', '.DS_Store', 'Thumbs.db'];
/**
 * Files that hold credentials. They are never copied into the store, whether or not the
 * project's .gitignore lists them: a checkpoint must not become a second place where a
 * secret lives. The price is that a rewind does not restore them.
 */
export const SENSITIVE = [
    '.env', '.env.*', '!.env.example', '!.env.sample', '!.env.template', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.kdbx',
    'id_rsa', 'id_rsa.*', 'id_dsa', 'id_ecdsa', 'id_ecdsa.*', 'id_ed25519', 'id_ed25519.*', '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.htpasswd',
    'credentials.json', 'credentials.yml', 'credentials.yaml', 'secrets.json', 'secrets.yml', 'secrets.yaml', 'service-account*.json', '*.tfstate', '*.tfstate.*', '*.tfvars',
    '.aws/', '.ssh/', '.gnupg/', '.kube/', '.azure/', '.docker/config.json',
];
const ALWAYS_EXCLUDED = [...REBUILT, ...SENSITIVE];
/** Changed whenever the exclusions change: a store made under older rules is deleted, since it may hold what the new rules keep out. */
const RULES_VERSION = 2;
const MARKER = 'CODICO-CHECKPOINTS.txt';
const SNAPSHOT_REFS = 'refs/codico/cp/';

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
        '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-c', 'core.logAllRefUpdates=false', '-c', 'user.name=Codico', '-c', 'user.email=codico@localhost', '-c', 'gc.auto=200', '-c', 'advice.addEmbeddedRepo=false',
        ...args], timeoutMs);
}

const sha = (text: string) => /^[0-9a-f]{40,64}$/.exec(text.trim())?.[0];

async function ensureRepository(shadow: string, workTree: string): Promise<boolean> {
    if (fs.existsSync(path.join(shadow, 'HEAD'))) {
        let rules = '';
        try { rules = await fs.promises.readFile(path.join(shadow, MARKER), 'utf8'); } catch { /* an older store has no rules line */ }
        if (rules.includes(`Rules: ${RULES_VERSION}\n`)) { return true; }
        await fs.promises.rm(shadow, { recursive: true, force: true });
    }
    // Readable by this user only: it holds a copy of the project's files
    await fs.promises.mkdir(shadow, { recursive: true, mode: 0o700 });
    try { await fs.promises.chmod(shadow, 0o700); } catch { /* a file system without permissions */ }
    const made = await run(shadow, workTree, ['init', '--quiet']);
    if (!made.ok) { return false; }
    await fs.promises.mkdir(path.join(shadow, 'info'), { recursive: true });
    await fs.promises.writeFile(path.join(shadow, 'info', 'exclude'), ALWAYS_EXCLUDED.join('\n') + '\n');
    // So that someone looking at the folder knows what it is and that it can be deleted
    await fs.promises.writeFile(path.join(shadow, MARKER), `Codico checkpoints of ${workTree}\nSafe to delete: only the ability to rewind to earlier messages is lost.\nRules: ${RULES_VERSION}\n`);
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
    // Each snapshot stands alone, under a name that carries its time: old ones can then be dropped without rewriting anything
    const tree = sha((await run(shadow, workTree, ['write-tree'])).stdout);
    if (!tree) { return undefined; }
    const commit = sha((await run(shadow, workTree, ['commit-tree', tree, '-m', label.slice(0, 200) || 'checkpoint'])).stdout);
    if (!commit) { return undefined; }
    const named = await run(shadow, workTree, ['update-ref', `${SNAPSHOT_REFS}${Date.now()}-${commit.slice(0, 12)}`, commit]);
    return named.ok ? commit : undefined;
}

/**
 * Deletes the snapshots older than `days` and what only they held. Returns how many went.
 * The state kept for "Undo Last Rewind" is not a dated snapshot and stays.
 */
export async function pruneSnapshots(storageRoot: string, workTree: string, days: number, now = Date.now()): Promise<number> {
    const shadow = shadowDir(storageRoot, workTree);
    if (!(days > 0) || !fs.existsSync(path.join(shadow, 'HEAD'))) { return 0; }
    const refs = (await run(shadow, workTree, ['for-each-ref', '--format=%(refname)', SNAPSHOT_REFS])).stdout.split('\n').filter(Boolean);
    const old = refs.filter(ref => { const taken = Number(/\/(\d+)-[0-9a-f]+$/.exec(ref)?.[1]); return Number.isFinite(taken) && now - taken > days * 86_400_000; });
    for (const ref of old) { await run(shadow, workTree, ['update-ref', '-d', ref]); }
    if (old.length > 0) { await run(shadow, workTree, ['gc', '--prune=now', '--quiet'], 300_000); }
    return old.length;
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
