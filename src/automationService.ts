import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AutomationEngine, AutomationData, emptyData } from './automationEngine';
import { Job, jobLine, readConfig } from './automations';
import { git, repositoryRoot } from './backgroundGit';
import { BackgroundPermissions, BackgroundTask } from './backgroundTasks';
import { BackgroundTaskManager } from './backgroundTaskManager';
import { BackgroundTaskStore } from './backgroundTaskStore';
import { GitHubEvents } from './githubEvents';
import { keySecretFor, workflowNames, workflowYaml } from './automationWorkflow';
import { GITHUB, GitHubApi } from './githubApi';
import { githubToken } from './pullRequestService';
import { parseGitHubRemote } from './pullRequests';
import { TeamWorkers } from './teamWorkers';

const STATE_KEY = 'codico.automations';
export const MIN_POLL_SECONDS = 30;

const apiFrom = (url: string): GitHubApi => {
    const parsed = new URL(url);
    return { protocol: parsed.protocol === 'http:' ? 'http:' : 'https:', host: parsed.hostname, port: parsed.port ? Number(parsed.port) : undefined };
};

/** Where GitHub's API is: api.github.com, or in automated tests the stand-in the test names. */
function githubApi(evaluationMode: boolean): GitHubApi {
    const url = evaluationMode ? process.env.CODICO_TEST_GITHUB_URL : undefined;
    return url ? apiFrom(url) : GITHUB;
}

/** GitHub for a repository: its "origin" on github.com, and the token. */
export async function githubForRepository(context: vscode.ExtensionContext, root: string, mode: { evaluationMode: boolean; headless?: { githubApi?: string } }): Promise<GitHubEvents | { error: string }> {
    // As configured: "get-url" would apply the user's URL rewriting (insteadOf) and hide the GitHub address
    const remote = await git(root, ['config', '--get', 'remote.origin.url'], 10_000);
    const repo = remote.ok ? parseGitHubRemote(remote.stdout) : undefined;
    if (!repo) { return { error: 'this repository has no "origin" remote on github.com' }; }
    // Automated tests never use the developer's own token; with nobody at the screen it comes from the environment
    const token = mode.evaluationMode ? process.env.CODICO_TEST_GITHUB_TOKEN
        : mode.headless ? (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || await githubToken(context)) : await githubToken(context);
    if (!token) { return { error: 'no GitHub token: set one with "Codico: Set GitHub Token", or sign in to the GitHub CLI' }; }
    return new GitHubEvents(mode.headless?.githubApi ? apiFrom(mode.headless.githubApi) : githubApi(mode.evaluationMode), token, repo);
}

/**
 * Automations in the editor: on for a repository only when the user turns them on there (kept
 * in this workspace's state, never in a file of the project). While the window is open,
 * GitHub is read every few minutes; jobs run in this window, in the Agents view.
 */
