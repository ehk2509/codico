import * as vscode from 'vscode';
import * as cp from 'child_process';
import type { WorkspaceIndex, IndexChunk } from './workspaceIndex';
import { getGithubToken, _ghGet, _parseRepo } from './prContextProvider';

export type AgentName = 'workspace' | 'terminal' | 'vscode' | 'github';

export interface AgentContextOptions {
    /** The user's raw query — used for semantic search in @workspace. */
    query?: string;
    /** Workspace index instance — enables embedding-based retrieval. */
    index?: WorkspaceIndex;
    /** Extension context — required for @github to retrieve the stored token. */
    extensionContext?: vscode.ExtensionContext;
}

export interface AgentContext {
    /** Extra system prompt prefix injected for this agent. */
    systemPromptPrefix: string;
    /** Additional context block prepended to the user message. */
    contextBlock: string;
}

// ── @workspace ────────────────────────────────────────────────────────────────
const WORKSPACE_SYSTEM = `You are in @workspace mode.
Your job is to answer questions about the user's codebase.
You have access to all the file-reading, search, and directory-listing tools.
When asked about code, always look up the actual files first before answering.
Prefer search_files and find_files to locate relevant code, then read_file to inspect it.
Give precise, code-grounded answers with file paths and line references where relevant.
The [Semantic Search Results] block below shows the most relevant code chunks retrieved from the workspace index — use these as your primary starting point before reaching for other tools.`;

/** Format a set of retrieved chunks into a readable context block. */
function _formatChunks(chunks: IndexChunk[]): string {
    return chunks
        .map(c => `### ${c.file} (line ${c.startLine})\n\`\`\`\n${c.text.replace(/^\/\/.+?\n/, '')}\n\`\`\``)  // strip the header line we added
        .join('\n\n');
}

async function buildWorkspaceContext(opts?: AgentContextOptions): Promise<string> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return ''; }

    const root = folders[0].uri;
    const parts: string[] = [`[Workspace: ${root.fsPath}]`];

    // ── Semantic / keyword search via index ───────────────────────────────────
    const { query, index } = opts ?? {};
    if (index && index.isIndexed && query) {
        try {
            const chunks = await index.search(query, 10);
            if (chunks.length > 0) {
                const mode = index.status.hasVectors ? 'Semantic Search Results' : 'Keyword Search Results';
                parts.push(`[${mode} for: "${query.slice(0, 120)}"\n${_formatChunks(chunks)}]`);
            }
        } catch { /* search failed — fall through to file tree */ }
    }

    // ── File tree (structural overview) ──────────────────────────────────────
    try {
        const topEntries = await vscode.workspace.fs.readDirectory(root);
        const lines: string[] = [];
        for (const [name, type] of topEntries.sort((a, b) => a[0].localeCompare(b[0]))) {
            if (name.startsWith('.') || name === 'node_modules' || name === 'out' || name === 'dist') { continue; }
            if (type === vscode.FileType.Directory) {
                lines.push(`  ${name}/`);
                try {
                    const sub = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, name));
                    for (const [sname] of sub.slice(0, 12)) {
                        lines.push(`    ${sname}`);
                    }
                    if (sub.length > 12) { lines.push(`    … (${sub.length - 12} more)`); }
                } catch { /* skip */ }
            } else {
                lines.push(`  ${name}`);
            }
        }
        parts.push('File tree:\n' + lines.join('\n'));
    } catch { /* skip */ }

    // ── Active file ───────────────────────────────────────────────────────────
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const rel = vscode.workspace.asRelativePath(editor.document.uri);
        const doc = editor.document;
        const endPos = doc.positionAt(6000);
        const content = doc.getText(new vscode.Range(new vscode.Position(0, 0), endPos));
        const isTruncated = content.length >= 6000;
        parts.push(`Active file (${rel}):\n\`\`\`${doc.languageId}\n${content}${isTruncated ? '\n… (truncated)' : ''}\n\`\`\``);
    }

    // ── Index status hint ─────────────────────────────────────────────────────
    if (index && !index.isIndexed) {
        parts.push('[Workspace index not built yet — run "Codico: Index Workspace" to enable semantic search]');
    }

    return parts.join('\n\n');
}

// ── @terminal ────────────────────────────────────────────────────────────────
const TERMINAL_SYSTEM = `You are in @terminal mode.
Your job is to help with shell commands, scripts, build tools, package managers, and terminal output.
When asked to run something, use the run_terminal tool.
When explaining errors from terminal output, be specific about the cause and the fix.
Always prefer safe, idempotent commands. Warn the user before any destructive operation (rm, drop, truncate, etc.).
Know the user's OS: Linux.`;

