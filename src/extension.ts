import { headlessTask, headlessWriter, isHeadless, runAutomate, runHeadless } from './headless';
import { addressReviewComments, createPullRequestForCurrentBranch, openPullRequest } from './pullRequestService';
import { openProjectMemory } from './projectMemoryStore';
import { clearCheckpoints, undoLastRewind } from './rewind';
import { WEB_SEARCH_KEY } from './externalToolRuntime';
import { BackgroundTask } from './backgroundTasks';
import { BackgroundTaskStore } from './backgroundTaskStore';
import { BackgroundTaskManager, runInPanel, worktreesRoot } from './backgroundTaskManager';
import { runTaskOfThisWindow } from './backgroundTaskRunner';
import { TeamService } from './teamService';
import { DebugController } from './debugController';
import { nameRepositories } from './repositories';
import { repositoryRoot } from './backgroundGit';
import { TeamWorkers } from './teamWorkers';
import { AutomationService } from './automationService';
import { MarketplaceService } from './marketplaceService';
import { BackgroundPermissions } from './backgroundTasks';
import * as vscode from 'vscode';
import { onboardOnFirstRun, openWalkthrough } from './firstRun';
import { createUserExtension } from './userExtensionsLoader';
import { createHooksFile } from './hookRunner';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentProvider } from './agentProvider';
import { WebviewMessage } from './chatProtocol';
import { InlineCompletionProvider } from './inlineCompletionProvider';
import { handleInlineChat, registerInlineDiffCommands } from './inlineChatProvider';
import { generateCommitMessage } from './commitMessageProvider';
import { NextEditProvider, registerNextEditTracker } from './nextEditProvider';
import { AiRenameProvider, suggestRename } from './renameProvider';
import { watchIgnoreFile } from './ignoreRules';
import { buildPrContext } from './prContextProvider';
import { discoverCoverageFile, parseCoverage, buildCoveragePrompt } from './coverageProvider';
import { registerCodeLens } from './codeLensProvider';
import { DIRECT_PROVIDERS, directSecretKey } from './directProviderClient';
import { usableModel } from './modelFallback';

