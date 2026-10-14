import * as vscode from 'vscode';
import { ollamaChatCompletion } from './ollamaClient';
import { directSingleCompletion } from './directProviderClient';
import { detectTestCommand, buildTestLoopPrompt } from './testOrchestrator';
import { runGit, fetchCommitMessage } from './commitMessageProvider';
import { ExtensionMessage } from './chatProtocol';
import { REVIEW_PROMPT } from './agentPrompts';

/**
 * Commands the panel offers around the conversation: attaching context, reviewing the open
 * file or selection, running the tests to fix them, the selection badge, and committing after
 * a task. Each reaches the agent only through the host.
 */
export interface PanelHost {
    post(message: ExtensionMessage): void;
    /** Sends a message to the agent as if typed (the panel shows the reply). */
    send(text: string): Promise<void>;
    /** Sends a message, opening the panel first. */
    sendShown(text: string): Promise<void>;
    /** The panel is open. */
    ready(): boolean;
    /** Aborted when the extension shuts down. */
    sessionSignal(): AbortSignal;
}

export async function contextRequest(host: PanelHost, kind: 'file' | 'selection' | 'diagnostics' | 'files-pick'): Promise<void> {
    switch (kind) {
        case 'file': {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                host.post({ type: 'contextSnippet', kind: 'file', label: 'No active file', text: '' });
                return;
            }
            const relPath = vscode.workspace.asRelativePath(editor.document.uri);
            const rawText = editor.document.getText();
            const text = `File: ${relPath}\n\`\`\`${editor.document.languageId}\n${rawText.slice(0, 20_000)}\n\`\`\`${rawText.length > 20_000 ? '\n… (truncated)' : ''}`;
            host.post({ type: 'contextSnippet', kind: 'file', label: relPath, text });
            break;
        }
        case 'selection': {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.selection.isEmpty) {
                host.post({ type: 'contextSnippet', kind: 'selection', label: 'No selection', text: '' });
                return;
            }
            const relPath = vscode.workspace.asRelativePath(editor.document.uri);
            const selText = editor.document.getText(editor.selection);
            const { start, end } = editor.selection;
            const text = `Selection from ${relPath} (lines ${start.line + 1}–${end.line + 1}):\n\`\`\`${editor.document.languageId}\n${selText}\n\`\`\``;
            host.post({ type: 'contextSnippet', kind: 'selection', label: `${relPath}:${start.line + 1}-${end.line + 1}`, text });
            break;
        }
        case 'diagnostics': {
            const allDiags = vscode.languages.getDiagnostics();
            const lines: string[] = [];
            let count = 0;
            for (const [uri, diags] of allDiags) {
                const relPath = vscode.workspace.asRelativePath(uri);
                for (const d of diags) {
                    if (d.severity > vscode.DiagnosticSeverity.Warning) { continue; }
                    if (count >= 30) { lines.push('…'); break; }
                    const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARNING';
                    lines.push(`${relPath}:${d.range.start.line + 1}: ${sev}: ${d.message}`);
                    count++;
                }
                if (count >= 30) { break; }
            }
            const text = lines.length > 0
                ? `Workspace diagnostics:\n${lines.join('\n')}`
                : 'No errors or warnings in workspace.';
            host.post({ type: 'contextSnippet', kind: 'diagnostics', label: `${count} issue(s)`, text });
            break;
        }
        case 'files-pick': {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders || folders.length === 0) { return; }
            const allFiles = await vscode.workspace.findFiles(
                '**/*',
                '{**/node_modules/**,**/.git/**,**/out/**,**/.vscode/**}',
                800
            );
            const items = allFiles
                .map(uri => ({ label: vscode.workspace.asRelativePath(uri), uri }))
                .sort((a, b) => a.label.localeCompare(b.label));
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select files to attach as context (Space to select, Enter to confirm)',
                canPickMany: true,
                matchOnDescription: true,
            });
            if (!selected || selected.length === 0) { return; }
            for (const item of selected) {
                try {
                    const bytes = await vscode.workspace.fs.readFile(item.uri);
                    const rawText = new TextDecoder().decode(bytes);
                    let lang = 'text';
                    try {
                        const doc = await vscode.workspace.openTextDocument(item.uri);
                        lang = doc.languageId;
                    } catch { /* binary or unopenable */ }
                    const snippet = rawText.slice(0, 20_000);
                    const truncated = rawText.length > 20_000 ? '\n… (truncated at 20 000 chars)' : '';
                    const text = `File: ${item.label}\n\`\`\`${lang}\n${snippet}\n\`\`\`${truncated}`;
                    host.post({ type: 'contextSnippet', kind: 'file', label: item.label, text });
                } catch {
                    // skip unreadable / binary files
                }
            }
            break;
        }
    }
}

