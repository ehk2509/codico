import * as vscode from 'vscode';
import * as path from 'path';

export class FileManager {
    /**
     * No-op — permission is now requested inline in the chat webview.
     * Always returns true; the caller is responsible for gating on user response.
     */
    async requestPermission(_filepath: string, _content: string): Promise<boolean> {
        return true;
    }

    /**
     * Writes `content` to `filepath` (relative to the first workspace folder).
     * Creates intermediate directories if needed, then opens the file in the editor.
     */
    async writeFile(filepath: string, content: string): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            throw new Error('No workspace folder is open. Please open a folder first.');
        }

        // Prevent path traversal: normalize and ensure it stays inside the workspace
        const normalized = path.posix.normalize(filepath.replace(/\\/g, '/'));
        if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
            throw new Error(`Unsafe file path rejected: "${filepath}"`);
        }

        const rootUri = folders[0].uri;
        const fileUri = vscode.Uri.joinPath(rootUri, normalized);

        // Ensure parent directories exist
        const dirUri = vscode.Uri.joinPath(fileUri, '..');
        await vscode.workspace.fs.createDirectory(dirUri);

        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(fileUri, encoder.encode(content));

        // Open the written file so the user sees it
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: true });
    }
}
