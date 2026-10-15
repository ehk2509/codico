import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import { latestVersion, Lock, parseRegistry, RegistryPackage, updates } from './marketplace';
import { installSummary, MarketplaceInstaller, Prepared } from './marketplaceInstaller';

export const DEFAULT_REGISTRY = 'https://raw.githubusercontent.com/ehk2509/codico-registry/main/index.json';
const MAX_DOWNLOAD = 50 * 1024 * 1024;
const REGISTRY_TTL_MS = 10 * 60 * 1000;

/** A GET that follows a few redirects and stops at 50 MB. */
export function download(url: string, hops = 4): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname))) { reject(new Error(`only https addresses are used (${url})`)); return; }
        const request = (target.protocol === 'https:' ? https : http).get(target, { timeout: 30_000, headers: { 'User-Agent': 'Codico' } }, response => {
            const status = response.statusCode ?? 0;
            if (status >= 300 && status < 400 && response.headers.location && hops > 0) { response.resume(); resolve(download(new URL(response.headers.location, target).toString(), hops - 1)); return; }
            if (status !== 200) { response.resume(); reject(new Error(`HTTP ${status} from ${target.host}`)); return; }
            const chunks: Buffer[] = []; let size = 0;
            response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_DOWNLOAD) { request.destroy(new Error('the download is too large')); } else { chunks.push(chunk); } });
            response.on('end', () => resolve(Buffer.concat(chunks)));
            response.on('error', reject);
        });
        request.on('timeout', () => request.destroy(new Error(`${target.host} did not answer in time`)));
        request.on('error', reject);
    });
}

/**
 * "Codico: Marketplace": the registry's packages, searchable; install, update and uninstall
 * them in this project, each after a look at what it adds, what it may do and what the scan found.
 */
export class MarketplaceService {
    private _registry: { at: number; url: string; packages: RegistryPackage[] } | undefined;

    /** @param _archiveUrl where commits are downloaded from (a stand-in in tests) */
    constructor(private readonly _afterChange: (mcpChanged: boolean) => Promise<void>, private readonly _archiveUrl?: (repo: string, commit: string) => string) {}

    private _installer(): MarketplaceInstaller | undefined {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { return undefined; }
        return new MarketplaceInstaller({ root, fetchJson: async url => JSON.parse((await download(url)).toString('utf8')), fetchBuffer: download, archiveUrl: this._archiveUrl });
    }

    /** The registry's packages (kept for ten minutes). */
    async packages(fresh = false): Promise<RegistryPackage[]> {
        const url = vscode.workspace.getConfiguration('codico').get<string>('marketplaceRegistry', DEFAULT_REGISTRY).trim() || DEFAULT_REGISTRY;
        if (!fresh && this._registry && this._registry.url === url && Date.now() - this._registry.at < REGISTRY_TTL_MS) { return this._registry.packages; }
        const { packages } = parseRegistry(JSON.parse((await download(url)).toString('utf8')));
        this._registry = { at: Date.now(), url, packages };
        return packages;
    }

    /** The command: the list, then what to do with the chosen package. */
    async open(): Promise<void> {
        const installer = this._installer();
        if (!installer) { void vscode.window.showWarningMessage('Codico: open a folder first; packages are installed into a project.'); return; }
        let packages: RegistryPackage[];
        try { packages = await this.packages(); } catch (error) {
            void vscode.window.showErrorMessage(`Codico: the marketplace could not be read: ${error instanceof Error ? error.message : String(error)}. (codico.marketplaceRegistry)`);
            return;
        }
        const lock = installer.lock();
        const pending = updates(lock, packages);
        type Item = vscode.QuickPickItem & { pkg?: RegistryPackage; action?: 'updates' };
        const contains = (pkg: RegistryPackage) => Object.entries(pkg.contains ?? {}).filter(([, n]) => n).map(([k, n]) => `${n} ${{ skills: 'skill', agents: 'agent', mcpServers: 'MCP server', hooks: 'hook' }[k] ?? k}${n === 1 ? '' : 's'}`).join(', ');
        const items: Item[] = [
            ...(pending.length ? [{ label: `$(arrow-up) Update ${pending.length} installed package${pending.length === 1 ? '' : 's'}`, description: pending.map(u => `${u.id} ${u.from} → ${u.to}`).join(', '), action: 'updates' as const }] : []),
            ...packages.map((pkg): Item => {
                const installed = lock.packages[pkg.id];
                const latest = latestVersion(pkg)!;
                return {
                    pkg, label: `${pkg.publisher.verified ? '$(verified-filled) ' : ''}${pkg.id}`,
                    description: `${latest.version}${installed ? ` · installed ${installed.version}` : ''}${contains(pkg) ? ` · ${contains(pkg)}` : ''}`,
                    detail: `${pkg.description}${pkg.tags?.length ? `  [${pkg.tags.join(', ')}]` : ''}`,
                };
            }),
        ];
        const pick = await vscode.window.showQuickPick(items, { title: `Codico marketplace — ${packages.length} package${packages.length === 1 ? '' : 's'}`, placeHolder: 'Search skills, agents, MCP servers and hooks', matchOnDescription: true, matchOnDetail: true });
        if (!pick) { return; }
        if (pick.action === 'updates') { for (const update of pending) { const pkg = packages.find(p => p.id === update.id); if (pkg) { await this.install(pkg); } } return; }
        if (pick.pkg) { await this._actions(pick.pkg, lock); }
    }

