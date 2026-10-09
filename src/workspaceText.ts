import * as vscode from 'vscode';

/**
 * File access that respects the editor. A file open with unsaved changes is read
 * from its editor buffer and written through it (then saved), so the agent never
 * works on a stale disk copy and saving never ends in a "file is newer" conflict.
 */

function dirtyDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
    const key = uri.toString();
    return vscode.workspace.textDocuments.find(d => !d.isClosed && d.isDirty && d.uri.toString() === key);
}

/** Current bytes of the file (unsaved editor changes included), or null if it does not exist. */
export async function readCurrentBytes(uri: vscode.Uri): Promise<Uint8Array | null> {
    const doc = dirtyDocument(uri);
    if (doc) { return new TextEncoder().encode(doc.getText()); }
    try {
        return await vscode.workspace.fs.readFile(uri);
    } catch (err) {
        if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') { return null; }
        throw err;
    }
}

/** Current text of the file; throws if it does not exist. */
export async function readCurrentText(uri: vscode.Uri): Promise<string> {
    const doc = dirtyDocument(uri);
    if (doc) { return doc.getText(); }
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

/** Writes the file; an editor with unsaved changes is updated and saved instead. */
export async function writeCurrentBytes(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const doc = dirtyDocument(uri);
    if (doc) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), new TextDecoder().decode(content));
        if (await vscode.workspace.applyEdit(edit) && await doc.save()) { return; }
        throw new Error('Could not update the file open in the editor');
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, content);
}

export function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
    if (a === null || b === null) { return a === b; }
    if (a.length !== b.length) { return false; }
    for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
    return true;
}

/** Shows the file; best-effort (some files cannot be opened as text, and the write already happened). */
export async function revealFile(uri: vscode.Uri): Promise<void> {
    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true });
    } catch { /* display only */ }
}
