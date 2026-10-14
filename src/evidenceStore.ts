import * as fs from 'fs';
import * as path from 'path';
import { animatedPng } from './apng';

export const EVIDENCE_DIR = path.join('.codico', 'evidence');
/** Screenshots kept per task, oldest dropped from the replay first. */
export const MAX_FRAMES = 60;

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'step';

/**
 * The evidence of one task, saved in the project where the user can open it:
 * `.codico/evidence/<when>/` with each screenshot, `replay.png` (the screenshots in order,
 * animated) and `report.md`. The folder is made on the first screenshot; git ignores it.
 */
export class EvidenceStore {
    private _folder: string | undefined;
    private _frames: string[] = [];
    private _count = 0;

    constructor(private readonly _root: string | undefined, private readonly _name: string = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)) {}

    /** The folder relative to the project, once something was saved. */
    get folder(): string | undefined { return this._folder ? path.join(EVIDENCE_DIR, this._name).split(path.sep).join('/') : undefined; }

    private _ensure(): string | undefined {
        if (!this._root) { return undefined; }
        if (!this._folder) {
            const base = path.join(this._root, EVIDENCE_DIR);
            fs.mkdirSync(path.join(base, this._name), { recursive: true });
            // Evidence is for looking at, not for committing
            const ignore = path.join(base, '.gitignore');
            if (!fs.existsSync(ignore)) { fs.writeFileSync(ignore, '*\n'); }
            this._folder = path.join(base, this._name);
        }
        return this._folder;
    }

    /** Saves a screenshot; returns its path relative to the project. */
    screenshot(png: Buffer, label: string): string | undefined {
        try {
            const folder = this._ensure();
            if (!folder) { return undefined; }
            const name = `${String(++this._count).padStart(2, '0')}-${slug(label)}.png`;
            fs.writeFileSync(path.join(folder, name), png);
            this._frames.push(name);
            if (this._frames.length > MAX_FRAMES) { this._frames.shift(); }
            return `${this.folder}/${name}`;
        } catch { return undefined; }
    }

    /** Writes the report and the replay, when there is anything to show. */
    finish(reportMarkdown: string): void {
        try {
            const folder = this._folder ?? (reportMarkdown ? this._ensure() : undefined);
            if (!folder) { return; }
            fs.writeFileSync(path.join(folder, 'report.md'), reportMarkdown);
            const frames = this._frames.map(name => fs.readFileSync(path.join(folder, name)));
            const replay = frames.length > 1 ? animatedPng(frames) : undefined;
            if (replay) { fs.writeFileSync(path.join(folder, 'replay.png'), replay); }
        } catch { /* evidence is a convenience: the report in the chat stands without it */ }
    }
}