export class AutomationService implements vscode.Disposable {
    readonly engine: AutomationEngine;
    private _timer: ReturnType<typeof setInterval> | undefined;
    private readonly _status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);

    /**
     * @param _headless `codico automate`: state in a file of its state folder, the token from the environment
     * (GITHUB_TOKEN in GitHub Actions), GitHub's API where it says, and messages written to its output
     */
    constructor(private readonly _context: vscode.ExtensionContext, store: BackgroundTaskStore, private readonly _tasks: BackgroundTaskManager, private readonly _workers: TeamWorkers, private readonly _evaluationMode: boolean,
        private readonly _headless?: { stateFile: string; githubApi?: string; write(event: Record<string, unknown>): void }) {
        this.engine = new AutomationEngine({
            store,
            repoRoot: () => this._repo(),
            github: () => this._github(),
            load: () => this.data(),
            save: data => this._save(data),
            createTask: options => this._tasks.createTask(options),
            launch: task => this._workers.launch(task),
            resume: (task, text) => this._workers.resume(task, text),
            permissions: () => {
                const value = vscode.workspace.getConfiguration('codico').get<string>('automationPermissions', 'edits');
                return (['ask', 'edits', 'all'].includes(value) ? value : 'edits') as BackgroundPermissions;
            },
            askToPublish: job => { if (this._headless) { this._headless.write({ type: 'job', text: `${jobLine(job)}: ready to publish; run with --publish to publish without asking` }); } else { void this._askToPublish(job); } },
            tell: (text, job) => { if (this._headless) { this._headless.write({ type: 'job', text }); } else if (!this._evaluationMode) { void this._tell(text, job); } },
        });
        this._status.command = 'codico.automations';
        this._schedule();
    }

    dispose(): void { if (this._timer) { clearInterval(this._timer); } this._status.dispose(); }

    data(): AutomationData {
        let stored: Partial<AutomationData> | undefined;
        if (this._headless) { try { stored = JSON.parse(fs.readFileSync(this._headless.stateFile, 'utf8')); } catch { stored = undefined; } }
        else { stored = this._context.workspaceState.get<Partial<AutomationData>>(STATE_KEY); }
        if (!stored) { return emptyData(); }
        // A copy: the stored object is shared, and a round changes its jobs before saving them
        const saved = JSON.parse(JSON.stringify(stored)) as Partial<AutomationData>;
        return { enabled: saved.enabled === true, config: readConfig(saved.config), seen: Array.isArray(saved.seen) ? saved.seen : [], jobs: Array.isArray(saved.jobs) ? saved.jobs : [] };
    }

    private async _save(data: AutomationData): Promise<void> {
        if (this._headless) { fs.mkdirSync(path.dirname(this._headless.stateFile), { recursive: true }); fs.writeFileSync(this._headless.stateFile, JSON.stringify(data, null, 2), { mode: 0o600 }); }
        else { await this._context.workspaceState.update(STATE_KEY, data); }
        this._showStatus(data);
    }

    private _showStatus(data = this.data()): void {
        if (!data.enabled) { this._status.hide(); return; }
        const active = data.jobs.filter(job => job.state !== 'done');
        const needs = active.filter(job => job.state === 'needs-you' || job.state === 'publishing').length;
        this._status.text = `$(radio-tower) Codico${active.length ? `: ${active.length} job${active.length === 1 ? '' : 's'}` : ''}${needs ? `, ${needs} for you` : ''}`;
        this._status.tooltip = `Codico automations are on for this repository${this.engine.lastProblem ? `\n${this.engine.lastProblem}` : ''}. Click for jobs and settings.`;
        this._status.show();
    }

    /** Reads GitHub on a timer while automations are on here. */
    private _schedule(): void {
        if (this._timer) { clearInterval(this._timer); this._timer = undefined; }
        const data = this.data();
        this._showStatus(data);
        if (!data.enabled || this._evaluationMode || this._headless) { return; }
        const seconds = Math.max(MIN_POLL_SECONDS, vscode.workspace.getConfiguration('codico').get<number>('automationPollSeconds', 120));
        this._timer = setInterval(() => { void this.check(); }, seconds * 1000);
        setTimeout(() => { void this.check(); }, 3000);
    }

    async check(): Promise<void> { await this.engine.tick(); this._showStatus(); }

    private async _repo(): Promise<string | undefined> {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return folder ? repositoryRoot(folder) : undefined;
    }

    private async _github(): Promise<GitHubEvents | { error: string }> {
        const root = await this._repo();
        if (!root) { return { error: 'this folder is not a git repository' }; }
        return githubForRepository(this._context, root, { evaluationMode: this._evaluationMode, headless: this._headless });
    }

    private async _task(job: Job): Promise<BackgroundTask | undefined> { return (await this._tasks.tasks()).find(task => task.id === job.taskId); }

    private async _askToPublish(job: Job): Promise<void> {
        if (this._evaluationMode) { return; }
        const what = job.source.kind === 'issue' ? `issue #${job.source.number}` : `the CI failure of ${job.source.workflow}`;
        const replies = job.pendingReplies?.length ?? 0;
        const message = job.pr ? `Codico automation: the work on the feedback for pull request #${job.pr.number} is done. Push it to the pull request${replies ? ` and answer ${replies} review comment${replies === 1 ? '' : 's'} in ${replies === 1 ? 'its thread' : 'their threads'}` : ''}?` : `Codico automation: ${what} is done. Publish it as a draft pull request?`;
        const pick = await vscode.window.showInformationMessage(message, 'Review Changes', job.pr ? 'Push' : 'Publish', 'Later');
        if (pick === 'Review Changes') { const task = await this._task(job); if (task) { await this._tasks.review(task); } void this._askToPublish(job); return; }
        if (pick === 'Publish' || pick === 'Push') { const result = await this.engine.publish(job.id); this._showStatus(); if (/could not|not opened|needs/.test(result)) { void vscode.window.showWarningMessage(`Codico automation: ${result}`); } }
    }

    private async _tell(text: string, job?: Job): Promise<void> {
        const actions = [job?.pr ? 'Open Pull Request' : '', job ? 'Show' : ''].filter(Boolean);
        const pick = await vscode.window.showInformationMessage(text, ...actions);
        if (pick === 'Open Pull Request' && job?.pr) { void vscode.env.openExternal(vscode.Uri.parse(job.pr.url)); }
        if (pick === 'Show') { await this._workers.show(); }
    }

    /** "Codico: Automations": turn them on or off here, choose what they react to, and see the jobs. */
    async manage(): Promise<void> {
        const data = this.data();
        type Item = vscode.QuickPickItem & { run?: () => Promise<void> };
        const config = data.config;
        const toggle = (label: string, on: boolean, change: () => void): Item => ({ label: `${on ? '$(check)' : '$(circle-large-outline)'} ${label}`, run: async () => { change(); await this._save(data); this._schedule(); await this.manage(); } });
        const items: Item[] = data.enabled
            ? [
                { label: '$(debug-pause) Turn automations off for this repository', run: async () => { data.enabled = false; await this._save(data); this._schedule(); } },
                { label: '$(sync) Check GitHub now', run: async () => { await this.check(); await this.manage(); } },
                { label: '$(github-action) Add a GitHub Actions workflow…', description: 'runs these automations on GitHub, without this window', run: () => this.addWorkflow() },
                { label: '', kind: vscode.QuickPickItemKind.Separator },
                { label: `$(issues) Issues labelled: ${config.issueLabel || '(not watched)'}`, description: 'change the label; empty: issues are not watched', run: async () => {
                    const label = await vscode.window.showInputBox({ title: 'Label that hands an issue to Codico', value: config.issueLabel, prompt: 'Only people who can label issues (triage access) can add it.' });
                    if (label !== undefined) { config.issueLabel = label.trim(); await this._save(data); } await this.manage(); } },
                toggle('CI failures on the default branch', config.ciFailures, () => { config.ciFailures = !config.ciFailures; }),
                toggle('Follow its pull requests: CI failures and requested changes resume the job', config.prFeedback, () => { config.prFeedback = !config.prFeedback; }),
                toggle('Publish without asking (push, open draft pull requests, push fixes to them)', config.publish === 'auto', () => { config.publish = config.publish === 'auto' ? 'ask' : 'auto'; }),
                toggle('Answer review comments in their threads, when publishing the fix', config.replyToReviews, () => { config.replyToReviews = !config.replyToReviews; }),
            ]
            : [{ label: '$(radio-tower) Turn automations on for this repository…', run: () => this._turnOn(data) }];
        const jobs = [...data.jobs].reverse();
        if (jobs.length) { items.push({ label: 'Jobs', kind: vscode.QuickPickItemKind.Separator }, ...jobs.map((job): Item => ({ label: `${{ working: '$(sync~spin)', publishing: '$(cloud-upload)', watching: '$(eye)', 'needs-you': '$(bell-dot)', done: '$(check)' }[job.state]} ${jobLine(job)}`, run: () => this._jobActions(job) }))); }
        const pick = await vscode.window.showQuickPick(items, { title: `Codico automations${this.engine.lastProblem ? ` — ${this.engine.lastProblem}` : ''}`, placeHolder: data.enabled ? 'Settings and jobs' : 'Codico can react to GitHub issues, CI failures and reviews' });
        await pick?.run?.();
    }

    private async _turnOn(data: AutomationData): Promise<void> {
        const sandbox = vscode.workspace.getConfiguration('codico').get<string>('commandSandbox', 'off');
        const go = await vscode.window.showWarningMessage('Turn on Codico automations for this repository?', { modal: true, detail:
            `While this window is open, Codico reads GitHub every few minutes with your token. An issue labelled "${data.config.issueLabel}" or a new CI failure on the default branch starts a job: an agent works on it in a worktree of its own, in this window (Agents view). ` +
            'When it is done, its branch is pushed and a draft pull request opened (after asking you, unless you choose otherwise). Codico then follows that pull request: when CI fails or a reviewer asks for changes, the same agent resumes with its conversation and pushes a fix.\n\n' +
            `Issues, logs and reviews are other people's words: a job's commands run without asking only in the command sandbox${sandbox === 'required' ? ' (on)' : ' (codico.commandSandbox is not "required", so commands will be asked in the Agents view)'}.` }, 'Turn On');
        if (go !== 'Turn On') { return; }
        data.enabled = true;
        await this._save(data);
        this._schedule();
    }

    private async _jobActions(job: Job): Promise<void> {
        const items = [
            { id: 'show', label: '$(eye) Show it in the Agents view' },
            ...(job.pr ? [{ id: 'pr', label: `$(github) Open pull request #${job.pr.number}` }] : []),
            ...(job.state === 'publishing' ? [{ id: 'publish', label: job.pr ? '$(cloud-upload) Push to the pull request' : '$(cloud-upload) Publish as a draft pull request' }] : []),
            ...(job.state !== 'done' ? [{ id: 'stop', label: '$(debug-stop) Stop following it', description: 'its pull request stays open on GitHub' }] : []),
            { id: 'log', label: '$(history) What happened', description: job.log.slice(-1)[0]?.text },
        ];
        const pick = await vscode.window.showQuickPick(items, { title: jobLine(job) });
        if (pick?.id === 'show') { await this._workers.show(); }
        if (pick?.id === 'pr' && job.pr) { void vscode.env.openExternal(vscode.Uri.parse(job.pr.url)); }
        if (pick?.id === 'publish') { void vscode.window.showInformationMessage(`Codico automation: ${await this.engine.publish(job.id)}`); }
        if (pick?.id === 'stop') { await this.engine.stop(job.id); this._showStatus(); }
        if (pick?.id === 'log') { await vscode.window.showQuickPick(job.log.slice().reverse().map(entry => ({ label: entry.text, description: new Date(entry.at).toLocaleString() })), { title: jobLine(job) }); }
    }

    /**
     * "Codico: Add GitHub Actions Workflow for Automations": writes .github/workflows/codico.yml,
     * which runs `codico automate` on GitHub's events, for the user to read, commit and give its secrets.
     */
    async addWorkflow(): Promise<void> {
        const root = await this._repo();
        if (!root) { void vscode.window.showWarningMessage('Codico: open a git repository first.'); return; }
        const dir = path.join(root, '.github', 'workflows');
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(file => /\.ya?ml$/.test(file)).map(file => ({ file, text: fs.readFileSync(path.join(dir, file), 'utf8') })) : [];
        const names = workflowNames(files);
        const picked = names.length ? await vscode.window.showQuickPick(names.map(name => ({ label: name, picked: /\b(?:ci|test|build)\b/i.test(name) })),
            { canPickMany: true, title: 'Which workflows should Codico fix when they fail on the default branch?', placeHolder: 'None: CI failures are not taken' }) : [];
        if (picked === undefined) { return; }
        const model = vscode.workspace.getConfiguration('codico').get<string>('model', 'deepseek/deepseek-v4-flash');
        if (/^(?:claude-code|chatgpt|ollama)\//.test(model)) {
            void vscode.window.showWarningMessage(`Codico: the model "${model}" cannot run on GitHub's machines (it needs a sign-in or a local server). Choose a model with an API key first, or edit --model in the workflow.`);
        }
        const target = path.join(dir, 'codico.yml');
        if (fs.existsSync(target) && await vscode.window.showWarningMessage('.github/workflows/codico.yml exists. Replace it?', { modal: true }, 'Replace') !== 'Replace') { return; }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(target, workflowYaml({ label: this.data().config.issueLabel || 'codico', ciWorkflows: picked.map(item => item.label), model, codicoRepo: 'ehk2509/codico' }));
        await vscode.window.showTextDocument(vscode.Uri.file(target));
        const key = keySecretFor(model);
        void vscode.window.showInformationMessage(`Codico: workflow written. Read it, commit it, and add the repository secrets it names${key ? ` (${key}, and CODICO_GITHUB_TOKEN so that your CI runs on Codico's pull requests)` : ' (CODICO_GITHUB_TOKEN)'}.`);
    }

    /** Automated tests: set the configuration, run a round, or read the state. */
    async evaluation(action: 'configure' | 'tick' | 'get' | 'publish', value?: unknown): Promise<(AutomationData & { problem?: string }) | string> {
        if (action === 'configure') { const data = this.data(); data.enabled = true; data.config = readConfig(value); await this._save(data); }
        if (action === 'tick') { await this.engine.tick(); }
        if (action === 'publish') { return this.engine.publish(String(value)); }
        return { ...this.data(), problem: this.engine.lastProblem };
    }
}
