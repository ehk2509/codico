/**
 * AI Rename Suggestions
 *
 * Provides smart rename proposals via the VS Code RenameProvider API.
 * When the user triggers "Rename Symbol" (F2), we:
 *   1. Read the current symbol name + surrounding code.
 *   2. Ask the AI for a better name with a brief explanation.
 *   3. Pre-fill the rename input box with the suggestion.
 *
 * Additionally registers the `codico.suggestRename` command so the user can
 * invoke it from the editor context menu or command palette.
 */

import * as vscode from 'vscode';
import * as https from 'https';

// ── AI call ───────────────────────────────────────────────────────────────────

async function fetchRenameSuggestion(
    apiKey: string,
    model: string,
    language: string,
    symbolName: string,
    context: string,
    signal: AbortSignal
): Promise<{ name: string; reason: string }> {
    const prompt =
        `You are a code reviewer suggesting a better identifier name.\n` +
        `Language: ${language}\n` +
        `Current name: \`${symbolName}\`\n\n` +
        `Surrounding code:\n\`\`\`\n${context}\n\`\`\`\n\n` +
        `Respond with a JSON object (no markdown, no fence) with exactly two keys:\n` +
        `{\n  "name": "<suggested name in the same case style as the original>",\n  "reason": "<one-sentence justification>"\n}`;

    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 100,
            temperature: 0.2,
            response_format: { type: 'json_object' },
        });

        const req = https.request(
            {
                hostname: 'openrouter.ai',
                path: '/api/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'vscode-codico',
                    'X-Title': 'Codico',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = '';
                res.setEncoding('utf8'); // keeps characters split across chunks intact
                res.on('data', (c: string) => { data += c.toString(); });
                res.on('end', () => {
                    try {
                        const text: string = JSON.parse(data)?.choices?.[0]?.message?.content ?? '{}';
                        const parsed = JSON.parse(text);
                        resolve({
                            name:   typeof parsed.name   === 'string' ? parsed.name.trim()   : symbolName,
                            reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : '',
                        });
                    } catch { resolve({ name: symbolName, reason: '' }); }
                });
            }
        );
        req.on('error', reject);
        signal.addEventListener('abort', () => req.destroy(), { once: true });
        req.write(body);
        req.end();
    });
}

// ── Command handler ───────────────────────────────────────────────────────────

export async function suggestRename(_context: vscode.ExtensionContext): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }

    const apiKey = await _context.secrets.get('openRouterApiKey');
    if (!apiKey) {
        vscode.window.showWarningMessage('Codico: Set your API key first.');
        return;
    }

    const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
    if (!wordRange) {
        vscode.window.showInformationMessage('Codico: Place the cursor on a symbol to rename.');
        return;
    }

    // Trigger F2 rename — AiRenameProvider.prepareRename will fetch the AI suggestion
    // and pre-fill the rename input box automatically. No separate dialog needed.
    await vscode.commands.executeCommand('editor.action.rename', [
        editor.document.uri,
        editor.selection.active,
    ]);
}

// ── RenameProvider (F2 pre-fill) ──────────────────────────────────────────────

export class AiRenameProvider implements vscode.RenameProvider {
    constructor(private readonly _context: vscode.ExtensionContext) {}

    async prepareRename(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<{ range: vscode.Range; placeholder: string } | null> {
        const config  = vscode.workspace.getConfiguration('codico');
        if (!config.get<boolean>('renameSuggestionsEnabled', true)) { return null; }

        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) { return null; }

        const apiKey = await this._context.secrets.get('openRouterApiKey');
        if (!apiKey) { return null; }

        const symbolName  = document.getText(wordRange);
        const offset      = document.offsetAt(position);
        const ctxStart    = document.positionAt(Math.max(0, offset - 600));
        const ctxEnd      = document.positionAt(Math.min(document.getText().length, offset + 300));
        const surrounding = document.getText(new vscode.Range(ctxStart, ctxEnd));
        const model       = config.get<string>('model', 'deepseek/deepseek-v4-flash');

        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());

        try {
            const { name } = await fetchRenameSuggestion(
                apiKey, model, document.languageId, symbolName, surrounding, abort.signal
            );
            return { range: wordRange, placeholder: name };
        } catch {
            // Fall back to default VS Code rename behaviour
            return null;
        }
    }

    provideRenameEdits(): vscode.ProviderResult<vscode.WorkspaceEdit> {
        // We let VS Code's built-in LSP rename handle the actual edits.
        // Returning null here tells VS Code to proceed with its own rename after prepareRename pre-fills.
        return null;
    }
}
