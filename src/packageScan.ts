import { PackageFile } from './packageArchive';
import { PackageManifest } from './marketplace';

/**
 * The security scan of a package, before it is installed: it reads every file and the
 * manifest, runs nothing, and says what deserves a look — commands fetched and run from the
 * internet, reads of keys and credentials, instructions written to steer the agent against the
 * user, hidden code, binaries — and whether what the package does matches what it declared.
 * A scan cannot prove a package safe; it shows the user what to look at before saying yes.
 */

export type Severity = 'danger' | 'warning' | 'info';
export interface Finding { severity: Severity; file: string; line?: number; rule: string; text: string }

interface Rule { id: string; severity: Severity; re: RegExp; what: string; in: 'any' | 'text' | 'command' }

const RULES: Rule[] = [
    { id: 'pipe-to-shell', severity: 'danger', in: 'any', re: /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\b(?:iex|Invoke-Expression)\b/i, what: 'downloads something and runs it' },
    { id: 'credentials', severity: 'danger', in: 'any', re: /~\/\.ssh|\bid_(?:rsa|ed25519|ecdsa)\b|\.aws\/credentials|\.npmrc\b|\.netrc\b|\.docker\/config\.json|\/etc\/shadow|Login Data|keychain|\.git-credentials/i, what: 'touches keys or credentials' },
    { id: 'env-dump', severity: 'danger', in: 'any', re: /\bprintenv\b|\benv\s*\|\s*(?:curl|nc|base64)|JSON\.stringify\(\s*process\.env\s*\)|os\.environ\b(?!\s*\.get\(\s*['"][A-Z_]+['"])/, what: 'reads all environment variables (where keys are kept)' },
    { id: 'steering', severity: 'danger', in: 'text', re: /\b(?:ignore|disregard|forget)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|system)\b[^.\n]{0,20}\b(?:instructions|prompt|rules)\b|\b(?:do not|don't|never)\b[^.\n]{0,30}\b(?:tell|inform|show|mention|ask)\b[^.\n]{0,15}\bthe user\b|\bwithout (?:asking|telling|informing) the user\b|\b(?:approve|allow) all\b|\bcodico\.\w*(?:allow|sandbox|permission)/i, what: 'tries to steer the agent against the user or around its approvals' },
    { id: 'hidden-code', severity: 'danger', in: 'any', re: /\beval\s*\(|\bnew Function\s*\(|\bexec\s*\(\s*(?:atob|Buffer\.from|base64)|base64\s+(?:-d|--decode)\s*\|/, what: 'runs code built at run time' },
    { id: 'encoded-blob', severity: 'warning', in: 'any', re: /[A-Za-z0-9+/]{240,}={0,2}/, what: 'contains a long encoded blob' },
    { id: 'invisible-text', severity: 'warning', in: 'text', re: /[​-‏‪-‮⁠-⁤﻿](?!$)/, what: 'contains invisible characters (text that reads differently than it shows)' },
    { id: 'destructive', severity: 'warning', in: 'any', re: /\brm\s+-[a-z]*r[a-z]*f?\s+(?:\/|~|\$HOME|\*)|\bgit\s+push\s+(?:-f|--force)\b|\bmkfs\b|\bdd\s+if=/i, what: 'can delete or overwrite a lot' },
];

const BINARY_EXT = /\.(?:exe|dll|so|dylib|bin|node|wasm|jar|class|pyc|com|msi|dmg|app|scr)$/i;
const URL_RE = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi;
/** Hosts that are only documentation or package homes: not a sign of network use. */
const QUIET_HOSTS = /(?:^|\.)(?:github\.com|githubusercontent\.com|npmjs\.(?:com|org)|pypi\.org|example\.(?:com|org)|w3\.org|schema\.org|json-schema\.org|mozilla\.org|wikipedia\.org)$/;

const isText = (data: Buffer) => !data.subarray(0, 8000).includes(0);

/** Every command the package would have run: its MCP servers and its hooks. */
export function packageCommands(manifest: PackageManifest): Array<{ where: string; line: string }> {
    return [
        ...Object.entries(manifest.mcpServers ?? {}).map(([name, s]) => ({ where: `MCP server ${name}`, line: [s.command, ...(s.args ?? [])].join(' ') })),
        ...(manifest.hooks ?? []).map(h => ({ where: `hook ${h.name ?? h.event}`, line: h.command })),
    ];
}

/** An MCP server started through a package runner without a fixed version: what runs can change after review. */
function unpinned(command: string, args: string[]): string | undefined {
    const runner = /(?:^|\/)(npx|pnpx|bunx|uvx|pipx)$/.exec(command)?.[1] ?? (command === 'pnpm' && args[0] === 'dlx' ? 'pnpm dlx' : undefined);
    if (!runner) { return undefined; }
    const spec = args.find(a => !a.startsWith('-') && a !== 'dlx' && a !== 'run');
    if (!spec) { return undefined; }
    const pinned = /^(?:@[^/]+\/)?[^@]+@\d+\.\d+\.\d+/.test(spec) || /==\d/.test(spec);
    return pinned ? undefined : spec;
}

export interface ScanResult { findings: Finding[]; risk: 'high' | 'medium' | 'low'; network: string[] }

export function scanPackage(manifest: PackageManifest, files: PackageFile[]): ScanResult {
    const findings: Finding[] = [];
    const hosts = new Set<string>();
    for (const file of files) {
        if (BINARY_EXT.test(file.path) || !isText(file.data)) { findings.push({ severity: 'danger', file: file.path, rule: 'binary', text: 'a program or binary file: it cannot be read before it runs' }); continue; }
        const text = file.data.toString('utf8');
        const isProse = /\.(?:md|txt)$/i.test(file.path);
        const lines = text.split('\n');
        for (const rule of RULES) {
            if (rule.in === 'text' && !isProse) { continue; }
            const at = lines.findIndex(line => rule.re.test(line));
            if (at >= 0) { findings.push({ severity: rule.severity, file: file.path, line: at + 1, rule: rule.id, text: `${rule.what}: ${lines[at].trim().slice(0, 160)}` }); }
        }
        for (const match of text.matchAll(URL_RE)) { if (!QUIET_HOSTS.test(match[1].toLowerCase())) { hosts.add(match[1].toLowerCase()); } }
    }
    // The commands it would run, checked like its files, and against what it declared
    const declared = manifest.permissions ?? {};
    for (const { where, line } of packageCommands(manifest)) {
        for (const rule of RULES.filter(r => r.in !== 'text')) {
            if (rule.re.test(line)) { findings.push({ severity: rule.severity, file: where, rule: rule.id, text: `${rule.what}: ${line.slice(0, 160)}` }); }
        }
        if (/^(?:sh|bash|zsh|cmd|powershell|pwsh)(?:\.exe)?\b.*\s(?:-c|\/c|-Command)\b/i.test(line)) { findings.push({ severity: 'warning', file: where, rule: 'shell', text: `runs a shell command line: ${line.slice(0, 160)}` }); }
        const program = line.trim().split(/\s+/)[0];
        if (!(declared.commands ?? []).some(c => line.startsWith(c) || c === program)) { findings.push({ severity: 'warning', file: where, rule: 'undeclared-command', text: `runs "${program}", which its permissions do not declare` }); }
        for (const match of line.matchAll(URL_RE)) { hosts.add(match[1].toLowerCase()); }
    }
    for (const [name, server] of Object.entries(manifest.mcpServers ?? {})) {
        const spec = unpinned(server.command, server.args ?? []);
        if (spec) { findings.push({ severity: 'warning', file: `MCP server ${name}`, rule: 'unpinned', text: `starts "${spec}" without a fixed version: what runs can change after this review` }); }
        for (const [key, value] of Object.entries(server.env ?? {})) {
            if (value && /(?:key|token|secret|password)/i.test(key)) { findings.push({ severity: 'warning', file: `MCP server ${name}`, rule: 'bundled-secret', text: `ships a value for ${key}; you should set your own` }); }
        }
    }
    for (const hook of manifest.hooks ?? []) { findings.push({ severity: 'info', file: `hook ${hook.name ?? hook.event}`, rule: 'hook', text: `runs "${hook.command}" ${hook.event === 'beforeEdit' || hook.event === 'beforeCommand' ? 'before' : 'after'} ${/Edit$/.test(hook.event) ? 'file edits' : 'commands'}${hook.match ? ` matching ${hook.match}` : ''} (asked once before it first runs)` }); }
    const allowed = (declared.network ?? []).map(h => h.toLowerCase());
    const network = [...hosts].sort();
    const undeclared = network.filter(host => !allowed.some(a => host === a || host.endsWith(`.${a}`)));
    if (undeclared.length) { findings.push({ severity: 'warning', file: '(package)', rule: 'undeclared-network', text: `mentions addresses its permissions do not declare: ${undeclared.slice(0, 8).join(', ')}` }); }
    const order: Record<Severity, number> = { danger: 0, warning: 1, info: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity]);
    return { findings, risk: findings.some(f => f.severity === 'danger') ? 'high' : findings.some(f => f.severity === 'warning') ? 'medium' : 'low', network };
}