async function buildTerminalContext(): Promise<string> {
    const parts: string[] = [];
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return ''; }

    const cwd = folders[0].uri.fsPath;
    parts.push(`[Working directory: ${cwd}]`);

    // Show package.json scripts if present
    try {
        const pkgUri = vscode.Uri.joinPath(folders[0].uri, 'package.json');
        const bytes = await vscode.workspace.fs.readFile(pkgUri);
        const pkg = JSON.parse(new TextDecoder().decode(bytes));
        if (pkg.scripts && typeof pkg.scripts === 'object') {
            const scripts = Object.entries(pkg.scripts as Record<string, string>)
                .slice(0, 15)
                .map(([k, v]) => `  ${k}: ${v}`)
                .join('\n');
            parts.push(`npm scripts:\n${scripts}`);
        }
    } catch { /* no package.json */ }

    // Run `git status` to give branch/dirty context
    await new Promise<void>((resolve) => {
        cp.execFile('git', ['status', '--short', '--branch'], { cwd, timeout: 3000 }, (err, stdout) => {
            if (!err && stdout.trim()) { parts.push(`git status:\n${stdout.trim()}`); }
            resolve();
        });
    });

    return parts.join('\n\n');
}

// ── @vscode ───────────────────────────────────────────────────────────────────
const VSCODE_SYSTEM = `You are in @vscode mode.
Your job is to help with everything VS Code: settings, keybindings, extensions, the Extension API, debugging, tasks, launch configurations, and workspace configuration.
When answering:
- Reference the exact setting ID (e.g. "editor.formatOnSave"), command palette name, or API namespace.
- For extension development, use the vscode API correctly and cite the namespace (e.g. vscode.window, vscode.workspace, vscode.languages).
- When the user asks about a setting, show the full JSON snippet they should add to settings.json.
- When the user asks about a task or launch config, provide the complete JSON block.
- Mention which VS Code version introduced a feature when relevant.
You have been given the user's actual workspace configuration files as context — use them to give precise, project-specific answers.`;

