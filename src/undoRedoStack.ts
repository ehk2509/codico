import * as vscode from 'vscode';
import { readCurrentBytes, revealFile, sameBytes, writeCurrentBytes } from './workspaceText';

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

/** Asks the user whether to overwrite a file that changed since Codico wrote it. */
export type ConfirmOverwrite = (message: string) => Promise<boolean>;

/** Result of undo/redo: `applied` is false when the user kept a file that had changed since. */
export interface UndoRedoResult { filepath: string; applied: boolean }

export class UndoRedoStack {
    constructor(private readonly _confirm: ConfirmOverwrite) {}

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

    /** Undo the most recent mutation. Returns undefined if there is nothing to undo. */
    async undo(): Promise<UndoRedoResult | undefined> {
        return this._step(this._undo, this._redo, 'undo');
    }

    /** Redo the most recently undone mutation. Returns undefined if there is nothing to redo. */
    async redo(): Promise<UndoRedoResult | undefined> {
        return this._step(this._redo, this._undo, 'redo');
    }

    private async _step(from: FileSnapshot[], to: FileSnapshot[], kind: 'undo' | 'redo'): Promise<UndoRedoResult | undefined> {
        if (this._opInProgress) { return undefined; }
        this._opInProgress = true;
        try {
            const snap = from.at(-1);
            if (!snap) { return undefined; }
            const uri = this._uri(snap.filepath);
            // The file must still be as Codico left it; anything else (hand edits, other
            // tools) would be silently lost, so ask first
            const expected = kind === 'undo' ? snap.after : snap.before;
            if (!sameBytes(await readCurrentBytes(uri), expected) &&
                !await this._confirm(`${snap.filepath} has changed since Codico ${kind === 'undo' ? 'made' : 'undid'} this change. ${kind === 'undo' ? 'Undo' : 'Redo'} anyway and lose those changes?`)) {
                return { filepath: snap.filepath, applied: false };
            }
            from.pop();
            await this._apply(uri, kind === 'undo' ? snap.before : snap.after);
            to.push(snap);
            return { filepath: snap.filepath, applied: true };
        } finally {
            this._opInProgress = false;
        }
    }

    private _uri(relPath: string): vscode.Uri {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.length) { throw new Error('No workspace folder open'); }
        return vscode.Uri.joinPath(folders[0].uri, relPath);
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

    private async _apply(uri: vscode.Uri, content: Uint8Array | null): Promise<void> {
        if (content === null) {
            // File did not exist before — delete the current version
            try { await vscode.workspace.fs.delete(uri); } catch { /* already gone */ }
        } else {
            await writeCurrentBytes(uri, content);
            await revealFile(uri);
        }
    }
}