    private async _actions(pkg: RegistryPackage, lock: Lock): Promise<void> {
        const installed = lock.packages[pkg.id];
        const latest = latestVersion(pkg)!;
        const choices = [
            ...(!installed ? [{ id: 'install', label: `$(cloud-download) Install ${latest.version}`, description: 'shows what it adds and what the scan found first' }] : []),
            ...(installed && installed.version !== latest.version ? [{ id: 'install', label: `$(arrow-up) Update ${installed.version} → ${latest.version}` }] : []),
            ...(installed ? [{ id: 'uninstall', label: '$(trash) Uninstall', description: 'removes what it added; files you changed are kept' }] : []),
            ...(pkg.homepage ? [{ id: 'home', label: '$(link-external) Open its page' }] : []),
            { id: 'source', label: '$(github) Open its source on GitHub', description: `${latest.repo}@${latest.commit.slice(0, 7)}` },
        ];
        const action = await vscode.window.showQuickPick(choices, { title: `${pkg.id} — ${pkg.publisher.verified ? 'verified publisher' : 'publisher not verified'}` });
        if (action?.id === 'install') { await this.install(pkg); }
        if (action?.id === 'uninstall') { await this.uninstall(pkg.id); }
        if (action?.id === 'home' && pkg.homepage) { void vscode.env.openExternal(vscode.Uri.parse(pkg.homepage)); }
        if (action?.id === 'source') { void vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${latest.repo}/tree/${latest.commit}/${latest.path}`)); }
    }

    /** Installs (or updates to) the latest version, after the user has seen the summary and said yes. */
    async install(pkg: RegistryPackage, confirm: (prepared: Prepared) => Promise<boolean> = prepared => this._confirm(prepared)): Promise<string> {
        const installer = this._installer();
        if (!installer) { return 'no folder open'; }
        const prepared = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Codico: checking ${pkg.id}…` }, () => installer.prepare(pkg, latestVersion(pkg)!));
        if ('error' in prepared) { void vscode.window.showErrorMessage(`Codico: ${pkg.id} was not installed: ${prepared.error}`); return prepared.error; }
        if (prepared.sourceProblem) { void vscode.window.showErrorMessage(`Codico: ${pkg.id} was not installed: ${prepared.sourceProblem}.`); return prepared.sourceProblem; }
        if (!await confirm(prepared)) { return 'not installed'; }
        try {
            const { kept } = installer.install(prepared);
            await this._afterChange(prepared.plan.mcpServers.length > 0);
            const skills = prepared.plan.skills.map(s => `/${s}`); const agents = prepared.plan.agents.map(a => `@${a}`);
            void vscode.window.showInformationMessage(`Codico: installed ${pkg.id} ${prepared.version.version}.${[...skills, ...agents].length ? ` Use ${[...skills, ...agents].join(', ')} in the chat.` : ''}${kept.length ? ` Kept your changed files: ${kept.join(', ')}.` : ''}`);
            return 'installed';
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Codico: ${pkg.id} could not be installed: ${message}`);
            return message;
        }
    }

    private async _confirm(prepared: Prepared): Promise<boolean> {
        const detail = installSummary(prepared);
        const risky = prepared.scan.risk === 'high';
        const answer = await vscode.window.showWarningMessage(`${risky ? 'The security scan found dangerous patterns in ' : 'Install '}${prepared.pkg.id} ${prepared.version.version}${risky ? '.' : ' into this project?'}`,
            { modal: true, detail }, risky ? 'Install Anyway' : 'Install');
        return answer === 'Install' || answer === 'Install Anyway';
    }

    async uninstall(id: string): Promise<void> {
        const installer = this._installer();
        if (!installer) { return; }
        const entry = installer.lock().packages[id];
        if (!entry) { return; }
        const go = await vscode.window.showWarningMessage(`Uninstall ${id} ${entry.version}?`, { modal: true, detail: `It removes the ${entry.files.length} file${entry.files.length === 1 ? '' : 's'} it added${entry.mcpServers.length ? `, its MCP server${entry.mcpServers.length === 1 ? '' : 's'} (${entry.mcpServers.join(', ')})` : ''}${entry.hooks.length ? ` and its ${entry.hooks.length} hook${entry.hooks.length === 1 ? '' : 's'}` : ''}. Files you have changed since are kept.` }, 'Uninstall');
        if (go !== 'Uninstall') { return; }
        const { kept } = installer.uninstall(id);
        await this._afterChange(entry.mcpServers.length > 0);
        void vscode.window.showInformationMessage(`Codico: uninstalled ${id}.${kept.length ? ` Kept because you changed them: ${kept.join(', ')}.` : ''}`);
    }

    /** Automated tests: install without the dialog, uninstall, or read the lock. */
    async evaluation(action: 'install' | 'uninstall' | 'lock', id?: string): Promise<unknown> {
        if (action === 'install') { const pkg = (await this.packages(true)).find(p => p.id === id); return pkg ? this.install(pkg, async () => true) : 'no such package'; }
        const installer = this._installer();
        if (action === 'uninstall' && installer && id) { const { kept } = installer.uninstall(id); await this._afterChange(true); return kept; }
        return installer?.lock();
    }

    /** Once a day at most: tells the user when installed packages have updates. */
    async checkUpdates(state: vscode.Memento): Promise<void> {
        const installer = this._installer();
        if (!installer || Object.keys(installer.lock().packages).length === 0) { return; }
        const last = state.get<number>('codico.marketplaceChecked', 0);
        if (Date.now() - last < 24 * 3600 * 1000) { return; }
        await state.update('codico.marketplaceChecked', Date.now());
        try {
            const pending = updates(installer.lock(), await this.packages());
            if (pending.length === 0) { return; }
            const pick = await vscode.window.showInformationMessage(`Codico: updates for ${pending.map(u => `${u.id} (${u.from} → ${u.to})`).join(', ')}.`, 'Review Updates');
            if (pick) { await this.open(); }
        } catch { /* offline: next time */ }
    }
}
