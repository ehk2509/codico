import { PackageFile } from './packageArchive';
import { nameProblem } from './userExtensions';

/**
 * The marketplace: community packages of skills, agents, MCP servers and hooks, listed in a
 * registry (a GitHub repository whose index pins each version to a commit and a content hash),
 * checked and scanned before anything is installed, installed into the project's .codico
 * folder and .mcp.json, and recorded so that an update or an uninstall touches exactly what
 * was installed. This file is the rules; it talks to nobody and writes nothing.
 */

export const MANIFEST = 'codico-package.json';
export const LOCK_FILE = '.codico/packages.json';

export interface PackageHook { event: string; match?: string; name?: string; command: string }
export interface PackageMcpServer { command: string; args?: string[]; env?: Record<string, string> }

/** What a package says it contains and needs. */
export interface PackageManifest {
    /** publisher/name: the publisher is a GitHub account. */
    id: string;
    version: string;
    description: string;
    /** Folders with a SKILL.md, or single .md files. */
    skills?: string[];
    /** .md files. */
    agents?: string[];
    mcpServers?: Record<string, PackageMcpServer>;
    hooks?: PackageHook[];
    /** What it needs, said up front: shown before installing and compared with what the scan finds. */
    permissions?: { commands?: string[]; network?: string[]; env?: string[] };
}

export interface RegistryVersion {
    version: string;
    /** owner/name of the GitHub repository, the commit and the folder in it. */
    repo: string;
    commit: string;
    path: string;
    /** contentHash() of the package's files: what was reviewed is what is installed. */
    hash: string;
    published?: string;
}

export interface RegistryPackage {
    id: string;
    description: string;
    publisher: { github: string; verified: boolean };
    homepage?: string;
    tags?: string[];
    /** What the latest version contains, for the list. */
    contains?: Partial<Record<'skills' | 'agents' | 'mcpServers' | 'hooks', number>>;
    versions: RegistryVersion[];
}

export interface Lock { packages: Record<string, LockEntry> }
export interface LockEntry {
    version: string; commit: string; hash: string; installedAt: string;
    /** The files it wrote, with their SHA-256 then: a file changed since is the user's, and is kept. */
    files: Array<{ path: string; sha256: string }>;
    mcpServers: string[];
    /** hookKey() of the hooks it added. */
    hooks: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,49}$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const HASH_RE = /^sha256-[0-9a-f]{64}$/;
const HOOK_EVENTS = ['beforeEdit', 'afterEdit', 'beforeCommand', 'afterCommand'];

/** Version order: -1, 0 or 1 (pre-releases before their release). */
export function compareVersions(a: string, b: string): number {
    const pa = SEMVER_RE.exec(a); const pb = SEMVER_RE.exec(b);
    if (!pa || !pb) { return a.localeCompare(b); }
    for (let i = 1; i <= 3; i++) { const d = Number(pa[i]) - Number(pb[i]); if (d) { return Math.sign(d); } }
    const preA = a.includes('-'); const preB = b.includes('-');
    return preA === preB ? a.localeCompare(b) : preA ? -1 : 1;
}

export const latestVersion = (pkg: RegistryPackage): RegistryVersion | undefined => [...pkg.versions].sort((x, y) => compareVersions(y.version, x.version))[0];

/** The registry's packages that are well formed; the others are left out with the reason. */
export function parseRegistry(value: unknown): { packages: RegistryPackage[]; problems: string[] } {
    const problems: string[] = [];
    const list = (value as { packages?: unknown } | null)?.packages;
    if (!Array.isArray(list)) { return { packages: [], problems: ['the registry has no "packages" list'] }; }
    const packages: RegistryPackage[] = [];
    for (const raw of list as Array<Record<string, unknown>>) {
        const id = String(raw?.id ?? '');
        const publisher = raw?.publisher as { github?: unknown; verified?: unknown } | undefined;
        const versions = (Array.isArray(raw?.versions) ? raw.versions as Array<Record<string, unknown>> : []).filter(v =>
            SEMVER_RE.test(String(v?.version)) && /^[\w.-]+\/[\w.-]+$/.test(String(v?.repo)) && COMMIT_RE.test(String(v?.commit)) && HASH_RE.test(String(v?.hash)) && typeof v?.path === 'string' && !String(v.path).split('/').includes('..'));
        if (!ID_RE.test(id) || typeof publisher?.github !== 'string' || versions.length === 0) { problems.push(`${id || '(no id)'}: not a valid entry`); continue; }
        packages.push({ id, description: String(raw.description ?? '').slice(0, 300), publisher: { github: publisher.github, verified: publisher.verified === true },
            ...(typeof raw.homepage === 'string' ? { homepage: raw.homepage } : {}), ...(Array.isArray(raw.tags) ? { tags: (raw.tags as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 10) } : {}),
            ...(raw.contains && typeof raw.contains === 'object' ? { contains: raw.contains as RegistryPackage['contains'] } : {}),
            versions: versions as unknown as RegistryVersion[] });
    }
    return { packages, problems };
}