export async function reviewCode(host: PanelHost, target: 'file' | 'selection'): Promise<void> {
    if (!host.ready()) { return; }

    const editor = vscode.window.activeTextEditor;
    let codeContext = '';
    let displayLabel = '';

    if (target === 'selection') {
        if (!editor || editor.selection.isEmpty) {
            host.post({ type: 'reviewReady', label: '', error: 'No text selected. Select code first then click Review.' });
            return;
        }
        const relPath = vscode.workspace.asRelativePath(editor.document.uri);
        const { start, end } = editor.selection;
        displayLabel = `${relPath}:${start.line + 1}-${end.line + 1}`;
        const selText = editor.document.getText(editor.selection);
        codeContext = `Selection from ${displayLabel}:\n\`\`\`${editor.document.languageId}\n${selText}\n\`\`\``;
    } else {
        if (!editor) {
            host.post({ type: 'reviewReady', label: '', error: 'No active file open. Open a file and try again.' });
            return;
        }
        const relPath = vscode.workspace.asRelativePath(editor.document.uri);
        displayLabel = relPath;
        const rawText = editor.document.getText();
        const snippet = rawText.slice(0, 24_000);
        const truncated = rawText.length > 24_000 ? '\n… (truncated at 24 000 chars)' : '';
        codeContext = `File: ${relPath}\n\`\`\`${editor.document.languageId}\n${snippet}\n\`\`\`${truncated}`;
    }

    host.post({ type: 'reviewReady', label: displayLabel, error: undefined });

    const reviewMessage = `${codeContext}\n\n${REVIEW_PROMPT}`;
    await host.send(reviewMessage);
}

export async function runAndFixTests(host: PanelHost): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
        host.post({ type: 'error', message: 'No workspace folder open.' });
        return;
    }

    const detected = detectTestCommand(folders[0].uri.fsPath);

    const confirmed = await vscode.window.showInputBox({
        title: 'Codico: Run & Fix Tests',
        prompt: detected
            ? 'Detected test command — edit if needed or press Enter to confirm'
            : 'No test runner detected — enter the command to run your tests',
        value: detected ?? '',
        placeHolder: 'e.g. npm test, pytest, go test ./...',
        ignoreFocusOut: true,
    });

    if (!confirmed?.trim()) { return; }
    await host.sendShown(buildTestLoopPrompt(confirmed.trim()));
}

export async function autoCommit(host: PanelHost, apiKey: string, model: string, isOllama: boolean, ollamaBaseUrl: string, ollamaModel: string, userPrompt: string, isDirect = false, directKey = '', directProviderId = '', directModelId = ''): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return; }
    const cwd = folders[0].uri.fsPath;

    try {
        // Stage all changes
        await runGit(['add', '-A'], cwd);

        // Check if there is actually anything staged
        const staged = await runGit(['diff', '--staged', '--name-only'], cwd).catch(() => '');
        if (!staged.trim()) { return; }

        // Generate commit message
        let commitMsg = '';
        try {
            const diff = await runGit(['diff', '--staged'], cwd);
            if (isOllama) {
                const systemMsg = 'You are a commit message generator. Given a git diff, produce a concise conventional commit message. Format: type(scope): description — max 72 chars. Output ONLY the commit message, nothing else.';
                commitMsg = await ollamaChatCompletion(
                    ollamaBaseUrl,
                    [{ role: 'system', content: systemMsg }, { role: 'user', content: `Git diff:\n\n${diff.slice(0, 8000)}` }],
                    ollamaModel,
                    100
                );
            } else if (isDirect) {
                const commitPrompt = `Generate a concise conventional commit message for this diff. Format: type(scope): description — max 72 chars. Output ONLY the commit message.\n\nGit diff:\n\n${diff.slice(0, 8000)}`;
                commitMsg = await directSingleCompletion(directKey, directProviderId, directModelId, commitPrompt, 100, host.sessionSignal());
            } else {
                commitMsg = await fetchCommitMessage(apiKey, model, diff);
            }
        } catch { /* fall back to prompt-based message */ }

        if (!commitMsg) {
            const label = userPrompt.replace(/\s+/g, ' ').trim().slice(0, 60);
            commitMsg = `feat: ${label}${label.length < userPrompt.trim().length ? '…' : ''}`;
        }

        commitMsg = commitMsg.trim().replace(/^["']|["']$/g, '');
        await runGit(['commit', '-m', commitMsg], cwd);

        host.post({ type: 'autoCommitDone', message: commitMsg });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        host.post({ type: 'autoCommitError', message });
    }
}

export function postSelectionBadge(host: PanelHost): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
        host.post({ type: 'selectionBadge', label: '' });
        return;
    }
    const sel = editor.selection;
    const relPath = vscode.workspace.asRelativePath(editor.document.uri);
    host.post({ type: 'selectionBadge', label: `${relPath}:${sel.start.line + 1}–${sel.end.line + 1}` });
}
