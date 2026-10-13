import * as fs from 'fs';
import * as path from 'path';

/**
 * Confinement of terminal commands by the operating system, so that what a command may
 * touch does not depend on what the command says it does. Inside the sandbox a command can
 * read the machine, but write only in the workspace and in temporary folders, and cannot
 * read the folders where credentials are kept. Linux uses bubblewrap, macOS its built-in
 * sandbox; Windows has no equivalent that needs no installation.
 *
 * This file decides the rules and builds the wrapper command. It runs nothing.
 */
export type SandboxTool = 'bubblewrap' | 'seatbelt';

export interface SandboxPolicy {
    /** Folders the command may write to (the workspace, package caches). */
    writable: string[];
    /** Temporary folders: writable, and private to the command where the system allows it. */
    temporary: string[];
    /** Folders and files the command cannot read at all (credentials). */
    hidden: string[];
    network: boolean;
}

/** Where tools keep keys and tokens, relative to the home folder. A command has no business reading these. */
export const CREDENTIAL_PATHS = ['.ssh', '.aws', '.gnupg', '.kube', '.azure', '.netrc', '.config/gh', '.config/gcloud', '.docker/config.json', '.git-credentials'];
/** Caches package managers must write to for an install to work, relative to the home folder. */
export const CACHE_PATHS = ['.npm', '.cache', '.cargo', '.rustup', '.gradle', '.m2', '.local/share/pnpm', '.pnpm-store', 'go/pkg', '.bun/install', 'Library/Caches'];

export function sandboxToolFor(platform: NodeJS.Platform): SandboxTool | undefined {
    return platform === 'linux' ? 'bubblewrap' : platform === 'darwin' ? 'seatbelt' : undefined;
}

const exists = (target: string) => { try { fs.accessSync(target); return true; } catch { return false; } };
const real = (target: string) => { try { return fs.realpathSync.native(target); } catch { return target; } };

/**
 * A git worktree keeps its history in the repository it belongs to, outside its own folder.
 * Committing in the worktree writes there, so that folder must be writable too.
 */
export function gitCommonDir(folder: string): string | undefined {
    try {
        const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(folder, '.git'), 'utf8'))?.[1]?.trim();
        if (!pointer) { return undefined; }
        const gitDir = path.resolve(folder, pointer);
        const marker = `${path.sep}worktrees${path.sep}`;
        const at = gitDir.lastIndexOf(marker);
        return at > 0 ? gitDir.slice(0, at) : gitDir;
    } catch { return undefined; }
}

/** The rules for commands of this workspace. Paths that do not exist are left out: there is nothing to allow or hide. */
export function sandboxPolicy(options: { workspaceFolders: string[]; home: string; tmp: string; extraWritable?: string[]; network?: boolean }): SandboxPolicy {
    const unique = (paths: string[]) => [...new Set(paths.filter(exists).map(real))];
    const workspace = options.workspaceFolders.flatMap(folder => [folder, gitCommonDir(folder)].filter((item): item is string => !!item));
    const hidden = unique(CREDENTIAL_PATHS.map(item => path.join(options.home, item)));
    const writable = unique([...workspace, ...CACHE_PATHS.map(item => path.join(options.home, item)), ...(options.extraWritable ?? [])])
        // A configured path can widen what is writable, never uncover what is hidden
        .filter(target => !hidden.some(secret => target === secret || target.startsWith(secret + path.sep)));
    return { writable, temporary: unique([options.tmp, '/tmp', '/var/tmp']), hidden, network: options.network !== false };
}

/** The bubblewrap command line that runs `shell -c command` under the policy. */
export function bubblewrapArgs(policy: SandboxPolicy, shell: string, command: string): string[] {
    const args = [
        // The whole machine, read-only; real devices and processes replaced by private ones
        '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
        // When Codico stops or kills the wrapper, everything the command started goes with it
        '--unshare-pid', '--die-with-parent',
    ];
    for (const folder of policy.temporary) { args.push('--tmpfs', folder); }
    // After the temporary folders: a workspace that lives under /tmp must stay visible and writable
    for (const folder of policy.writable) { args.push('--bind', folder, folder); }
    for (const target of policy.hidden) {
        let isDirectory = false;
        try { isDirectory = fs.statSync(target).isDirectory(); } catch { /* gone meanwhile */ }
        args.push(...(isDirectory ? ['--tmpfs', target] : ['--ro-bind', '/dev/null', target]));
    }
    if (!policy.network) { args.push('--unshare-net'); }
    return [...args, '--', shell, '-c', command];
}

const quoted = (target: string) => `"${target.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The macOS sandbox profile for the policy. The last rule that matches decides. */
export function seatbeltProfile(policy: SandboxPolicy): string {
    const subpaths = (paths: string[]) => paths.map(target => `(subpath ${quoted(target)})`).join(' ');
    const lines = [
        '(version 1)',
        '(allow default)',
        '(deny file-write* (subpath "/"))',
        `(allow file-write* ${subpaths([...policy.writable, ...policy.temporary, '/private/var/folders', '/dev'])})`,
    ];
    if (policy.hidden.length > 0) { lines.push(`(deny file-read* file-write* ${subpaths(policy.hidden)})`); }
    if (!policy.network) { lines.push('(deny network*)'); }
    return lines.join('\n');
}

export interface SandboxedCommand { file: string; args: string[] }

/** How to start `command` inside the sandbox on this system. */
export function sandboxedCommand(tool: SandboxTool, policy: SandboxPolicy, shell: string, command: string): SandboxedCommand {
    return tool === 'bubblewrap'
        ? { file: 'bwrap', args: bubblewrapArgs(policy, shell, command) }
        : { file: '/usr/bin/sandbox-exec', args: ['-p', seatbeltProfile(policy), shell, '-c', command] };
}

/** True when a command's output shows it ran into the sandbox, so the agent can be told what that was. */
export function hitTheSandbox(output: string): boolean {
    return /Read-only file system|EROFS|Operation not permitted|EPERM|Permission denied|EACCES|Network is unreachable|Temporary failure in name resolution|Could not resolve host/i.test(output);
}

export function sandboxExplanation(policy: SandboxPolicy): string {
    return '[Sandbox] This command ran in Codico\'s sandbox. It can write only inside the workspace, package caches and temporary folders; ' +
        'it cannot read credential folders such as ~/.ssh' + (policy.network ? '' : '; and it has no network access') +
        '. If the failure above comes from that, do not try to get around it: say what the command needed, so the user can run it or change the sandbox settings.';
}
