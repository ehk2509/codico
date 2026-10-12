import * as vscode from 'vscode';
import { buildSymbolContext } from './symbolProvider';
import { buildWorkspaceDiagnosticsSummary } from './workspaceDiagnostics';
import { isWorkspaceUriAllowed } from './workspaceSecurity';
import { openTabsBlock } from './leanContext';

/** The [Context] block sent with each message: workspace, active file and selection, problems, names of the other open tabs, symbol under the cursor. */
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

    // The other open tabs, as names: their contents are read when the task needs them. A tab that
    // happens to be open (a lock file, a credentials file) is not sent to the model with every message.
    if (config.get<boolean>('openTabsContext', true)) {
        const activeUri = editor?.document.uri.toString();
        const tabs: Array<{ path: string; language?: string; lines?: number }> = [];
        const seen = new Set<string>();
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const uri = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
                if (!uri || uri.scheme !== 'file' || uri.toString() === activeUri || seen.has(uri.toString())) { continue; }
                seen.add(uri.toString());
                // Not a file the agent could read itself (outside the workspace, or excluded by .codicoignore): not named either
                if (!vscode.workspace.getWorkspaceFolder(uri) || !await isWorkspaceUriAllowed(uri)) { continue; }
                const open = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
                tabs.push({ path: vscode.workspace.asRelativePath(uri, false), language: open?.languageId, lines: open?.lineCount });
            }
        }
        const block = openTabsBlock(tabs);
        if (block) { parts.push(block); }
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
