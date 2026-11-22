/** Portable Node.js workspace tools used by Codico outside the VS Code extension host. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildTerminalEnvironment, clipTerminalOutput, runTerminalProcess } from '../terminalProcess';
import type { ToolCall } from '../toolParser';
import { computeLineDiff } from '../lineDiff';

export type CliPermission = 'read' | 'edits' | 'all';
export type CliApproval = (kind: 'write' | 'command', description: string) => Promise<boolean>;

const SKIP_DIRS = new Set(['.git', '.codico', 'node_modules', 'out', 'dist', '.next', 'coverage', '.cache']);
const PROTECTED = new Set(['.git', '.env', '.npmrc', '.ssh', '.aws', '.gnupg', '.netrc']);
const READ_LIMIT = 16_000;
const TOOL_LIMIT = 12_000;
const FILE_LIMIT = 2 * 1024 * 1024;

function fileGlob(pattern: string): RegExp {
    // Cross-platform: glob syntax always uses '/', even on Windows.
    const normalized = pattern.replace(/\\/g, '/');
    let regex = '^';
    for (let i = 0; i < normalized.length; i++) {
        const char = normalized[i];
        if (char === '*' && normalized[i + 1] === '*') {
            i++;
            if (normalized[i + 1] === '/') { i++; regex += '(?:.*/)?'; }
            else { regex += '.*'; }
        } else if (char === '*') { regex += '[^/]*'; }
        else if (char === '?') { regex += '[^/]'; }
        else { regex += char.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&'); }
    }
    return new RegExp(regex + '$', 'i');
}

export class NodeWorkspace {
    readonly cwd: string;
    readonly permissions: CliPermission;
    private readonly approve: CliApproval;

    constructor(cwd: string, permissions: CliPermission = 'read', approve: CliApproval = async () => false) {
        this.cwd = fs.realpathSync(cwd);
        if (!fs.statSync(this.cwd).isDirectory()) { throw new Error('Workspace must be a directory'); }
        this.permissions = permissions;
        this.approve = approve;
    }

