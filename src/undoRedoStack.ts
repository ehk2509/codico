import * as vscode from 'vscode';

/** A before/after snapshot of a single file mutation. */
export interface FileSnapshot {
    /** Workspace-relative path (forward slashes). */
    filepath: string;
    /** File contents before the change. `null` means the file did not exist. */
    before: Uint8Array | null;
    /** File contents after the change. */
    after: Uint8Array;
    /** Short label shown in notifications. */
    label: string;
}

export class UndoRedoStack {
    private _undo: FileSnapshot[] = [];
    private _redo: FileSnapshot[] = [];
    private readonly _max = 50;
    private _opInProgress = false;

    /** Record a mutation. Clears the redo stack. */
    push(snap: FileSnapshot): void {
        this._undo.push(snap);
        if (this._undo.length > this._max) { this._undo.shift(); }
        this._redo = [];
    }

    /** Undo the most recent mutation. Returns the filepath restored, or undefined if nothing to undo. */
    async undo(): Promise<string | undefined> {
        if (this._opInProgress) { return undefined; }
        this._opInProgress = true;
        try {
            const snap = this._undo.pop();
            if (!snap) { return undefined; }
            await this._apply(snap.filepath, snap.before);
            this._redo.push(snap);
            return snap.filepath;
        } finally {
            this._opInProgress = false;
        }
    }

    /** Redo the most recently undone mutation. Returns the filepath restored, or undefined. */
    async redo(): Promise<string | undefined> {
        if (this._opInProgress) { return undefined; }
        this._opInProgress = true;
        try {
            const snap = this._redo.pop();
            if (!snap) { return undefined; }
            await this._apply(snap.filepath, snap.after);
            this._undo.push(snap);
            return snap.filepath;
        } finally {
            this._opInProgress = false;
        }
    }

    get canUndo(): boolean { return this._undo.length > 0; }
    get canRedo(): boolean { return this._redo.length > 0; }
    get undoLabel(): string | undefined { return this._undo.at(-1)?.label; }
    get redoLabel(): string | undefined { return this._redo.at(-1)?.label; }

    /** State snapshot for the webview UI. */
    get state(): { canUndo: boolean; canRedo: boolean; undoLabel?: string; redoLabel?: string } {
        return {
            canUndo: this.canUndo,
            canRedo: this.canRedo,
            undoLabel: this.undoLabel,
            redoLabel: this.redoLabel,
        };
    }

    private async _apply(relPath: string, content: Uint8Array | null): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.length) { throw new Error('No workspace folder open'); }
        const uri = vscode.Uri.joinPath(folders[0].uri, relPath);
        if (content === null) {
            // File did not exist before — delete the current version
            try { await vscode.workspace.fs.delete(uri); } catch { /* already gone */ }
        } else {
            // Restore parent dirs and write
            const dirUri = vscode.Uri.joinPath(uri, '..');
            await vscode.workspace.fs.createDirectory(dirUri);
            await vscode.workspace.fs.writeFile(uri, content);
            // Show the restored file
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, { preview: true });
            } catch { /* ignore */ }
        }
    }
}
