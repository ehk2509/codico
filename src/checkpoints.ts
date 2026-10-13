import * as path from 'path';
import { ChangedFile, changesBetween, deleteSnapshots, keepSnapshot, keptSnapshot, pruneSnapshots, restoreSnapshot, snapshotExists, takeSnapshot } from './checkpointGit';

/** A checkpoint: for each workspace folder, the snapshot of it taken when a message was sent. */
export type Checkpoint = Record<string, string>;

export interface FolderRestore { folder: string; target: string; now: string; changes: ChangedFile[] }

/** What going back to a checkpoint would do, worked out before anything is touched. */
export interface RestorePlan { folders: FolderRestore[]; files: number }

const BEFORE_REWIND = 'before-rewind';

/**
 * Checkpoints of the workspace, one per message, that outlive the session. Operations run
 * one after another: two snapshots of one folder at the same time would fight over its index.
 */
export class CheckpointService {
    /** Resolves when the checkpoint of the turn in progress has been taken. A tool that changes files waits for it. */
    public ready: Promise<unknown> = Promise.resolve();
    private _queue: Promise<unknown> = Promise.resolve();

    /**
     * @param _storageRoot where the snapshot repositories are kept (outside every project)
     * @param _folders the workspace folders, as absolute paths
     * @param _enabled false when the user turned checkpoints off
     */
    /** @param _retentionDays how long a checkpoint is kept; 0 keeps them until they are cleared */
    constructor(private readonly _storageRoot: string, private readonly _folders: () => string[], private readonly _enabled: () => boolean = () => true, private readonly _retentionDays: () => number = () => 0) {}
    /** Folders whose old checkpoints were already dropped in this session. */
    private readonly _pruned = new Set<string>();

    private _next<T>(work: () => Promise<T>): Promise<T> {
        const result = this._queue.then(work, work);
        this._queue = result.catch(() => undefined);
        return result;
    }

    /** Records every workspace folder as it is now. Undefined when there is nothing to record or git is not available. */
    begin(label: string): Promise<Checkpoint | undefined> {
        const taken = this._next(async () => {
            if (!this._enabled()) { return undefined; }
            const checkpoint: Checkpoint = {};
            for (const folder of this._folders()) {
                // Once per session: what is past its keep-until date goes before more is added
                if (!this._pruned.has(folder)) { this._pruned.add(folder); await pruneSnapshots(this._storageRoot, folder, this._retentionDays()); }
                const snapshot = await takeSnapshot(this._storageRoot, folder, label);
                if (snapshot) { checkpoint[folder] = snapshot; }
            }
            return Object.keys(checkpoint).length > 0 ? checkpoint : undefined;
        });
        this.ready = taken.catch(() => undefined);
        return taken;
    }

    /**
     * Works out what returning to a checkpoint would change. The present state is recorded
     * first, which is also what makes the return undoable. Undefined when the checkpoint
     * can no longer be used (its snapshots are gone, or its folders are no longer open).
     */
    plan(checkpoint: Checkpoint | undefined): Promise<RestorePlan | undefined> {
        return this._next(async () => {
            if (!checkpoint || !this._enabled()) { return undefined; }
            const open = new Set(this._folders());
            const folders: FolderRestore[] = [];
            for (const [folder, target] of Object.entries(checkpoint)) {
                if (!open.has(folder) || !await snapshotExists(this._storageRoot, folder, target)) { continue; }
                const now = await takeSnapshot(this._storageRoot, folder, 'before rewind');
                if (!now) { continue; }
                folders.push({ folder, target, now, changes: await changesBetween(this._storageRoot, folder, target, now) });
            }
            if (folders.length === 0) { return undefined; }
            return { folders, files: folders.reduce((sum, item) => sum + item.changes.length, 0) };
        });
    }

    /** Puts every folder of the plan back to its checkpoint. The state it leaves is kept for `undoLast`. */
    restore(plan: RestorePlan): Promise<{ restored: number; errors: string[] }> {
        return this._next(async () => {
            let restored = 0; const errors: string[] = [];
            for (const item of plan.folders) {
                if (item.changes.length === 0) { continue; }
                await keepSnapshot(this._storageRoot, item.folder, BEFORE_REWIND, item.now);
                const result = await restoreSnapshot(this._storageRoot, item.folder, item.target);
                if (result.error) { errors.push(`${path.basename(item.folder)}: ${result.error}`); } else { restored += item.changes.length; }
            }
            return { restored, errors };
        });
    }

    /** Returns the files to what they were just before the last rewind. Doing it twice undoes the undo. */
    undoLast(): Promise<{ restored: number; errors: string[] } | undefined> {
        return this._next(async () => {
            let found = false; let restored = 0; const errors: string[] = [];
            for (const folder of this._folders()) {
                const before = await keptSnapshot(this._storageRoot, folder, BEFORE_REWIND);
                if (!before) { continue; }
                found = true;
                const now = await takeSnapshot(this._storageRoot, folder, 'before undoing a rewind');
                if (!now) { errors.push(`${path.basename(folder)}: the present state could not be recorded, so nothing was changed`); continue; }
                const changes = await changesBetween(this._storageRoot, folder, before, now);
                await keepSnapshot(this._storageRoot, folder, BEFORE_REWIND, now);
                const result = await restoreSnapshot(this._storageRoot, folder, before);
                if (result.error) { errors.push(`${path.basename(folder)}: ${result.error}`); } else { restored += changes.length; }
            }
            return found ? { restored, errors } : undefined;
        });
    }

    /** Deletes every checkpoint of the open folders. Messages keep their place in the conversation; their files can no longer be restored. */
    clear(): Promise<void> {
        return this._next(async () => { for (const folder of this._folders()) { await deleteSnapshots(this._storageRoot, folder); } });
    }
}

/** What the user is told before a rewind through checkpoints: every file that changes, whoever changed it. */
export function restoreSummary(plan: RestorePlan, turns: number): { message: string; detail: string } {
    const message = `Rewind to before this message? ${turns === 1 ? 'It and its reply are' : `${turns} messages and their replies are`} removed from the conversation.`;
    const lines: string[] = [];
    if (plan.files === 0) {
        lines.push('The files are already as they were then, so no file is touched.');
    } else {
        lines.push(`${plan.files === 1 ? '1 file returns' : `${plan.files} files return`} to what ${plan.files === 1 ? 'it was' : 'they were'} when the message was sent:`);
        const many = plan.folders.length > 1;
        const all = plan.folders.flatMap(item => item.changes.map(change => ({ ...change, shown: many ? `${path.basename(item.folder)}/${change.path}` : change.path })));
        for (const change of all.slice(0, 14)) {
            lines.push(`    ${change.shown}${change.status === 'added' ? '  (created since: deleted)' : change.status === 'deleted' ? '  (deleted since: restored)' : ''}`);
        }
        if (all.length > 14) { lines.push(`    … and ${all.length - 14} more`); }
        lines.push('', 'This covers every change since then: by Codico, by terminal commands, and by you. "Codico: Undo Last Rewind" brings the present state back.');
    }
    lines.push('', 'Not covered: files your .gitignore excludes (dependencies, build output), and files that hold credentials, such as .env and key files.');
    return { message, detail: lines.join('\n') };
}

export function restoreOutcome(result: { restored: number; errors: string[] }): string {
    const files = result.restored === 0 ? 'no file changed' : `${result.restored} file${result.restored === 1 ? '' : 's'} put back`;
    return `Codico: conversation rewound, ${files}${result.errors.length ? `; not restored: ${result.errors.join('; ')}` : ''}`;
}
