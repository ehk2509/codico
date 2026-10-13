import * as nodeCrypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { commitTaskWork, createWorktree, mergeTask, removeWorktree, repositoryRoot, taskChanges, uncommittedCount } from './backgroundGit';
import { activeSummary, announcement, BackgroundPermissions, BackgroundTask, branchName, isActive, statusIcon, statusLabel, worktreeFolderName } from './backgroundTasks';
import { BackgroundTaskStore } from './backgroundTaskStore';

const POLL_MS = 4_000;
const short = (text: string, max = 70) => { const one = text.replace(/\s+/g, ' ').trim(); return one.length > max ? one.slice(0, max) + '…' : one; };

/** Where task worktrees are made: one folder for all of them, so that it can be trusted once. */
export function worktreesRoot(): string {
    const configured = vscode.workspace.getConfiguration('codico').get<string>('backgroundTasksDirectory', '').trim();
    return configured ? configured.replace(/^~(?=$|[\\/])/, os.homedir()) : path.join(os.homedir(), '.codico', 'worktrees');
}

/**
 * In the window the user works in: starts background tasks, shows how they are doing, and
 * lets their result be reviewed, merged or thrown away.
 */
export class BackgroundTaskManager implements vscode.Disposable {
    private readonly _status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    private readonly _timer: ReturnType<typeof setInterval>;
    private _known = new Map<string, BackgroundTask>();
    private _primed = false;

    /** @param _openPullRequest publishes a task's branch as a pull request; absent, the list does not offer it */
    constructor(private readonly _store: BackgroundTaskStore, private readonly _openPullRequest?: (input: { cwd: string; branch: string; baseBranch?: string; prompt: string; stat: string }) => Promise<string | undefined>) {
        this._status.command = 'codico.backgroundTasks';
        this._timer = setInterval(() => { void this.refresh(); }, POLL_MS);
        void this.refresh();
    }

    dispose(): void { clearInterval(this._timer); this._status.dispose(); }

    private async _repo(): Promise<string | undefined> {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return folder ? repositoryRoot(folder) : undefined;
    }

    /** The tasks started from this window's repository. */
    private async _tasks(): Promise<BackgroundTask[]> {
        const repo = await this._repo();
        return repo ? (await this._store.all()).filter(task => task.repoRoot === repo) : [];
    }

    /** Reads the tasks again: updates the status bar and announces what changed since last time. */
    async refresh(): Promise<void> {
        const tasks = await this._tasks();
        const now = Date.now();
        const summary = activeSummary(tasks, now);
        if (summary) {
            this._status.text = `$(layers) Codico: ${summary}`;
            this._status.tooltip = 'Background tasks started from this window. Click to see them.';
            this._status.show();
        } else if (tasks.length > 0) {
            this._status.text = `$(layers) Codico: ${tasks.length} background ${tasks.length === 1 ? 'task' : 'tasks'}`;
            this._status.tooltip = 'Finished background tasks to review, merge or discard.';
            this._status.show();
        } else { this._status.hide(); }
        for (const task of tasks) {
            // Not what was already so when this window opened
            const message = this._primed ? announcement(this._known.get(task.id), task) : undefined;
            if (message) { void this._announce(message, task); }
        }
        this._known = new Map(tasks.map(task => [task.id, task]));
        this._primed = true;
    }

    private async _announce(message: string, task: BackgroundTask): Promise<void> {
        const actions = task.status === 'finished' ? ['Review Changes', 'Open Its Window'] : ['Open Its Window'];
        const choice = await vscode.window.showInformationMessage(message, ...actions);
        if (choice === 'Review Changes') { await this.review(task); }
        if (choice === 'Open Its Window') { await this.openWindow(task); }
    }

