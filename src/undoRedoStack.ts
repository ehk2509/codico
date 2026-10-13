import * as vscode from 'vscode';
import { readCurrentBytes, revealFile, sameBytes, writeCurrentBytes } from './workspaceText';

/** A before/after snapshot of a single file mutation. */
export interface FileSnapshot {
    /** Path as shown to the user. */
    filepath: string;
    /** The resolved file (the path may be absolute or name another workspace folder). */
    uri: vscode.Uri;
    /** File contents before the change. `null` means the file did not exist. */
    before: Uint8Array | null;
    /** File contents after the change. */
    after: Uint8Array;
    /** Short label shown in notifications. */
    label: string;
    /** The turn of the conversation the change was made in (stamped by the stack). */
    turnId?: string;
}

/** One file that rewinding would put back, and whether it is still as Codico left it. */
export interface RewindFile { filepath: string; uri: vscode.Uri; restoreTo: Uint8Array | null; expected: Uint8Array; changes: number }

/** What rewinding a set of turns would do to the files. */
export interface RewindPlan {
    files: RewindFile[];
    /** Some changes of these turns are no longer recorded (the record keeps the newest changes only). */
    incomplete: boolean;
}

/** What a rewind did: the files put back, and the ones the user kept because they had changed since. */
export interface RewindResult { restored: string[]; kept: string[] }

/** Asks the user whether to overwrite a file that changed since Codico wrote it. */
export type ConfirmOverwrite = (message: string) => Promise<boolean>;

/** Result of undo/redo: `applied` is false when the user kept a file that had changed since. */
export interface UndoRedoResult { filepath: string; applied: boolean }

export class UndoRedoStack {
    constructor(private readonly _confirm: ConfirmOverwrite) {}

    private _undo: FileSnapshot[] = [];
    private _redo: FileSnapshot[] = [];
    private readonly _max = 300;
    private _opInProgress = false;
    /** The turn in progress: every change recorded from now on belongs to it. */
    public turn: string | undefined;
    /** Turns that lost a change to the size limit: their files cannot be fully put back. */
    private readonly _truncatedTurns = new Set<string>();

    /** Record a mutation. Clears the redo stack. */
    push(snap: FileSnapshot): void {
        this._undo.push({ ...snap, turnId: snap.turnId ?? this.turn });
        if (this._undo.length > this._max) {
            const dropped = this._undo.shift();
            if (dropped?.turnId) { this._truncatedTurns.add(dropped.turnId); }
        }
        this._redo = [];
    }

    /** The files changed during these turns, each with the content it had before the first of them. */
    planRewind(turnIds: readonly string[]): RewindPlan {
        const turns = new Set(turnIds);
        const files = new Map<string, RewindFile>();
        for (const snap of this._undo) {
            if (!snap.turnId || !turns.has(snap.turnId)) { continue; }
            const known = files.get(snap.uri.toString());
            if (known) { known.expected = snap.after; known.changes++; }
            else { files.set(snap.uri.toString(), { filepath: snap.filepath, uri: snap.uri, restoreTo: snap.before, expected: snap.after, changes: 1 }); }
        }
        return { files: [...files.values()], incomplete: turnIds.some(id => this._truncatedTurns.has(id)) };
    }

    /**
     * Puts back every file changed during these turns. A file that is no longer as Codico left it
     * is only overwritten if the user agrees. The changes put back can be reapplied with Redo.
     */
    async rewind(turnIds: readonly string[]): Promise<RewindResult> {
        const result: RewindResult = { restored: [], kept: [] };
        if (this._opInProgress) { return result; }
        this._opInProgress = true;
        try {
            const turns = new Set(turnIds);
            const keptFiles = new Set<string>();
            for (const file of this.planRewind(turnIds).files) {
                const current = await readCurrentBytes(file.uri);
                // Already as it was (undone by hand, for example): nothing to write or to ask
                if (sameBytes(current, file.restoreTo)) { result.restored.push(file.filepath); continue; }
                if (!sameBytes(current, file.expected) &&
                    !await this._confirm(`${file.filepath} has changed since Codico last changed it. Put back the earlier version anyway and lose those changes?`)) {
                    result.kept.push(file.filepath);
                    keptFiles.add(file.uri.toString());
                    continue;
                }
                await this._apply(file.uri, file.restoreTo, false);
                result.restored.push(file.filepath);
            }
            const undone = this._undo.filter(snap => !!snap.turnId && turns.has(snap.turnId));
            this._undo = this._undo.filter(snap => !undone.includes(snap));
            // Newest first, so that Redo reapplies them oldest first; a kept file's changes are not offered again
            this._redo = undone.filter(snap => !keptFiles.has(snap.uri.toString())).reverse();
            return result;
        } finally {
            this._opInProgress = false;
        }
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
            const uri = snap.uri;
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

    /** Drops what was recorded for these turns without touching any file (the files were restored another way). */
    forget(turnIds: readonly string[]): void {
        const turns = new Set(turnIds);
        this._undo = this._undo.filter(snap => !snap.turnId || !turns.has(snap.turnId));
        this._redo = [];
    }

    /** The newest recorded change to a file that can still be undone. */
    latestFor(uri: vscode.Uri): FileSnapshot | undefined {
        const key = uri.toString();
        for (let i = this._undo.length - 1; i >= 0; i--) {
            if (this._undo[i].uri.toString() === key) { return this._undo[i]; }
        }
        return undefined;
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

    private async _apply(uri: vscode.Uri, content: Uint8Array | null, reveal = true): Promise<void> {
        if (content === null) {
            // File did not exist before — delete the current version
            try { await vscode.workspace.fs.delete(uri); } catch { /* already gone */ }
        } else {
            await writeCurrentBytes(uri, content);
            if (reveal) { await revealFile(uri); }
        }
    }
}