let _provider: AgentProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
    const evaluationMode =
        context.extensionMode === vscode.ExtensionMode.Test &&
        process.env.CODICO_EVAL_MODE === '1';
    const provider = new AgentProvider(context.extensionUri, context, evaluationMode);
    _provider = provider;

    if (evaluationMode) {
        context.subscriptions.push(
            vscode.commands.registerCommand('codico.__evalConfigure', async (options: {
                openRouterApiKey: string;
                model: string;
                maxIterations?: number;
                maxTotalTokens?: number;
                accoEnabled?: boolean;
                accoBaseUrl?: string;
                /** Keys for direct providers, by provider id (e.g. { deepseek: '…' }). */
                directApiKeys?: Record<string, string>;
            }) => {
                if (!options?.openRouterApiKey?.trim() && !options?.directApiKeys) {
                    throw new Error('Evaluation requires an OpenRouter API key.');
                }
                // No OpenRouter key (with direct keys only) tests the fallback to a direct provider
                if (options.openRouterApiKey?.trim()) { await context.secrets.store('openRouterApiKey', options.openRouterApiKey.trim()); }
                else { await context.secrets.delete('openRouterApiKey'); }
                for (const [providerId, key] of Object.entries(options.directApiKeys ?? {})) { await context.secrets.store(directSecretKey(providerId), key); }
                const cfg = vscode.workspace.getConfiguration('codico');
                await cfg.update('model', options.model, vscode.ConfigurationTarget.Global);
                await cfg.update('maxIterations', options.maxIterations ?? 16, vscode.ConfigurationTarget.Global);
                await cfg.update('verificationGraceIterations', 4, vscode.ConfigurationTarget.Global);
                await cfg.update('mutationGraceIterations', 3, vscode.ConfigurationTarget.Global);
                await cfg.update('accoEnabled', options.accoEnabled === true, vscode.ConfigurationTarget.Global);
                if (options.accoBaseUrl) {
                    await cfg.update('accoBaseUrl', options.accoBaseUrl, vscode.ConfigurationTarget.Global);
                }
                provider.setEvaluationTokenBudget(options.maxTotalTokens ?? 0);
                await cfg.update('followUpSuggestionsEnabled', false, vscode.ConfigurationTarget.Global);
                await cfg.update('completionNotificationsEnabled', false, vscode.ConfigurationTarget.Global);
                await cfg.update('responseSummaryEnabled', false, vscode.ConfigurationTarget.Global);
                await cfg.update('autoIndex', false, vscode.ConfigurationTarget.Global);
            }),
            vscode.commands.registerCommand('codico.__evalRunTask', async (prompt: string) => {
                if (!prompt?.trim()) { throw new Error('Evaluation prompt is required.'); }
                return provider.runEvaluationTask(prompt);
            }),
            vscode.commands.registerCommand('codico.__evalRunPlan', async (goal: string) => {
                if (!goal?.trim()) { throw new Error('Evaluation plan goal is required.'); }
                return provider.runEvaluationTask(goal, 'plan');
            }),
            vscode.commands.registerCommand('codico.__evalAnswerClarify', async (answer: string) => provider.runEvaluationTask(answer, 'clarify')),
            vscode.commands.registerCommand('codico.__evalSnapshot', () => provider.getEvaluationSnapshot()),
            vscode.commands.registerCommand('codico.__evalPassport', () => provider.evaluationPassport()),
            vscode.commands.registerCommand('codico.__evalTurns', (thread?: boolean) => provider.evaluationTurns(thread)),
            vscode.commands.registerCommand('codico.__evalUsage', () => provider.lastReplyUsage()),
            vscode.commands.registerCommand('codico.__evalReplyText', () => provider.lastReplyText()),
            vscode.commands.registerCommand('codico.__evalApprovals', (require?: boolean | 'commands') => provider.evaluationApprovals(require)),
            vscode.commands.registerCommand('codico.__evalWebviewMessage', (msg: WebviewMessage) => provider.handleEvaluationWebviewMessage(msg)),
        );
    }

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            AgentProvider.viewType,
            provider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // First run after install: the Get Started guide, once
    void onboardOnFirstRun(context).catch(() => { /* the guide is optional */ });

    // ── Restore local index metadata, then optionally auto-index ────────────────
    void (async () => {
        if (!vscode.workspace.workspaceFolders?.length) { return; }

        // Loading is always local: persisted vectors/metadata are hydrated from the
        // current source tree without sending code anywhere.
        const loaded = await provider.workspaceIndex.load();

        const cfg = vscode.workspace.getConfiguration('codico');
        if (!cfg.get<boolean>('autoIndex', false) || loaded) { return; }

        const apiKey = await context.secrets.get('openRouterApiKey') ?? '';
        provider.workspaceIndex.setApiKey(apiKey);
        void provider.workspaceIndex.buildIndexBackground();
    })();

    // ── .copilotignore watcher ────────────────────────────────────────────────
    watchIgnoreFile(context);

    // ── Inline completions (ghost text) ──────────────────────────────────────
    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**' },
            new InlineCompletionProvider(context)
        )
    );

    // ── Next Edit Suggestions ─────────────────────────────────────────────────
    registerNextEditTracker(context);
    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**' },
            new NextEditProvider(context)
        )
    );

    // ── Headless: started by the `codico` command with a task and nobody at the screen ──
    // `codico automate` keeps its tasks, conversations and worktrees in its state folder, so that a later run goes on from them
    const automateTask = isHeadless(context) ? headlessTask() : undefined;
    const stateDir = automateTask?.mode === 'automate' ? automateTask.automate?.stateDir : undefined;

    // ── Background tasks: started here, run in a window of their own ───────────
    const backgroundStore = new BackgroundTaskStore(stateDir ? path.join(stateDir, 'tasks') : path.join(context.globalStorageUri.fsPath, 'background-tasks'));
    const backgroundTasks = new BackgroundTaskManager(backgroundStore, input => openPullRequest(context, input));
    provider.onBackgroundRequest = text => { void backgroundTasks.start(text); };
    backgroundTasks.onSummary = (text, needsUser) => provider.showBackgroundTasks(text, needsUser);
    // Agent teams: the panel's agent leads; its workers run here, next to it, or each in a window of its own
    const teamWorkers = new TeamWorkers(backgroundStore, { context, editProposals: provider.editProposals, approvedCommands: () => provider.approvedCommands, evaluationMode,
        // Headless automations: what jobs may do was decided on the command line (--allow-commands accepts unattended commands)
        sandboxRequired: () => (stateDir && automateTask?.permissions === 'all') || vscode.workspace.getConfiguration('codico').get<string>('commandSandbox', 'off') === 'required',
        declineQuestions: !!stateDir },
        message => provider.postToPanel(message), task => backgroundTasks.openWindow(task));
    context.subscriptions.push(teamWorkers);
    provider.workers = teamWorkers;
    const inWindows = () => !runInPanel();
    // Automations: GitHub issues, CI failures and reviews start and resume jobs (off until turned on for a repository)
    const automations = new AutomationService(context, backgroundStore, backgroundTasks, teamWorkers, evaluationMode,
        stateDir && automateTask ? { stateFile: path.join(stateDir, 'automations.json'), githubApi: automateTask.automate?.githubApi, write: headlessWriter(automateTask) } : undefined);
    if (isHeadless(context)) {
        context.subscriptions.push(vscode.commands.registerCommand('codico.__headlessRun', () => stateDir
            ? runAutomate(context, automations, async () => teamWorkers.busy || (await Promise.all(automations.data().jobs.filter(job => job.state === 'working').map(job => backgroundStore.get(job.taskId))))
                .some(task => task?.status === 'running' || task?.status === 'starting'))
            : runHeadless(context, provider)));
    }
    context.subscriptions.push(automations, vscode.commands.registerCommand('codico.automations', () => automations.manage()),
        vscode.commands.registerCommand('codico.addAutomationWorkflow', () => automations.addWorkflow()));
    if (evaluationMode) { context.subscriptions.push(vscode.commands.registerCommand('codico.__evalAutomations', (action: 'configure' | 'tick' | 'get' | 'publish', value?: unknown) => automations.evaluation(action, value))); }
    // The debugger, driven by the agent (the debug tool)
    provider.debug = new DebugController();
    context.subscriptions.push(provider.debug);
    // The marketplace: community skills, agents, MCP servers and hooks, installed into this project
    const marketplace = new MarketplaceService(async mcpChanged => { if (mcpChanged) { await provider.refreshMcp(); } },
        evaluationMode && process.env.CODICO_TEST_ARCHIVE_URL ? (repo, commit) => `${process.env.CODICO_TEST_ARCHIVE_URL}/${repo}/${commit}.tar.gz` : undefined);
    context.subscriptions.push(vscode.commands.registerCommand('codico.marketplace', () => marketplace.open()));
    if (evaluationMode) { context.subscriptions.push(vscode.commands.registerCommand('codico.__evalMarketplace', (action: 'install' | 'uninstall' | 'lock', id?: string) => marketplace.evaluation(action, id))); }
    if (!evaluationMode && !isHeadless(context)) { setTimeout(() => { void marketplace.checkUpdates(context.workspaceState); }, 15_000); }
    // /background tasks run here too, unless the setting says each gets a window
    backgroundTasks.runHere = { launch: task => teamWorkers.launch(task), has: id => teamWorkers.has(id), show: () => teamWorkers.show() };
    provider.team = new TeamService({
        // The repositories a team works across: the workspace's folders that are git repositories, and those the setting adds
        repositories: async () => {
            const roots: string[] = [];
            for (const folder of vscode.workspace.workspaceFolders ?? []) { const root = await repositoryRoot(folder.uri.fsPath); if (root) { roots.push(root); } }
            const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
            for (const entry of vscode.workspace.getConfiguration('codico').get<string[]>('repositories', [])) {
                const root = await repositoryRoot(path.resolve(base, entry.replace(/^~(?=$|[\\/])/, os.homedir())));
                if (root) { roots.push(root); }
            }
            return nameRepositories(roots);
        },
        integrationFolder: team => path.join(worktreesRoot(), 'integration', team.replace(/[^A-Za-z0-9-]/g, '').slice(0, 16) || 'team'),
        store: backgroundStore, createTask: options => backgroundTasks.createTask(options),
        launch: async task => { if (inWindows()) { await backgroundTasks.openWindow(task); } else { teamWorkers.launch(task); } },
        where: () => inWindows() ? 'in a window of its own' : 'in this window (the user follows it in the Agents view of the panel)',
        settings: () => {
            const config = vscode.workspace.getConfiguration('codico');
            const permissions = config.get<string>('teamWorkerPermissions', 'edits');
            return { maxWorkers: Math.max(1, Math.min(6, config.get<number>('teamMaxWorkers', 3))), permissions: (['edits', 'all', 'ask'].includes(permissions) ? permissions : 'edits') as BackgroundPermissions };
        },
    });
    // This window may have been opened for a task: start it once the panel is there
    if (!evaluationMode) { void runTaskOfThisWindow(backgroundStore, provider); }
    else {
        context.subscriptions.push(vscode.commands.registerCommand('codico.__evalBackground', async (task?: BackgroundTask) => {
            if (task) { await backgroundStore.save(task); return runTaskOfThisWindow(backgroundStore, provider); }
            return backgroundStore.all();
        }), vscode.commands.registerCommand('codico.__evalStartBackground', async (prompt: string) => {
            // A /background task without its questions (what it may do: edit freely, ask before commands)
            const task = await backgroundTasks.createTask({ prompt, permissions: 'edits' });
            if (!('error' in task)) { backgroundTasks.runHere?.launch(task); }
            return task;
        }));
    }

    // ── Inline diff accept / reject commands ──────────────────────────────────
    registerInlineDiffCommands(context);

    // ── CodeLens: Explain / Fix above functions ───────────────────────────────
    registerCodeLens(context, (text) => provider.sendMessage(text));

    context.subscriptions.push(
        vscode.commands.registerCommand('codico.gettingStarted', () => openWalkthrough()),
        vscode.commands.registerCommand('codico.newSkill', () => createUserExtension('skill')),
        vscode.commands.registerCommand('codico.newAgent', () => createUserExtension('agent')),
        vscode.commands.registerCommand('codico.newHooks', () => createHooksFile()),
        vscode.commands.registerCommand('codico.rememberedCommands', () => provider.approvedCommands.manage()),
        backgroundTasks,
        vscode.commands.registerCommand('codico.setWebSearchKey', async () => {
            const key = await vscode.window.showInputBox({ title: 'Brave Search API key', prompt: 'Used by the agent\'s web_search tool when codico.webSearch is "brave". Leave empty to remove the stored key.', password: true, ignoreFocusOut: true });
            if (key === undefined) { return; }
            if (key.trim()) { await context.secrets.store(WEB_SEARCH_KEY, key.trim()); } else { await context.secrets.delete(WEB_SEARCH_KEY); }
            void vscode.window.showInformationMessage(key.trim() ? 'Codico: web search key saved.' : 'Codico: web search key removed.');
        }),
        vscode.commands.registerCommand('codico.copyCliCommand', async () => {
            const command = `node "${path.join(context.extensionPath, 'bin', 'codico.js')}"`;
            await vscode.env.clipboard.writeText(command);
            void vscode.window.showInformationMessage(`Codico: copied. Run a task without the editor with: ${command} run "<task>" --allow-edits   (add --help for the options)`);
        }),
        vscode.commands.registerCommand('codico.openMemory', () => openProjectMemory()),
        vscode.commands.registerCommand('codico.createPullRequest', () => createPullRequestForCurrentBranch(context)),
        vscode.commands.registerCommand('codico.addressReview', () => addressReviewComments(context, text => provider.sendMessage(text))),
        vscode.commands.registerCommand('codico.undoRewind', () => undoLastRewind(provider.checkpoints)),
        vscode.commands.registerCommand('codico.clearCheckpoints', () => clearCheckpoints(provider.checkpoints)),
        vscode.commands.registerCommand('codico.backgroundTasks', () => backgroundTasks.manage()),
        vscode.commands.registerCommand('codico.startBackgroundTask', (text?: string) => backgroundTasks.start(typeof text === 'string' ? text : undefined)),
        vscode.commands.registerCommand('codico.openChat', () => {
            vscode.commands.executeCommand(
                'workbench.view.extension.codico-container'
            );
            // Slight delay to allow the webview to become visible before posting
            setTimeout(() => provider.focusInput(), 150);
        })
    );

    // Open sidebar automatically on first activation
    vscode.commands.executeCommand('workbench.view.extension.codico-container');

    context.subscriptions.push(
        vscode.commands.registerCommand('codico.setApiKey', async () => {
            const existing = await context.secrets.get('openRouterApiKey');
            const key = await vscode.window.showInputBox({
                prompt: 'Enter your OpenRouter API Key',
                placeHolder: 'sk-or-v1-...',
                password: true,
                ignoreFocusOut: true,
                value: existing ? '' : undefined,
                valueSelection: existing ? [0, 0] : undefined,
            });
            if (key) {
                await context.secrets.store('openRouterApiKey', key.trim());
                vscode.window.showInformationMessage(
                    'Codico: API key saved securely.'
                );
            }
        })
    );

    // ── Ollama base URL ───────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('codico.setOllamaUrl', async () => {
            const config = vscode.workspace.getConfiguration('codico');
            const current = config.get<string>('ollamaBaseUrl', 'http://localhost:11434');
            const url = await vscode.window.showInputBox({
                prompt: 'Enter your Ollama base URL',
                placeHolder: 'http://localhost:11434',
                ignoreFocusOut: true,
                value: current,
            });
            if (url) {
                await config.update('ollamaBaseUrl', url.trim(), vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(
                    `Codico: Ollama base URL set to ${url.trim()}`
                );
            }
        })
    );

    // ── Direct provider API keys ──────────────────────────────────────────────
    context.subscriptions.push(
        // providerId is passed when the chat header's provider menu asks for a specific provider's key
        vscode.commands.registerCommand('codico.setDirectApiKey', async (providerId?: string) => {
            const options = DIRECT_PROVIDERS.map(p => ({ label: p.name, description: p.apiBase, providerId: p.id }));
            const picked = options.find(o => o.providerId === providerId) ?? await vscode.window.showQuickPick(
                options,
                { title: 'Codico: Select Provider', placeHolder: 'Choose a provider to set or update its API key' }
            );
            if (!picked) { return; }
            const existing = await context.secrets.get(directSecretKey(picked.providerId));
            const key = await vscode.window.showInputBox({
                prompt: `Enter your ${picked.label} API key`,
                placeHolder: 'sk-...',
                password: true,
                ignoreFocusOut: true,
                value: existing ? '' : undefined,
            });
            if (key?.trim()) {
                await context.secrets.store(directSecretKey(picked.providerId), key.trim());
                // A key alone does nothing until one of its models is selected: switch if the
                // current model cannot run (no OpenRouter key), otherwise offer to
                const cfg = vscode.workspace.getConfiguration('codico');
                const current = cfg.get<string>('model', 'deepseek/deepseek-v4-flash');
                if (await usableModel(context, current) !== current || current.startsWith(`direct:${picked.providerId}/`)) {
                    vscode.window.showInformationMessage(`Codico: ${picked.label} API key saved.`);
                    return;
                }
                const first = DIRECT_PROVIDERS.find(p => p.id === picked.providerId)?.models[0];
                const use = first ? `Use ${first.displayName}` : undefined;
                const choice = await vscode.window.showInformationMessage(`Codico: ${picked.label} API key saved. The selected model still uses another provider.`, ...(use ? [use] : []));
                if (use && choice === use && first) { await cfg.update('model', `direct:${picked.providerId}/${first.id}`, vscode.ConfigurationTarget.Global); }
            }
        })
    );

    // ── Inline Chat (Ctrl+I) ──────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('codico.inlineChat', () =>
            handleInlineChat(context, (text) => provider.sendMessage(text))
        )
    );

    // ── Toggle inline completions ─────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('codico.toggleInlineCompletions', async () => {
            const config = vscode.workspace.getConfiguration('codico');
            const current = config.get<boolean>('inlineCompletionsEnabled', true);
            await config.update('inlineCompletionsEnabled', !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                `Codico: Inline completions ${!current ? 'enabled' : 'disabled'}.`
            );
        })
    );

    // ── Commit message generation ─────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('codico.generateCommitMessage', () =>
            generateCommitMessage(context)
        )
    );

    // ── Workspace semantic index ──────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('codico.indexWorkspace', async () => {
            const apiKey = await context.secrets.get('openRouterApiKey');
            provider.workspaceIndex.setApiKey(apiKey ?? '');
            await provider.workspaceIndex.buildIndex();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codico.clearWorkspaceIndex', async () => {
            await provider.workspaceIndex.clear();
            vscode.window.showInformationMessage('Codico: Workspace index cleared.');
        })
    );

    // ── AI Rename Suggestions ─────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('codico.suggestRename', () => suggestRename(context))
    );

    // Register as a RenameProvider so F2 pre-fills the AI suggestion
    const RENAME_LANGUAGES = [
        'typescript', 'javascript', 'typescriptreact', 'javascriptreact',
        'python', 'go', 'rust', 'java', 'c', 'cpp', 'csharp',
    ];
    for (const lang of RENAME_LANGUAGES) {
        context.subscriptions.push(
            vscode.languages.registerRenameProvider(
                { language: lang },
                new AiRenameProvider(context)
            )
        );
    }

    // ── GitHub PR context ─────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('codico.setGithubToken', async () => {
            const existing = await context.secrets.get('codico.githubToken');
            const token = await vscode.window.showInputBox({
                prompt: 'Enter your GitHub Personal Access Token (for PR context)',
                placeHolder: 'ghp_...',
                password: true,
                ignoreFocusOut: true,
                value: existing ? '' : undefined,
                valueSelection: existing ? [0, 0] : undefined,
            });
            if (token) {
                await context.secrets.store('codico.githubToken', token.trim());
                vscode.window.showInformationMessage('Codico: GitHub token saved.');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codico.showPrContext', async () => {
            const ctx = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Codico: Fetching PR context…' },
                () => buildPrContext(context)
            );
            if (!ctx) {
                vscode.window.showInformationMessage('Codico: No open PR found for the current branch (or no GitHub token set).');
                return;
            }
            // Show in a virtual document
            const doc = await vscode.workspace.openTextDocument({ content: ctx, language: 'markdown' });
            await vscode.window.showTextDocument(doc, { preview: true });
        }),
        vscode.commands.registerCommand('codico.undoLastChange', async () => {
            await provider.undoRedoStep('undo');
        }),
        vscode.commands.registerCommand('codico.redoLastChange', async () => {
            await provider.undoRedoStep('redo');
        }),

        // ── Ask about diff hunk ────────────────────────────────────────────────
        vscode.commands.registerCommand('codico.askAboutDiffHunk', async (resourceState?: vscode.SourceControlResourceState) => {
            const folders = vscode.workspace.workspaceFolders;
            const cwd = folders?.[0]?.uri.fsPath;
            if (!cwd) { return; }

            // Resolve the target file: from SCM resource state OR active diff editor
            let fileUri: vscode.Uri | undefined;
            if (resourceState?.resourceUri) {
                fileUri = resourceState.resourceUri;
            } else {
                const editor = vscode.window.activeTextEditor;
                if (editor) { fileUri = editor.document.uri; }
            }

            if (!fileUri) {
                vscode.window.showInformationMessage('Codico: No file selected. Open a diff in the SCM view or place the cursor in a diff editor first.');
                return;
            }

            const relPath = vscode.workspace.asRelativePath(fileUri);

            // Get the full git diff for this file
            const { execFile } = await import('child_process');
            const rawDiff: string = await new Promise((resolve) => {
                execFile('git', ['diff', 'HEAD', '--', relPath], { cwd, timeout: 8000 }, (err, stdout) => {
                    if (err || !stdout.trim()) {
                        // Fall back to staged diff
                        execFile('git', ['diff', '--cached', '--', relPath], { cwd, timeout: 8000 }, (_e2, s2) => {
                            resolve(s2 ?? '');
                        });
                    } else {
                        resolve(stdout);
                    }
                });
            });

            if (!rawDiff.trim()) {
                vscode.window.showInformationMessage(`Codico: No unstaged or staged diff found for ${relPath}.`);
                return;
            }

            // If we have a cursor position in the active editor, extract just the hunk
            // that contains the cursor line; otherwise send the whole diff
            const editor = vscode.window.activeTextEditor;
            let diffToSend = rawDiff.slice(0, 8000);

            if (editor && editor.document.uri.toString() === fileUri.toString()) {
                const cursorLine = editor.selection.active.line + 1; // 1-based
                const hunk = _extractHunkAtLine(rawDiff, cursorLine);
                if (hunk) { diffToSend = hunk; }
            }

            // Ask what the user wants to know
            const action = await vscode.window.showQuickPick(
                [
                    { label: '$(comment) Explain this diff', value: 'explain' },
                    { label: '$(search) Review for issues', value: 'review' },
                    { label: '$(lightbulb) Suggest improvements', value: 'improve' },
                    { label: '$(symbol-misc) Custom question…', value: 'custom' },
                ],
                { title: `Codico — ${relPath}`, placeHolder: 'What do you want to know about this diff?' }
            );
            if (!action) { return; }

            let prompt: string;
            if (action.value === 'custom') {
                const q = await vscode.window.showInputBox({ prompt: 'Ask anything about this diff…', placeHolder: 'e.g. Why was this changed? Is this thread-safe?' });
                if (!q?.trim()) { return; }
                prompt = `${q.trim()}\n\nDiff for \`${relPath}\`:\n\`\`\`diff\n${diffToSend}\n\`\`\``;
            } else {
                const PROMPTS: Record<string, string> = {
                    explain: `Explain the following git diff for \`${relPath}\` clearly. Describe what changed, why it might have been changed, and the impact of the change.`,
                    review:  `Review the following git diff for \`${relPath}\`. Identify any bugs, security issues, performance problems, missing edge cases, or style concerns. Be specific and actionable.`,
                    improve: `Suggest concrete improvements for the following git diff for \`${relPath}\`. Consider code clarity, performance, correctness, and best practices.`,
                };
                prompt = `${PROMPTS[action.value]}\n\n\`\`\`diff\n${diffToSend}\n\`\`\``;
            }

            await provider.sendMessage(prompt);
        }),

        // ── Explain terminal error ─────────────────────────────────────────────
        vscode.commands.registerCommand('codico.explainTerminalError', async () => {
            // Try reading terminal selection without touching the clipboard.
            // The proposed Terminal.selection API may not be available in all builds,
            // so we fall back to a clipboard round-trip only when necessary.
            let selected: string | undefined;
            const activeTerminal = vscode.window.activeTerminal as vscode.Terminal & { selection?: string } | undefined;
            if (activeTerminal?.selection) {
                selected = activeTerminal.selection;
            }
            if (!selected) {
                // Save existing clipboard content so we can restore it
                const savedClipboard = await vscode.env.clipboard.readText();
                await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
                selected = await vscode.env.clipboard.readText();
                // Restore the original clipboard content if nothing new was copied
                if (!selected || selected === savedClipboard) {
                    selected = selected?.trim() ? selected : undefined;
                } else {
                    // Restore original clipboard so we don't clobber user data
                    await vscode.env.clipboard.writeText(savedClipboard);
                }
            }
            if (!selected?.trim()) {
                vscode.window.showInformationMessage('Codico: Select some terminal output first, then right-click → Explain Error.');
                return;
            }
            const prompt =
                `Explain the following terminal error clearly. Identify the root cause, what triggered it, and provide concrete steps to fix it.\n\n` +
                `\`\`\`\n${selected.slice(0, 3000)}\n\`\`\``;
            await provider.sendMessage(prompt);
        }),

        // ── Test generation from coverage ─────────────────────────────────────
        vscode.commands.registerCommand('codico.generateTestsFromCoverage', async () => {
            const folders = vscode.workspace.workspaceFolders;
            const workspaceRoot = folders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                vscode.window.showErrorMessage('Codico: No workspace folder open.');
                return;
            }

            // Discover coverage file
            const coverageFile = await discoverCoverageFile(workspaceRoot);
            if (!coverageFile) {
                const choice = await vscode.window.showWarningMessage(
                    'Codico: No coverage report found. Run your test suite with coverage enabled first (e.g. `jest --coverage` or `nyc`).',
                    'Pick file manually'
                );
                if (choice !== 'Pick file manually') { return; }
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'Coverage reports': ['info', 'json', 'dat'] },
                    title: 'Select coverage report file',
                });
                if (!picked || picked.length === 0) { return; }
                // Re-run with manually selected file
                await _runCoverageGen(provider, picked[0].fsPath);
                return;
            }

            await _runCoverageGen(provider, coverageFile);
        })
    );
}