    /**
     * Publish a complete file in a single rename, rather than truncating the destination.
     * Renaming replaces a final symlink instead of following it, protecting against a
     * symlink introduced after approval. Preserve POSIX executable mode on replacements.
     */
    private async replaceAtomic(target: string, content: string): Promise<void> {
        const relative = path.relative(this.cwd, target);
        this.resolve(relative);
        const parent = path.dirname(target);
        await fs.promises.mkdir(parent, { recursive: true });
        this.resolve(relative);
        const temp = path.join(parent, `.codico-write-${randomUUID()}.tmp`);
        try {
            const previous = await fs.promises.stat(target).catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT') { return undefined; }
                throw error;
            });
            await fs.promises.writeFile(temp, content, {
                encoding: 'utf8', flag: 'wx', mode: previous?.mode ?? 0o666,
            });
            if (previous && process.platform !== 'win32') {
                await fs.promises.chmod(temp, previous.mode);
            }
            this.resolve(relative);
            await fs.promises.rename(temp, target);
        } finally {
            await fs.promises.rm(temp, { force: true }).catch(() => {});
        }
    }

    /** Reject escapes and symlink traversal, including a symlink inside an otherwise allowed path. */
    resolve(filepath: string): string {
        if (!filepath || typeof filepath !== 'string' || filepath.includes('\0')) { throw new Error('Invalid workspace path'); }
        if (path.isAbsolute(filepath) || path.win32.isAbsolute(filepath)) { throw new Error('Absolute paths are not allowed'); }
        const resolved = path.resolve(this.cwd, filepath);
        const rel = path.relative(this.cwd, resolved);
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) { throw new Error('Path escapes the workspace'); }
        const segments = rel.split(path.sep).filter(Boolean);
        if (segments.some(segment => PROTECTED.has(segment.toLowerCase()) || /^\.env\./i.test(segment))) { throw new Error('Protected path'); }
        let current = this.cwd;
        for (const segment of segments) {
            current = path.join(current, segment);
            try {
                if (fs.lstatSync(current).isSymbolicLink()) { throw new Error('Symlink paths are not allowed'); }
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') { break; }
                throw err;
            }
        }
        return resolved;
    }

    private async walk(folder: string, collect: (relative: string, absolute: string) => Promise<boolean> | boolean): Promise<void> {
        const pending = [folder];
        let visited = 0;
        while (pending.length && visited < 10_000) {
            const current = pending.pop()!;
            let entries: fs.Dirent[];
            try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { continue; }
            for (const item of entries) {
                if (visited++ >= 10_000) { break; }
                if (item.isSymbolicLink()) { continue; }
                const absolute = path.join(current, item.name);
                if (item.isDirectory()) {
                    if (!SKIP_DIRS.has(item.name) && !PROTECTED.has(item.name.toLowerCase()) && !item.name.startsWith('.env')) { pending.push(absolute); }
                } else if (item.isFile() && !PROTECTED.has(item.name.toLowerCase()) && !item.name.startsWith('.env')) {
                    const relative = path.relative(this.cwd, absolute).split(path.sep).join('/');
                    if (await collect(relative, absolute)) { return; }
                }
            }
        }
    }

    async execute(tool: ToolCall, signal: AbortSignal): Promise<string> {
        if (signal.aborted) { return 'Stopped'; }
        switch (tool.type) {
            case 'read_file': {
                const absolute = this.resolve(tool.filepath);
                const stat = await fs.promises.stat(absolute);
                if (!stat.isFile()) { return 'Not a file'; }
                if (stat.size > FILE_LIMIT) { return 'File too large to read (2 MB limit)'; }
                const content = await fs.promises.readFile(absolute, 'utf8');
                const lines = content.split(/\r?\n/);
                const start = Math.max(1, Math.floor(tool.startLine ?? 1));
                const end = Math.min(lines.length, Math.max(start, Math.floor(tool.endLine ?? start + 159)));
                return `[${tool.filepath}, lines ${start}-${end} of ${lines.length}]\n` + lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n').slice(0, READ_LIMIT);
            }
            case 'list_directory': {
                const absolute = this.resolve(tool.dirpath || '.');
                const names = await fs.promises.readdir(absolute, { withFileTypes: true });
                return names.filter(e => !SKIP_DIRS.has(e.name) && !PROTECTED.has(e.name.toLowerCase()) && !e.name.startsWith('.env') && !e.isSymbolicLink())
                    .slice(0, 200).map(e => `${e.isDirectory() ? 'dir ' : 'file'} ${e.name}`).join('\n');
            }
            case 'search_files': {
                const regex = tool.isRegex ? new RegExp(tool.pattern, 'i') : null;
                const glob = tool.glob ? fileGlob(tool.glob) : null;
                const matches: string[] = [];
                await this.walk(this.cwd, async (relative, absolute) => {
                    if (glob && !glob.test(relative)) { return false; }
                    const stat = await fs.promises.stat(absolute);
                    if (stat.size > FILE_LIMIT) { return false; }
                    const text = await fs.promises.readFile(absolute, 'utf8');
                    if (text.includes('\0')) { return false; }
                    for (const [index, line] of text.split(/\r?\n/).entries()) {
                        if (regex ? regex.test(line.slice(0, 1000)) : line.toLowerCase().includes(tool.pattern.toLowerCase())) {
                            matches.push(`${relative}:${index + 1}: ${line.trim().slice(0, 200)}`);
                            if (matches.length >= 60) { return true; }
                        }
                    }
                    return false;
                });
                return matches.join('\n').slice(0, TOOL_LIMIT) || 'No matches';
            }
            case 'find_files': {
                const base = this.resolve(tool.dirpath ?? '.');
                const found: string[] = [];
                const glob = fileGlob(tool.pattern.includes('/') ? tool.pattern : '**/' + tool.pattern);
                await this.walk(base, relative => {
                    if (glob.test(relative)) { found.push(relative); }
                    return found.length >= 100;
                });
                return found.join('\n') || 'No files found';
            }
            case 'write_file': {
                if (this.permissions === 'read') { return 'Denied: file changes are disabled. Use --allow-edits.'; }
                const target = this.resolve(tool.filepath);
                let original: string | undefined;
                try { original = await fs.promises.readFile(target, 'utf8'); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
                if (Buffer.byteLength(tool.content, 'utf8') > FILE_LIMIT) { return 'Edit rejected: proposed file exceeds 2 MB limit'; }
                if (original === tool.content) { return `Unchanged ${tool.filepath}`; }
                const diff = computeLineDiff(original ?? '', tool.content, 80);
                if (!await this.approve('write', `Write ${tool.filepath}\n${diff}`)) { return 'Denied: user did not approve file write'; }
                const current = await fs.promises.readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => {
                    if (error.code === 'ENOENT') { return undefined; }
                    throw error;
                });
                if (current !== original) { return 'Edit rejected: file changed while awaiting approval'; }
                await this.replaceAtomic(target, tool.content);
                return `Wrote ${tool.filepath} (${Buffer.byteLength(tool.content, 'utf8')} bytes)`;
            }
            case 'edit_file': {
                if (this.permissions === 'read') { return 'Denied: edits are disabled. Use --allow-edits.'; }
                const target = this.resolve(tool.filepath);
                const original = await fs.promises.readFile(target, 'utf8');
                if (!tool.oldStr || original.split(tool.oldStr).length !== 2) { return 'Edit rejected: old_str must match exactly once'; }
                const proposed = original.replace(tool.oldStr, tool.newStr);
                if (Buffer.byteLength(proposed, 'utf8') > FILE_LIMIT) { return 'Edit rejected: proposed file exceeds 2 MB limit'; }
                const diff = computeLineDiff(original, proposed, 80);
                if (!await this.approve('write', `Edit ${tool.filepath}\n${diff}`)) { return 'Denied: user did not approve edit'; }
                this.resolve(tool.filepath);
                const latest = await fs.promises.readFile(target, 'utf8');
                if (latest !== original) { return 'Edit rejected: file changed while awaiting approval'; }
                await this.replaceAtomic(target, proposed);
                return `Edited ${tool.filepath}`;
            }
            case 'run_terminal': {
                if (this.permissions !== 'all') { return 'Denied: commands are disabled. Use --allow-commands.'; }
                if (!await this.approve('command', `Run command: ${tool.command}`)) { return 'Denied: user did not approve command'; }
                const result = await runTerminalProcess({
                    command: tool.command,
                    cwd: this.cwd,
                    timeoutMs: 120_000,
                    signal,
                    env: buildTerminalEnvironment(),
                    maxCapturedBytes: 64 * 1024,
                });
                return `Exit code: ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}${result.stopped ? ' (stopped)' : ''}\n${clipTerminalOutput(result.output, TOOL_LIMIT)}${result.error ? '\n' + result.error : ''}`;
            }
            default: return `Tool '${tool.type}' is not supported in the standalone CLI yet`;
        }
    }
}
