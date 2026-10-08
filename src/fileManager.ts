import * as vscode from 'vscode';
import { resolveWorkspaceToolPath } from './workspaceSecurity';

export class FileManager {
    async writeFile(filepath: string, content: string): Promise<void> {
        const target = await resolveWorkspaceToolPath(filepath);

        const dirUri = vscode.Uri.joinPath(target.uri, '..');
        await vscode.workspace.fs.createDirectory(dirUri);

        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(target.uri, encoder.encode(content));

        const doc = await vscode.workspace.openTextDocument(target.uri);
        await vscode.window.showTextDocument(doc, { preview: true });
    }
}
