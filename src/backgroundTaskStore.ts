import * as fs from 'fs';
import * as path from 'path';
import { BackgroundTask, parseTask } from './backgroundTasks';

/**
 * Background tasks on disk, one small file each, in a folder every window of the editor
 * shares. A file is used because windows do not see each other's in-memory state: the
 * window that starts a task and the window that runs it only meet here.
 */
export class BackgroundTaskStore {
    constructor(private readonly _dir: string) {}

    private _file(id: string): string { return path.join(this._dir, `${id}.json`); }

    async all(): Promise<BackgroundTask[]> {
        let names: string[];
        try { names = await fs.promises.readdir(this._dir); } catch { return []; }
        const tasks: BackgroundTask[] = [];
        for (const name of names) {
            if (!name.endsWith('.json')) { continue; }
            try {
                const task = parseTask(await fs.promises.readFile(path.join(this._dir, name), 'utf8'));
                if (task && `${task.id}.json` === name) { tasks.push(task); }
            } catch { /* being written or removed by another window: next read has it */ }
        }
        return tasks.sort((a, b) => b.createdAt - a.createdAt);
    }

    async get(id: string): Promise<BackgroundTask | undefined> {
        try { return parseTask(await fs.promises.readFile(this._file(id), 'utf8')); } catch { return undefined; }
    }

    /** Written whole and moved into place, so another window never reads half a file. */
    async save(task: BackgroundTask): Promise<void> {
        await fs.promises.mkdir(this._dir, { recursive: true });
        const temporary = `${this._file(task.id)}.${process.pid}.tmp`;
        await fs.promises.writeFile(temporary, JSON.stringify(task, null, 2), { mode: 0o600 });
        await fs.promises.rename(temporary, this._file(task.id));
    }

    /** Changes a task that is still there; a task removed meanwhile (discarded) stays removed. */
    async update(id: string, change: Partial<BackgroundTask>): Promise<BackgroundTask | undefined> {
        const task = await this.get(id);
        if (!task) { return undefined; }
        const next = { ...task, ...change, id: task.id, updatedAt: Date.now() };
        await this.save(next);
        return next;
    }

    async remove(id: string): Promise<void> {
        try { await fs.promises.unlink(this._file(id)); } catch { /* already gone */ }
        try { await fs.promises.unlink(this.historyFile(id)); } catch { /* none was kept */ }
    }

    /** Where the conversation of a task run in the window that started it is kept, so it can be resumed later. */
    historyFile(id: string): string { return path.join(this._dir, `${id}.history`); }
}