    /** Starts a task: its own branch and worktree from the last commit, then a window for it. */
    async start(given?: string): Promise<BackgroundTask | undefined> {
        if (!vscode.workspace.isTrusted) { void vscode.window.showWarningMessage('Codico: background tasks need a trusted workspace.'); return undefined; }
        const repo = await this._repo();
        if (!repo) { void vscode.window.showWarningMessage('Codico: a background task works in a git worktree, and this folder is not in a git repository.'); return undefined; }
        const prompt = (given?.trim() ? given : await vscode.window.showInputBox({ title: 'Background task', prompt: 'What should Codico do, in a separate worktree, while you keep working here?', ignoreFocusOut: true }))?.trim();
        if (!prompt) { return undefined; }

        const pick = await vscode.window.showQuickPick<vscode.QuickPickItem & { value: BackgroundPermissions }>([
            { value: 'edits', label: 'Edit files freely, ask before commands', description: 'recommended', detail: 'Edits stay inside the task\'s own worktree. Each terminal command waits for your approval in the task\'s window.' },
            { value: 'all', label: 'Edit files and run commands without asking', detail: 'Unattended. Commands are not confined to the worktree: they run with your user\'s rights.' },
            { value: 'ask', label: 'Ask before every edit and command', detail: 'As in this window. The task waits for you often.' },
        ], { title: 'What may the background task do without asking?', ignoreFocusOut: true });
        if (!pick) { return undefined; }

        const dirty = await uncommittedCount(repo);
        if (dirty > 0) {
            const go = await vscode.window.showWarningMessage(
                `The task starts from the last commit. ${dirty} uncommitted ${dirty === 1 ? 'change' : 'changes'} in this window will not be part of it.`,
                { modal: true, detail: 'Commit first if the task needs them.' }, 'Start Anyway');
            if (go !== 'Start Anyway') { return undefined; }
        }

        const id = nodeCrypto.randomBytes(8).toString('hex');
        const branch = branchName(prompt, id);
        const worktree = path.join(worktreesRoot(), path.basename(repo), worktreeFolderName(prompt, id));
        const made = await createWorktree(repo, worktree, branch);
        if ('error' in made) { void vscode.window.showErrorMessage(`Codico: the background task could not be started: ${made.error}`); return undefined; }
        const now = Date.now();
        const task: BackgroundTask = { id, prompt, repoRoot: repo, worktree, branch, baseCommit: made.baseCommit, baseBranch: made.baseBranch, permissions: pick.value, status: 'starting', createdAt: now, updatedAt: now };
        await this._store.save(task);
        await this.refresh();
        await this.openWindow(task);
        void vscode.window.showInformationMessage(
            `Codico: background task started on branch ${branch}. Its window asks once whether you trust the folder; ` +
            `trusting the parent folder (${worktreesRoot()}) covers every later task.`);
        return task;
    }