export async function deactivate(): Promise<void> {
    await _provider?.closeBrowser();
}

async function _runCoverageGen(provider: AgentProvider, coverageFile: string): Promise<void> {
    const coverageMap = await parseCoverage(coverageFile).catch(err => {
        vscode.window.showErrorMessage(`Codico: Failed to parse coverage file — ${(err as Error).message}`);
        return null;
    });
    if (!coverageMap || coverageMap.size === 0) {
        vscode.window.showWarningMessage('Codico: Coverage report is empty or could not be parsed.');
        return;
    }

    // Only consider files that actually have uncovered lines
    const filesWithGaps = [...coverageMap.values()].filter(fc => fc.uncoveredLines.length > 0);
    if (filesWithGaps.length === 0) {
        vscode.window.showInformationMessage('Codico: 🎉 All tracked lines are covered!');
        return;
    }

    // Default to the active editor's file if it has gaps, otherwise let user pick
    let target: typeof filesWithGaps[number] | undefined;
    const activeEditorPath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activeEditorPath) {
        target = filesWithGaps.find(fc => fc.filePath === activeEditorPath);
    }

    if (!target) {
        const items = filesWithGaps
            .sort((a, b) => a.coveredPct - b.coveredPct) // lowest coverage first
            .map(fc => ({
                label: path.basename(fc.filePath),
                description: `${fc.coveredPct}% covered — ${fc.uncoveredLines.length} uncovered line(s)`,
                detail: fc.filePath,
                fc,
            }));
        const picked = await vscode.window.showQuickPick(items, {
            title: 'Generate tests from coverage',
            placeHolder: 'Select a file to target (sorted by lowest coverage first)',
        });
        if (!picked) { return; }
        target = picked.fc;
    }

    // Read source
    let sourceCode: string;
    try {
        sourceCode = await fs.promises.readFile(target.filePath, 'utf8');
    } catch {
        vscode.window.showErrorMessage(`Codico: Cannot read source file: ${target.filePath}`);
        return;
    }

    const prompt = buildCoveragePrompt(target.filePath, target.uncoveredLines, sourceCode, target.coveredPct);
    await provider.sendMessage(prompt);
}

/**
 * Given a raw `git diff` string and a 1-based line number in the modified file,
 * return the hunk (starting from its `@@` header) that contains that line.
 * Falls back to the first hunk if no match is found.
 */
function _extractHunkAtLine(diff: string, targetLine: number): string | null {
    // Split on @@ markers, keeping the separator
    const parts = diff.split(/(?=^@@)/m);
    // Find the file header (lines before first @@)
    const header = parts[0] ?? '';
    const hunks = parts.slice(1);
    if (hunks.length === 0) { return null; }

    for (const hunk of hunks) {
        // Parse @@ -old,len +new,start @@
        const m = hunk.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/);
        if (!m) { continue; }
        const start = parseInt(m[1], 10);
        const len   = parseInt(m[2] ?? '1', 10);
        if (targetLine >= start && targetLine < start + len) {
            return (header + hunk).slice(0, 6000);
        }
    }
    // Cursor not within any hunk range — return first hunk
    return (header + hunks[0]).slice(0, 6000);
}
