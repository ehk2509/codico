import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { addToMcpJson, removeFromMcpJson } from './mcpCatalog';
import { hookKey, installPlan, InstallPlan, Lock, LOCK_FILE, PackageManifest, readLock, readManifest, RegistryPackage, RegistryVersion, sourceProblem } from './marketplace';
import { contentHash, packageFiles, PackageFile, readTarGz } from './packageArchive';
import { scanPackage, ScanResult } from './packageScan';

/** What the installer needs from outside: the network, and the project it installs into. */
export interface InstallerHost {
    /** The project's folder. */
    readonly root: string;
    fetchJson(url: string): Promise<unknown>;
    fetchBuffer(url: string): Promise<Buffer>;
    /** Where GitHub serves a commit as a .tar.gz (a stand-in in tests). */
    archiveUrl?(repo: string, commit: string): string;
}

/** A package read, checked and scanned, ready to be shown to the user and then installed. */
export interface Prepared {
    pkg: RegistryPackage;
    version: RegistryVersion;
    manifest: PackageManifest;
    files: PackageFile[];
    plan: InstallPlan;
    scan: ScanResult;
    /** Why its source is not its publisher's, when it is not (shown, and installing is refused). */
    sourceProblem?: string;
}

export const githubArchive = (repo: string, commit: string) => `https://codeload.github.com/${repo}/tar.gz/${commit}`;
const sha256 = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');

/** Installs, updates and removes marketplace packages in one project. Nothing is written before the user has seen what will be. */
export class MarketplaceInstaller {
    constructor(private readonly _host: InstallerHost) {}

    private _abs(rel: string): string { return path.join(this._host.root, ...rel.split('/')); }
    private _read(rel: string): string | undefined { try { return fs.readFileSync(this._abs(rel), 'utf8'); } catch { return undefined; } }
    private _mcpFile(): string { return ['.mcp.json', 'mcp.json'].find(name => fs.existsSync(this._abs(name))) ?? '.mcp.json'; }

    lock(): Lock { return readLock(this._read(LOCK_FILE)); }

    /** Names in use: the project's own skills, agents and MCP servers, and other packages' (a package being updated does not count against itself). */
    private _taken(except?: string): { skills: string[]; agents: string[]; mcpServers: string[] } {
        const own = except ? this.lock().packages[except] : undefined;
        const mine = new Set(own?.files.map(f => f.path) ?? []);
        const list = (dir: string) => { try { return fs.readdirSync(this._abs(dir)); } catch { return []; } };
        const skills = list('.codico/skills').filter(name => ![...mine].some(p => p.startsWith(`.codico/skills/${name}/`))).map(name => name.replace(/\.md$/, ''));
        const agents = list('.codico/agents').filter(name => name.endsWith('.md') && !mine.has(`.codico/agents/${name}`)).map(name => name.replace(/\.md$/, ''));
        let servers: string[] = [];
        try { servers = Object.keys((JSON.parse(this._read(this._mcpFile()) ?? '{}') as { mcpServers?: object }).mcpServers ?? {}); } catch { /* reported when it is written */ }
        return { skills, agents, mcpServers: servers.filter(name => !(own?.mcpServers ?? []).includes(name)) };
    }

    /**
     * Downloads the version's commit, checks that it is what the registry recorded, reads its
     * manifest, plans where it goes and scans it. Writes nothing.
     */
    async prepare(pkg: RegistryPackage, version: RegistryVersion): Promise<Prepared | { error: string }> {
        let archive: Buffer;
        try { archive = await this._host.fetchBuffer((this._host.archiveUrl ?? githubArchive)(version.repo, version.commit)); } catch (error) { return { error: `the package could not be downloaded: ${error instanceof Error ? error.message : String(error)}` }; }
        let files: PackageFile[];
        try { files = packageFiles(readTarGz(archive), version.path); } catch (error) { return { error: `the package was refused: ${error instanceof Error ? error.message : String(error)}` }; }
        // What the registry reviewed is what is installed: the same files, byte for byte
        const hash = contentHash(files);
        if (hash !== version.hash) { return { error: `the package's content does not match the registry (${hash.slice(0, 19)}… instead of ${version.hash.slice(0, 19)}…): it was not installed` }; }
        const manifest = readManifest(files);
        if ('error' in manifest) { return { error: `the package is not valid: ${manifest.error}` }; }
        if (manifest.id !== pkg.id || manifest.version !== version.version) { return { error: `the package says it is ${manifest.id} ${manifest.version}, the registry ${pkg.id} ${version.version}` }; }
        const plan = installPlan(manifest, files, this._taken(this.lock().packages[pkg.id] ? pkg.id : undefined));
        if ('error' in plan) { return { error: plan.error }; }
        return { pkg, version, manifest, files, plan, scan: scanPackage(manifest, files), ...(sourceProblem(pkg, version) ? { sourceProblem: sourceProblem(pkg, version) } : {}) };
    }