async function buildVscodeContext(opts?: AgentContextOptions): Promise<string> {
    const parts: string[] = [];
    const folders = vscode.workspace.workspaceFolders;
    const root = folders?.[0]?.uri;

    // VS Code version
    parts.push(`VS Code version: ${vscode.version}`);

    // ── Active (non-built-in) extensions ─────────────────────────────────────
    const exts = vscode.extensions.all
        .filter(e => !e.id.startsWith('vscode.') && e.isActive)
        .slice(0, 25)
        .map(e => `  ${e.id} v${e.packageJSON?.version ?? '?'}`)
        .join('\n');
    if (exts) { parts.push(`Active third-party extensions:\n${exts}`); }

    // ── Read .vscode/ workspace config files ─────────────────────────────────
    if (root) {
        const vscodeDir = vscode.Uri.joinPath(root, '.vscode');
        const configFiles = [
            { name: 'settings.json',     uri: vscode.Uri.joinPath(vscodeDir, 'settings.json') },
            { name: 'tasks.json',        uri: vscode.Uri.joinPath(vscodeDir, 'tasks.json') },
            { name: 'launch.json',       uri: vscode.Uri.joinPath(vscodeDir, 'launch.json') },
            { name: 'extensions.json',   uri: vscode.Uri.joinPath(vscodeDir, 'extensions.json') },
            { name: 'keybindings.json',  uri: vscode.Uri.joinPath(vscodeDir, 'keybindings.json') },
        ];
        for (const { name, uri } of configFiles) {
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                const text = new TextDecoder().decode(bytes).trim();
                if (text) { parts.push(`.vscode/${name}:\n\`\`\`json\n${text.slice(0, 2000)}${text.length > 2000 ? '\n// … (truncated)' : ''}\n\`\`\``); }
            } catch { /* file doesn't exist */ }
        }
    }

    // ── Effective workspace configuration (all non-default overrides) ─────────
    const cfg = vscode.workspace.getConfiguration();
    const interestingKeys = [
        'editor.tabSize', 'editor.insertSpaces', 'editor.formatOnSave',
        'editor.defaultFormatter', 'editor.rulers', 'editor.wordWrap',
        'editor.codeActionsOnSave', 'files.eol', 'files.exclude',
        'typescript.tsdk', 'typescript.preferences.importModuleSpecifier',
        'eslint.enable', 'eslint.validate',
        'git.autofetch', 'git.confirmSync',
        'debug.internalConsoleOptions',
        'terminal.integrated.shell.linux', 'terminal.integrated.defaultProfile.linux',
    ];
    const settingLines = interestingKeys
        .map(k => `  "${k}": ${JSON.stringify(cfg.get(k))}`)
        .filter(l => !l.endsWith('undefined') && !l.endsWith('null'))
        .join('\n');
    if (settingLines) { parts.push(`Resolved settings (workspace + user):\n${settingLines}`); }

    // ── Installed extension package.json for the current workspace extension ──
    // If workspace is a VS Code extension project, show its contributes/activationEvents
    if (root) {
        try {
            const pkgUri = vscode.Uri.joinPath(root, 'package.json');
            const bytes = await vscode.workspace.fs.readFile(pkgUri);
            const pkg = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
            if (pkg && typeof pkg === 'object' && pkg['engines'] && typeof pkg['engines'] === 'object' && pkg['engines'] !== null && 'vscode' in pkg['engines']) {
                // This is a VS Code extension project
                const summary = {
                    name: pkg['name'],
                    displayName: pkg['displayName'],
                    version: pkg['version'],
                    engines: pkg['engines'],
                    activationEvents: pkg['activationEvents'],
                    contributes: pkg['contributes'],
                    main: pkg['main'],
                };
                parts.push(`Extension manifest (package.json):\n\`\`\`json\n${JSON.stringify(summary, null, 2).slice(0, 3000)}\n\`\`\``);
            }
        } catch { /* not an extension project or no package.json */ }
    }

    // ── Hint about query ──────────────────────────────────────────────────────
    if (opts?.query) {
        parts.push(`[User is asking about: "${opts.query.slice(0, 200)}"]`);
    }

    return parts.join('\n\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

// ── @github ───────────────────────────────────────────────────────────────────
const GITHUB_SYSTEM = `You are in @github mode.
Your job is to help the user with GitHub: searching issues, pull requests, repositories, and understanding GitHub workflows.
You have been given GitHub search results below as context.
When answering, reference specific issue/PR numbers, titles, and URLs from the context.
If the user asks about something not in the context, say so and suggest refining the query.
You can also discuss GitHub Actions, branch strategies, labels, milestones, and project management.`;

async function buildGithubContext(opts?: AgentContextOptions): Promise<string> {
    const query = opts?.query ?? '';
    const extCtx = opts?.extensionContext;

    const token = extCtx ? await getGithubToken(extCtx) : process.env['GITHUB_TOKEN'];
    if (!token) {
        return '[GitHub] No token available. Run "Codico: Set GitHub Token" to enable GitHub search.';
    }

    const parts: string[] = [];

    // Detect current repo for scoped searches
    const folders = vscode.workspace.workspaceFolders;
    let repoScope: { owner: string; repo: string } | null = null;
    if (folders && folders.length > 0) {
        const cwd = folders[0].uri.fsPath;
        const remote = await new Promise<string>(resolve => {
            cp.exec('git remote get-url origin', { cwd, timeout: 3000 }, (e, s) => resolve(e ? '' : s.trim()));
        });
        if (remote) { repoScope = _parseRepo(remote); }
    }

    if (repoScope) {
        parts.push(`[Current repo: ${repoScope.owner}/${repoScope.repo}]`);
    }

    if (!query.trim()) {
        // No query — return repo overview: open issues + PRs count
        if (repoScope) {
            try {
                const [issuesRes, prsRes] = await Promise.all([
                    _ghGet(`/repos/${repoScope.owner}/${repoScope.repo}/issues?state=open&per_page=10&sort=updated`, token),
                    _ghGet(`/repos/${repoScope.owner}/${repoScope.repo}/pulls?state=open&per_page=5&sort=updated`, token),
                ]);
                const issues = (issuesRes as Array<{ number: number; title: string; html_url: string; labels: Array<{ name: string }>; user: { login: string }; created_at: string }>)
                    .filter(i => !(i as unknown as { pull_request?: unknown }).pull_request); // exclude PRs from issues endpoint
                const prs = prsRes as Array<{ number: number; title: string; html_url: string; user: { login: string }; created_at: string }>;

                if (issues.length > 0) {
                    parts.push(`Open issues (${issues.length} shown):\n` + issues.map(i =>
                        `  #${i.number} ${i.title}${i.labels.length ? ' [' + i.labels.map(l => l.name).join(', ') + ']' : ''}\n  by ${i.user.login} — ${i.html_url}`
                    ).join('\n'));
                }
                if (prs.length > 0) {
                    parts.push(`Open pull requests (${prs.length} shown):\n` + prs.map(p =>
                        `  #${p.number} ${p.title}\n  by ${p.user.login} — ${p.html_url}`
                    ).join('\n'));
                }
            } catch { parts.push('[GitHub] Could not fetch repo overview.'); }
        }
        return parts.join('\n\n') || '[GitHub] No query provided and no repo detected.';
    }

    // Build search queries: scoped to repo if available, plus global
    const repoQualifier = repoScope ? `repo:${repoScope.owner}/${repoScope.repo} ` : '';
    const encodedQuery = encodeURIComponent(repoQualifier + query);
    const globalQuery  = encodeURIComponent(query);

    // Search issues (includes PRs)
    try {
        const res = await _ghGet(`/search/issues?q=${encodedQuery}&per_page=8&sort=updated`, token) as {
            total_count: number;
            items: Array<{ number: number; title: string; html_url: string; state: string; body: string | null; user: { login: string }; labels: Array<{ name: string }>; created_at: string; pull_request?: unknown }>;
        };
        if (res.items && res.items.length > 0) {
            const label = repoScope ? `Issue/PR search in ${repoScope.owner}/${repoScope.repo}` : 'Issue/PR search';
            parts.push(`[${label} — ${res.total_count} total results, showing ${res.items.length}]\n` +
                res.items.map(i =>
                    `  #${i.number} [${i.pull_request ? 'PR' : 'issue'}][${i.state}] ${i.title}\n` +
                    `  by ${i.user.login}${i.labels.length ? ' | ' + i.labels.map(l => l.name).join(', ') : ''}\n` +
                    `  ${i.html_url}` +
                    (i.body ? `\n  > ${i.body.slice(0, 200).replace(/\n/g, ' ')}` : '')
                ).join('\n\n')
            );
        } else {
            parts.push(`[No issues/PRs found for: "${query}"${repoScope ? ` in ${repoScope.owner}/${repoScope.repo}` : ''}]`);
        }
    } catch { parts.push('[GitHub] Issue search failed.'); }

    // Repository search (global, only if no repo scope or query looks like a repo name)
    if (!repoScope || /^[\w.-]+\/[\w.-]+$/.test(query.trim())) {
        try {
            const res = await _ghGet(`/search/repositories?q=${globalQuery}&per_page=5&sort=updated`, token) as {
                items: Array<{ full_name: string; description: string | null; html_url: string; stargazers_count: number; language: string | null; open_issues_count: number }>;
            };
            if (res.items && res.items.length > 0) {
                parts.push(`[Repository search — top ${res.items.length} results]\n` +
                    res.items.map(r =>
                        `  ${r.full_name}${r.language ? ` (${r.language})` : ''} ⭐ ${r.stargazers_count}\n` +
                        `  ${r.html_url}` +
                        (r.description ? `\n  ${r.description.slice(0, 150)}` : '')
                    ).join('\n\n')
                );
            }
        } catch { /* skip repo search on error */ }
    }

    return parts.join('\n\n') || '[GitHub] No results found.';
}

const AGENT_DEFS: Record<AgentName, {
    system: string;
    description: string;
    buildContext: (opts?: AgentContextOptions) => Promise<string>;
}> = {
    workspace: { system: WORKSPACE_SYSTEM, description: 'Answer questions about the codebase', buildContext: buildWorkspaceContext },
    terminal:  { system: TERMINAL_SYSTEM,  description: 'Help with shell commands and terminal output', buildContext: () => buildTerminalContext() },
    vscode:    { system: VSCODE_SYSTEM,    description: 'Help with VS Code settings, API, and extensions', buildContext: (opts) => buildVscodeContext(opts) },
    github:    { system: GITHUB_SYSTEM,    description: 'Search GitHub issues, PRs, and repositories', buildContext: buildGithubContext },
};

/**
 * Parse `@agentName` from the start (or anywhere) of a message.
 * Returns the agent name if found, plus the message with the @mention stripped.
 */
export function parseAgentMention(text: string): { agent: AgentName | null; strippedText: string } {
    const match = text.match(/(?:^|\s)@(workspace|terminal|vscode|github)\b/i);
    if (!match) { return { agent: null, strippedText: text }; }
    const agent = match[1].toLowerCase() as AgentName;
    const strippedText = text.replace(match[0], ' ').replace(/^\s+/, '').trim();
    return { agent, strippedText };
}

/**
 * Build the full AgentContext (system prefix + context block) for the given agent.
 * Pass `opts.query` and `opts.index` to enable semantic retrieval for @workspace.
 */
export async function buildAgentContext(agent: AgentName, opts?: AgentContextOptions): Promise<AgentContext> {
    const def = AGENT_DEFS[agent];
    const contextBlock = await def.buildContext(opts);
    return {
        systemPromptPrefix: def.system,
        contextBlock,
    };
}

/** Metadata for the UI (name → description). */
export const AGENT_DESCRIPTIONS: Record<AgentName, string> = Object.fromEntries(
    Object.entries(AGENT_DEFS).map(([k, v]) => [k, v.description])
) as Record<AgentName, string>;