    async openWindow(task: BackgroundTask): Promise<void> {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(task.worktree), { forceNewWindow: true });
    }

    /** Shows everything the task changed since it started, as one patch. */
    async review(task: BackgroundTask): Promise<void> {
        const changes = await taskChanges(task.worktree, task.baseCommit);
        if ('error' in changes) { void vscode.window.showErrorMessage(`Codico: ${changes.error}`); return; }
        if (changes.files === 0) { void vscode.window.showInformationMessage('Codico: this background task has not changed any file.'); return; }
        const header = `# Background task: ${short(task.prompt, 200)}\n# Branch ${task.branch}, ${changes.files} file${changes.files === 1 ? '' : 's'} changed since ${task.baseCommit.slice(0, 8)}\n#\n` +
            changes.stat.split('\n').map(line => `# ${line}`).join('\n') + '\n\n';
        const document = await vscode.workspace.openTextDocument({ language: 'diff', content: header + changes.patch });
        await vscode.window.showTextDocument(document, { preview: true });
    }

    /** Brings the task's work into the branch checked out here; nothing is left half-merged. */
    async merge(task: BackgroundTask): Promise<boolean> {
        if (isActive(task, Date.now()) && task.status !== 'waiting') {
            void vscode.window.showWarningMessage('Codico: this task is still running. Merge it when it has finished, or stop it in its window first.');
            return false;
        }
        const changes = await taskChanges(task.worktree, task.baseCommit);
        if ('error' in changes) { void vscode.window.showErrorMessage(`Codico: ${changes.error}`); return false; }
        if (changes.files === 0) { void vscode.window.showInformationMessage('Codico: this background task has not changed any file, so there is nothing to merge.'); return false; }
        const go = await vscode.window.showWarningMessage(`Merge the background task into the branch checked out here?`,
            { modal: true, detail: `${short(task.prompt, 160)}\n\n${changes.stat}\n\nIf it conflicts with your changes, the merge is undone and nothing here changes.` }, 'Merge');
        if (go !== 'Merge') { return false; }
        const committed = await commitTaskWork(task.worktree, `Codico: ${short(task.prompt, 72)}`);
        if ('error' in committed) { void vscode.window.showErrorMessage(`Codico: ${committed.error}`); return false; }
        const merged = await mergeTask(task.repoRoot, task.branch);
        if ('error' in merged) {
            void vscode.window.showErrorMessage(`Codico: not merged, ${merged.error}. Nothing here was changed; the task's work is still on branch ${task.branch}.`);
            return false;
        }
        const cleanup = await vscode.window.showInformationMessage(`Codico: merged ${task.branch}.`, 'Remove Its Worktree and Branch', 'Keep Them');
        if (cleanup === 'Remove Its Worktree and Branch') { await this._remove(task, false); }
        return true;
    }

    /** Publishes the task's work: its branch is committed, pushed and offered as a pull request. */
    async pullRequest(task: BackgroundTask): Promise<string | undefined> {
        if (!this._openPullRequest) { return undefined; }
        if (isActive(task, Date.now()) && task.status !== 'waiting') { void vscode.window.showWarningMessage('Codico: this task is still running. Open the pull request when it has finished, or stop it in its window first.'); return undefined; }
        const changes = await taskChanges(task.worktree, task.baseCommit);
        if ('error' in changes) { void vscode.window.showErrorMessage(`Codico: ${changes.error}`); return undefined; }
        if (changes.files === 0) { void vscode.window.showInformationMessage('Codico: this background task has not changed any file, so there is nothing to open a pull request for.'); return undefined; }
        const committed = await commitTaskWork(task.worktree, `Codico: ${short(task.prompt, 72)}`);
        if ('error' in committed) { void vscode.window.showErrorMessage(`Codico: ${committed.error}`); return undefined; }
        return this._openPullRequest({ cwd: task.worktree, branch: task.branch, baseBranch: task.baseBranch, prompt: task.prompt, stat: changes.stat });
    }

    /** Throws the task away: its worktree, its branch and its entry. */
    async discard(task: BackgroundTask): Promise<boolean> {
        const go = await vscode.window.showWarningMessage('Discard this background task?',
            { modal: true, detail: `${short(task.prompt, 160)}\n\nIts worktree (${task.worktree}) and its branch ${task.branch} are deleted, with everything the task did. This cannot be undone.` }, 'Discard');
        if (go !== 'Discard') { return false; }
        return this._remove(task, false);
    }

    private async _remove(task: BackgroundTask, keepBranch: boolean): Promise<boolean> {
        const removed = await removeWorktree(task.repoRoot, task.worktree, task.branch, keepBranch);
        if (removed.error) { void vscode.window.showErrorMessage(`Codico: ${removed.error}`); return false; }
        await this._store.remove(task.id);
        await this.refresh();
        return true;
    }

    /** "Codico: Background Tasks": the list, then what to do with the chosen one. */
    async manage(): Promise<void> {
        const tasks = await this._tasks();
        const now = Date.now();
        type Item = vscode.QuickPickItem & { task?: BackgroundTask };
        const items: Item[] = [{ label: '$(add) Start a background task…' }, ...tasks.map((task): Item => ({
            task, label: `${statusIcon(task, now)} ${short(task.prompt)}`,
            description: statusLabel(task, now) + (task.note && task.status !== 'finished' ? `: ${task.note}` : ''),
            detail: `${task.branch}${task.tokens ? ` · ${task.tokens.toLocaleString('en-US')} tokens` + (task.requests ? ` in ${task.requests} requests` : '') : ''}`,
        }))];
        const chosen = await vscode.window.showQuickPick(items, { title: 'Codico background tasks', placeHolder: tasks.length ? 'Choose a task' : 'No background task has been started from this repository' });
        if (!chosen) { return; }
        if (!chosen.task) { await this.start(); return; }
        const task = chosen.task;
        const action = await vscode.window.showQuickPick([
            { id: 'review', label: '$(diff) Review its changes', description: 'everything it changed since it started, as one patch' },
            { id: 'open', label: '$(window) Open its window', description: 'see the conversation, answer or approve' },
            { id: 'merge', label: '$(git-merge) Merge into the branch checked out here' },
            ...(this._openPullRequest ? [{ id: 'pr', label: '$(git-pull-request) Open a pull request', description: 'push its branch and open a pull request on GitHub, after a confirmation' }] : []),
            { id: 'discard', label: '$(trash) Discard', description: 'delete its worktree and branch' },
        ], { title: short(task.prompt) });
        if (action?.id === 'review') { await this.review(task); }
        if (action?.id === 'open') { await this.openWindow(task); }
        if (action?.id === 'merge') { await this.merge(task); }
        if (action?.id === 'pr') { await this.pullRequest(task); }
        if (action?.id === 'discard') { await this.discard(task); }
    }
}
