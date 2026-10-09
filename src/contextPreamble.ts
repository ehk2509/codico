import * as vscode from 'vscode';
import { buildSymbolContext } from './symbolProvider';
import { buildWorkspaceDiagnosticsSummary } from './workspaceDiagnostics';

/** The [Context] block sent with each message: workspace, active file and selection, problems, open tabs, symbol under the cursor. */
export async function buildContextPreamble(): Promise<string> {
    const config = vscode.workspace.getConfiguration('codico');
    const parts: string[] = [];
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        parts.push(`Workspace: ${folders[0].uri.fsPath}`);
    }
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const relPath = vscode.workspace.asRelativePath(editor.document.uri);
        const lang = editor.document.languageId;
        const lines = editor.document.lineCount;
        parts.push(`Active file: ${relPath} (${lang}, ${lines} lines)`);
        if (!editor.selection.isEmpty) {
            const sel = editor.selection;
            const selText = editor.document.getText(editor.selection);
            const cap = 10_000;
            const truncated = selText.length > cap;
            parts.push(
                `Selected code (${relPath} lines ${sel.start.line + 1}–${sel.end.line + 1}):\n` +
                `\`\`\`${lang}\n${selText.slice(0, cap)}${truncated ? '\n… (truncated)' : ''}\n\`\`\``
            );
        }
    }

    // Auto-inject workspace diagnostics (all Problems panel errors/warnings)
    if (config.get<boolean>('autoInjectDiagnostics', true)) {
        const diagSummary = buildWorkspaceDiagnosticsSummary();
        if (diagSummary) { parts.push(diagSummary); }
    }

    // Inject open tabs context if enabled
    if (config.get<boolean>('openTabsContext', true)) {
        const activeUri = editor?.document.uri.toString();
        const candidateUris: vscode.Uri[] = [];
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (candidateUris.length >= 5) { break; }
                const input = tab.input as { uri?: vscode.Uri } | undefined;
                if (!input?.uri) { continue; }
                if (input.uri.toString() === activeUri) { continue; }
                candidateUris.push(input.uri);
            }
            if (candidateUris.length >= 5) { break; }
        }
        // Open all candidate tabs in parallel instead of sequentially
        const tabSnippets = (await Promise.all(
            candidateUris.map(async (uri) => {
                try {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const relPath = vscode.workspace.asRelativePath(uri);
                    const text = doc.getText();
                    return `// ${relPath}\n${text.slice(0, 5000)}${text.length > 5000 ? '\n… (truncated)' : ''}`;
                } catch { return null; }
            })
        )).filter((s): s is string => s !== null);
        if (tabSnippets.length > 0) {
            parts.push(`Open tabs (${tabSnippets.length}):\n${tabSnippets.join('\n\n')}`);
        }
    }

    // Symbol-aware context: LSP info for symbol under cursor
    if (editor && config.get<boolean>('symbolContextEnabled', true)) {
        try {
            const symCtx = await buildSymbolContext(editor.document, editor.selection.active);
            if (symCtx) { parts.push(symCtx); }
        } catch { /* LSP may not be ready */ }
    }

    return parts.length > 0 ? `[Context]\n${parts.join('\n')}` : '';
}