/**
 * A package comes from its publisher: the id's first part is the publisher's GitHub account,
 * and every version's repository belongs to it. Undefined when that holds.
 */
export function sourceProblem(pkg: RegistryPackage, version: RegistryVersion): string | undefined {
    const account = pkg.publisher.github.toLowerCase();
    if (pkg.id.split('/')[0] !== account) { return `the package id ${pkg.id} is not under its publisher's account (${pkg.publisher.github})`; }
    if (version.repo.split('/')[0].toLowerCase() !== account) { return `version ${version.version} comes from ${version.repo}, not from the publisher's account ${pkg.publisher.github}`; }
    return undefined;
}

/** Packages matching a search: every word in the id, description, tags or publisher. */
export function search(packages: RegistryPackage[], query: string): RegistryPackage[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return packages.filter(pkg => words.every(word => `${pkg.id} ${pkg.description} ${(pkg.tags ?? []).join(' ')} ${pkg.publisher.github}`.toLowerCase().includes(word)));
}

// ── The package itself ──────────────────────────────────────────────────────────

/** The manifest of a package's files, or what is wrong with it. */
export function readManifest(files: PackageFile[]): PackageManifest | { error: string } {
    const file = files.find(f => f.path === MANIFEST);
    if (!file) { return { error: `no ${MANIFEST} at the top of the package` }; }
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(file.data.toString('utf8')); } catch (error) { return { error: `${MANIFEST} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }; }
    const problems: string[] = [];
    if (!ID_RE.test(String(raw.id))) { problems.push('"id" must be publisher/name (lowercase letters, digits and dashes)'); }
    if (!SEMVER_RE.test(String(raw.version))) { problems.push('"version" must be like 1.2.3'); }
    if (typeof raw.description !== 'string' || !raw.description.trim()) { problems.push('"description" is required'); }
    const has = (p: string) => files.some(f => f.path === p || f.path.startsWith(`${p.replace(/\/$/, '')}/`));
    const strings = (key: string) => Array.isArray(raw[key]) ? (raw[key] as unknown[]).filter((v): v is string => typeof v === 'string') : [];
    for (const skill of strings('skills')) {
        if (!(skill.endsWith('.md') ? has(skill) : files.some(f => f.path === `${skill.replace(/\/$/, '')}/SKILL.md`))) { problems.push(`skill "${skill}" has no SKILL.md (or is not a .md file in the package)`); }
    }
    for (const agent of strings('agents')) { if (!agent.endsWith('.md') || !has(agent)) { problems.push(`agent "${agent}" is not a .md file in the package`); } }
    const servers = raw.mcpServers && typeof raw.mcpServers === 'object' ? raw.mcpServers as Record<string, Record<string, unknown>> : {};
    for (const [name, server] of Object.entries(servers)) {
        if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) { problems.push(`MCP server name "${name}" may only have letters, digits, - and _`); }
        if (typeof server?.command !== 'string' || !server.command.trim()) { problems.push(`MCP server "${name}" has no command`); }
        if (server?.args !== undefined && !(Array.isArray(server.args) && server.args.every(a => typeof a === 'string'))) { problems.push(`MCP server "${name}": "args" must be a list of strings`); }
    }
    const hooks = Array.isArray(raw.hooks) ? raw.hooks as Array<Record<string, unknown>> : [];
    for (const hook of hooks) {
        if (!HOOK_EVENTS.includes(String(hook?.event)) || typeof hook?.command !== 'string' || !hook.command.trim()) { problems.push(`a hook needs an event (${HOOK_EVENTS.join(', ')}) and a command`); }
    }
    if (problems.length) { return { error: problems.join('; ') }; }
    return {
        id: String(raw.id), version: String(raw.version), description: String(raw.description).trim().slice(0, 300),
        skills: strings('skills'), agents: strings('agents'),
        mcpServers: Object.fromEntries(Object.entries(servers).map(([name, s]) => [name, { command: String(s.command), ...(Array.isArray(s.args) ? { args: s.args as string[] } : {}),
            ...(s.env && typeof s.env === 'object' ? { env: Object.fromEntries(Object.entries(s.env as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])) } : {}) }])),
        hooks: hooks.map(h => ({ event: String(h.event), command: String(h.command), ...(typeof h.match === 'string' ? { match: h.match } : {}), ...(typeof h.name === 'string' ? { name: h.name } : {}) })),
        permissions: permissionsOf(raw.permissions),
    };
}

/** The declared permissions: lists of strings, anything else dropped. */
function permissionsOf(value: unknown): NonNullable<PackageManifest['permissions']> {
    const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const list = (key: string) => Array.isArray(raw[key]) ? (raw[key] as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim() !== '').map(v => v.trim()) : [];
    return { commands: list('commands'), network: list('network'), env: list('env') };
}

/** What installing writes: files under .codico (path relative to the project), MCP servers for .mcp.json, hooks for .codico/hooks.json. */
export interface InstallPlan {
    files: Array<{ path: string; data: Buffer; kind: 'skill' | 'agent' }>;
    skills: string[];
    agents: string[];
    mcpServers: Array<{ name: string; command: string; args: string[]; env?: Record<string, string> }>;
    hooks: PackageHook[];
}

const baseName = (p: string) => p.replace(/\/$/, '').split('/').pop()!.replace(/\.md$/, '');

/** Where each part of the package goes, or why it cannot be installed (a name another package or the project already uses). */
export function installPlan(manifest: PackageManifest, files: PackageFile[], taken: { skills: string[]; agents: string[]; mcpServers: string[] }): InstallPlan | { error: string } {
    const plan: InstallPlan = { files: [], skills: [], agents: [], mcpServers: [], hooks: manifest.hooks ?? [] };
    const problems: string[] = [];
    for (const skill of manifest.skills ?? []) {
        const name = baseName(skill);
        const problem = nameProblem('skill', name);
        if (problem) { problems.push(problem); continue; }
        if (taken.skills.includes(name)) { problems.push(`a skill named "${name}" exists already`); continue; }
        plan.skills.push(name);
        if (skill.endsWith('.md')) { plan.files.push({ path: `.codico/skills/${name}/SKILL.md`, data: files.find(f => f.path === skill)!.data, kind: 'skill' }); continue; }
        const folder = skill.replace(/\/$/, '');
        for (const file of files.filter(f => f.path.startsWith(`${folder}/`))) { plan.files.push({ path: `.codico/skills/${name}/${file.path.slice(folder.length + 1)}`, data: file.data, kind: 'skill' }); }
    }
    for (const agent of manifest.agents ?? []) {
        const name = baseName(agent);
        const problem = nameProblem('agent', name);
        if (problem) { problems.push(problem); continue; }
        if (taken.agents.includes(name)) { problems.push(`an agent named "${name}" exists already`); continue; }
        plan.agents.push(name);
        plan.files.push({ path: `.codico/agents/${name}.md`, data: files.find(f => f.path === agent)!.data, kind: 'agent' });
    }
    for (const [name, server] of Object.entries(manifest.mcpServers ?? {})) {
        if (taken.mcpServers.includes(name)) { problems.push(`an MCP server named "${name}" is configured already`); continue; }
        plan.mcpServers.push({ name, command: server.command, args: server.args ?? [], ...(server.env ? { env: server.env } : {}) });
    }
    return problems.length ? { error: problems.join('; ') } : plan;
}

/** A hook as the lock remembers it (to remove exactly that one later). */
export const hookKey = (hook: PackageHook) => `${hook.event}|${hook.match ?? ''}|${hook.command}`;

/** The lock file, read defensively. */
export function readLock(text: string | undefined): Lock {
    try {
        const value = JSON.parse(text ?? '');
        if (value && typeof value === 'object' && value.packages && typeof value.packages === 'object') { return value as Lock; }
    } catch { /* none yet */ }
    return { packages: {} };
}

/** Installed packages with a newer version in the registry. */
export function updates(lock: Lock, packages: RegistryPackage[]): Array<{ id: string; from: string; to: string }> {
    const found: Array<{ id: string; from: string; to: string }> = [];
    for (const [id, entry] of Object.entries(lock.packages)) {
        const latest = packages.find(pkg => pkg.id === id);
        const version = latest && latestVersion(latest);
        if (version && compareVersions(version.version, entry.version) > 0) { found.push({ id, from: entry.version, to: version.version }); }
    }
    return found;
}
