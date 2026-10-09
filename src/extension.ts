import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
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
            }) => {
                if (!options?.openRouterApiKey?.trim()) {
                    throw new Error('Evaluation requires an OpenRouter API key.');
                }
                await context.secrets.store('openRouterApiKey', options.openRouterApiKey.trim());
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
                await cfg.update('checkpointSteps', 0, vscode.ConfigurationTarget.Global);
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

    // ── Inline diff accept / reject commands ──────────────────────────────────
    registerInlineDiffCommands(context);

    // ── CodeLens: Explain / Fix above functions ───────────────────────────────
    registerCodeLens(context, (text) => provider.sendMessage(text));

    context.subscriptions.push(
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
        vscode.commands.registerCommand('codico.setDirectApiKey', async () => {
            const picked = await vscode.window.showQuickPick(
                DIRECT_PROVIDERS.map(p => ({ label: p.name, description: p.apiBase, providerId: p.id })),
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
                vscode.window.showInformationMessage(`Codico: ${picked.label} API key saved.`);
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
            const fp = await provider.undoRedo.undo();
            if (fp) {
                vscode.window.showInformationMessage(`Codico: undid changes to ${fp}`);
            } else {
                vscode.window.showInformationMessage('Codico: nothing to undo');
            }
        }),
        vscode.commands.registerCommand('codico.redoLastChange', async () => {
            const fp = await provider.undoRedo.redo();
            if (fp) {
                vscode.window.showInformationMessage(`Codico: redid changes to ${fp}`);
            } else {
                vscode.window.showInformationMessage('Codico: nothing to redo');
            }
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
