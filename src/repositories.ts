import * as fs from 'fs';
import * as path from 'path';

/**
 * Several repositories worked on together (a backend, a shared SDK, a frontend): what each
 * publishes and what it depends on, read from its manifests, and the order changes go in —
 * a dependency first. Nothing here touches git or the network.
 */

export interface RepositoryInfo {
    /** Its folder's name: how the agent and the user refer to it. */
    name: string;
    root: string;
    /** What it publishes (package names, Go modules) and what it uses. */
    provides: string[];
    uses: string[];
}

const readText = (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } };

/** Package names a repository publishes and uses: npm (package.json, and workspace packages one level down), Go (go.mod), Python (pyproject.toml). */
export function readManifests(root: string): { provides: string[]; uses: string[] } {
    const provides = new Set<string>(); const uses = new Set<string>();
    const npm = (file: string) => {
        try {
            const pkg = JSON.parse(readText(file) ?? '') as Record<string, unknown>;
            if (typeof pkg.name === 'string') { provides.add(pkg.name); }
            for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
                for (const dep of Object.keys((pkg[key] as Record<string, unknown>) ?? {})) { uses.add(dep); }
            }
        } catch { /* no package.json, or not JSON */ }
    };
    npm(path.join(root, 'package.json'));
    for (const folder of ['packages', 'apps', 'libs']) {
        let entries: string[] = [];
        try { entries = fs.readdirSync(path.join(root, folder)); } catch { continue; }
        for (const entry of entries.slice(0, 50)) { npm(path.join(root, folder, entry, 'package.json')); }
    }
    const goMod = readText(path.join(root, 'go.mod'));
    if (goMod) {
        const module = /^module\s+(\S+)/m.exec(goMod)?.[1];
        if (module) { provides.add(module); }
        for (const match of goMod.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+v[\d.]+/gim)) { uses.add(match[1]); }
    }
    const pyproject = readText(path.join(root, 'pyproject.toml'));
    if (pyproject) {
        const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1];
        if (name) { provides.add(name.toLowerCase().replace(/_/g, '-')); }
        const deps = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(pyproject)?.[1] ?? '';
        for (const match of deps.matchAll(/["']\s*([A-Za-z0-9_.-]+)/g)) { uses.add(match[1].toLowerCase().replace(/_/g, '-')); }
    }
    // A package does not depend on itself
    for (const name of provides) { uses.delete(name); }
    return { provides: [...provides], uses: [...uses] };
}

export interface DependencyOrder {
    /** Repository names, each after those it depends on. */
    order: string[];
    /** "frontend uses @acme/sdk (from sdk)". */
    edges: Array<{ from: string; to: string; via: string }>;
    /** Repositories that depend on each other in a circle, when some do: their order is as given. */
    cycle?: string[];
}

/** The order changes go in: a repository after every repository whose package it uses. */
export function dependencyOrder(repos: RepositoryInfo[]): DependencyOrder {
    const owner = new Map<string, string>();
    for (const repo of repos) { for (const name of repo.provides) { if (!owner.has(name)) { owner.set(name, repo.name); } } }
    const edges: DependencyOrder['edges'] = [];
    for (const repo of repos) {
        for (const use of repo.uses) {
            const from = owner.get(use);
            if (from && from !== repo.name && !edges.some(e => e.from === repo.name && e.to === from)) { edges.push({ from: repo.name, to: from, via: use }); }
        }
    }
    const order: string[] = []; const left = new Set(repos.map(r => r.name));
    while (left.size) {
        const ready = repos.map(r => r.name).filter(name => left.has(name) && !edges.some(e => e.from === name && left.has(e.to)));
        if (ready.length === 0) { return { order: [...order, ...repos.map(r => r.name).filter(n => left.has(n))], edges, cycle: [...left] }; }
        for (const name of ready) { order.push(name); left.delete(name); }
    }
    return { order, edges };
}

/** Distinct names for repositories whose folders share a name ("api", "api-2"). */
export function nameRepositories(roots: string[]): Array<{ name: string; root: string }> {
    const seen = new Map<string, number>();
    const unique = [...new Set(roots.map(root => path.resolve(root)))];
    return unique.map(root => {
        const base = path.basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'repo';
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        return { name: count === 1 ? base : `${base}-${count}`, root };
    });
}

/** The repositories, their order and why, for the orchestrator's prompt. */
export function repositoriesSection(repos: RepositoryInfo[], order: DependencyOrder): string {
    if (repos.length < 2) { return ''; }
    const why = order.edges.map(e => `${e.from} uses ${e.via} (from ${e.to})`);
    return `[Repositories]\nThis work spans ${repos.length} git repositories (start a worker in one with repo: <name>):\n${repos.map(r => `- ${r.name}: ${r.root}`).join('\n')}\n` +
        `Dependency order (a dependency first): ${order.order.join(' → ')}${why.length ? ` — because ${why.join('; ')}` : ' (no dependencies found between them)'}${order.cycle ? `. They depend on each other in a circle: ${order.cycle.join(', ')}; decide the order yourself.` : '.'}\n` +
        'Change a dependency (an SDK) before what uses it. Run the integrated tests with action "integrate" (all repositories side by side, with the workers\' branches merged in), then open linked pull requests with action "publish".';
}