    /** Writes a prepared package (replacing its earlier version, if any) and records it. Returns the files of the earlier version kept because the user changed them. */
    install(prepared: Prepared): { kept: string[] } {
        if (prepared.sourceProblem) { throw new Error(prepared.sourceProblem); }
        const id = prepared.pkg.id;
        const kept = this.lock().packages[id] ? this.uninstall(id).kept : [];
        const { plan } = prepared;
        const written: Array<{ path: string; sha256: string }> = [];
        for (const file of plan.files) {
            const target = this._abs(file.path);
            // A file the user changed from an earlier version is not overwritten
            if (kept.includes(file.path)) { continue; }
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, file.data);
            written.push({ path: file.path, sha256: sha256(file.data) });
        }
        if (plan.mcpServers.length) {
            const name = this._mcpFile();
            let text = this._read(name);
            for (const server of plan.mcpServers) { text = addToMcpJson(text, { id: server.name, command: server.command, args: server.args, env: server.env }); }
            fs.writeFileSync(this._abs(name), text ?? '');
        }
        if (plan.hooks.length) {
            let config: { hooks?: unknown[] } = {};
            try { config = JSON.parse(this._read('.codico/hooks.json') ?? '{}'); } catch { throw new Error('.codico/hooks.json is not valid JSON; fix it first (it was not changed)'); }
            const hooks = Array.isArray(config.hooks) ? config.hooks : [];
            const present = new Set(hooks.map(h => hookKey(h as never)));
            config.hooks = [...hooks, ...plan.hooks.filter(h => !present.has(hookKey(h))).map(h => ({ ...h, name: h.name ?? `${id} hook` }))];
            fs.mkdirSync(this._abs('.codico'), { recursive: true });
            fs.writeFileSync(this._abs('.codico/hooks.json'), JSON.stringify(config, null, 2) + '\n');
        }
        const lock = this.lock();
        lock.packages[id] = { version: prepared.version.version, commit: prepared.version.commit, hash: prepared.version.hash, installedAt: new Date().toISOString(),
            files: written, mcpServers: plan.mcpServers.map(s => s.name), hooks: plan.hooks.map(hookKey) };
        this._writeLock(lock);
        return { kept };
    }

    /** Removes what a package added. Files the user changed since are kept, and returned. */
    uninstall(id: string): { kept: string[] } {
        const lock = this.lock();
        const entry = lock.packages[id];
        if (!entry) { return { kept: [] }; }
        const kept: string[] = [];
        for (const file of entry.files) {
            const target = this._abs(file.path);
            let now: Buffer | undefined;
            try { now = fs.readFileSync(target); } catch { continue; }
            if (sha256(now) !== file.sha256) { kept.push(file.path); continue; }
            fs.rmSync(target);
            // Empty folders it made go too (never the .codico folders themselves)
            for (let dir = path.dirname(target); dir.startsWith(this._abs('.codico/skills/')) && dir !== this._abs('.codico/skills'); dir = path.dirname(dir)) {
                try { if (fs.readdirSync(dir).length === 0) { fs.rmdirSync(dir); } else { break; } } catch { break; }
            }
        }
        if (entry.mcpServers.length) {
            const name = this._mcpFile();
            let text = this._read(name);
            if (text !== undefined) { for (const server of entry.mcpServers) { text = removeFromMcpJson(text, server); } fs.writeFileSync(this._abs(name), text); }
        }
        if (entry.hooks.length) {
            try {
                const config = JSON.parse(this._read('.codico/hooks.json') ?? '{}') as { hooks?: unknown[] };
                config.hooks = (config.hooks ?? []).filter(h => !entry.hooks.includes(hookKey(h as never)));
                fs.writeFileSync(this._abs('.codico/hooks.json'), JSON.stringify(config, null, 2) + '\n');
            } catch { kept.push('.codico/hooks.json (not valid JSON: its hooks were left)'); }
        }
        delete lock.packages[id];
        this._writeLock(lock);
        return { kept };
    }

    private _writeLock(lock: Lock): void {
        fs.mkdirSync(this._abs('.codico'), { recursive: true });
        fs.writeFileSync(this._abs(LOCK_FILE), JSON.stringify(lock, null, 2) + '\n');
    }
}

/** What the user is shown before installing: contents, commands, permissions, scan, source. */
export function installSummary(prepared: Prepared): string {
    const { plan, manifest, scan, pkg, version } = prepared;
    const lines: string[] = [];
    lines.push(`${pkg.id} ${version.version} — ${pkg.publisher.verified ? 'verified publisher' : 'publisher NOT verified'} (${pkg.publisher.github}), from ${version.repo}@${version.commit.slice(0, 7)}`);
    if (prepared.sourceProblem) { lines.push(`⛔ ${prepared.sourceProblem}`); }
    lines.push('', 'It adds:');
    if (plan.skills.length) { lines.push(`• skills: ${plan.skills.map(s => `/${s}`).join(', ')}`); }
    if (plan.agents.length) { lines.push(`• agents: ${plan.agents.map(a => `@${a}`).join(', ')}`); }
    for (const server of plan.mcpServers) { lines.push(`• MCP server "${server.name}": ${[server.command, ...server.args].join(' ')}${server.env ? ` (env: ${Object.keys(server.env).join(', ')})` : ''}`); }
    for (const hook of plan.hooks) { lines.push(`• hook ${hook.event}${hook.match ? ` on ${hook.match}` : ''}: ${hook.command}`); }
    const p = manifest.permissions ?? {};
    lines.push('', `It declares: commands ${p.commands?.length ? p.commands.join(', ') : 'none'}; network ${p.network?.length ? p.network.join(', ') : 'none'}; environment ${p.env?.length ? p.env.join(', ') : 'none'}.`);
    lines.push('', `Security scan: ${{ high: 'HIGH RISK', medium: 'things to check', low: 'nothing found' }[scan.risk]}.`);
    for (const finding of scan.findings.slice(0, 12)) { lines.push(`${{ danger: '⛔', warning: '⚠', info: '·' }[finding.severity]} ${finding.file}${finding.line ? `:${finding.line}` : ''} — ${finding.text}`); }
    if (scan.findings.length > 12) { lines.push(`… and ${scan.findings.length - 12} more`); }
    lines.push('', 'Files go in .codico (skills, agents, hooks) and .mcp.json, recorded in .codico/packages.json so that it can be updated or removed exactly. MCP servers and hooks still ask before they first run.');
    return lines.join('\n');
}
