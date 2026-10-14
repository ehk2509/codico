import * as nodeCrypto from 'crypto';
import { ExtensionMessage } from './chatProtocol';

/** The user's answer to a file change: allowed or not, and possibly with the content they edited in the card. */
export interface WriteAnswer { granted: boolean; editedContent?: string }

/**
 * Questions the agent waits on: approving a file change, approving a command, and going on
 * past a token budget. The panel shows them; its answers come back here by id. Stopping the
 * turn answers every open question with no.
 */
export class Approvals {
    /** "Allow all" for the rest of the task, given on a card. */
    public allowAllWrites = false;
    public allowAllCommands = false;
    private readonly _writes = new Map<string, (answer: WriteAnswer) => void>();
    private readonly _commands = new Map<string, (granted: boolean) => void>();
    private _checkpoint: ((keepGoing: boolean) => void) | null = null;

    constructor(private readonly _post: (message: ExtensionMessage) => void) {}

    /** Asks to apply a file change, unless all changes are allowed for this task. */
    askWrite(request: { id: string; filepath: string; diff: string; editableContent: string }): Promise<WriteAnswer> {
        if (this.allowAllWrites) { return Promise.resolve({ granted: true }); }
        const permId = nodeCrypto.randomBytes(8).toString('hex');
        return new Promise<WriteAnswer>(resolve => {
            this._writes.set(permId, resolve);
            this._post({ type: 'writePermissionRequest', id: request.id, permId, filepath: request.filepath, preview: '', diff: request.diff, editableContent: request.editableContent });
        });
    }

    /** Asks to run a command; `card` builds the request the panel shows, given the question's id. */
    askCommand(card: (permId: string) => ExtensionMessage): Promise<boolean> {
        const permId = nodeCrypto.randomBytes(8).toString('hex');
        return new Promise<boolean>(resolve => {
            this._commands.set(permId, resolve);
            this._post(card(permId));
        });
    }

    /** Shows a Continue / Stop prompt; Stop, or the turn being stopped, is false. */
    async askCheckpoint(msgId: string, steps: number, signal: AbortSignal, reason?: string): Promise<boolean> {
        // An already-aborted signal never fires 'abort' again
        if (signal.aborted) { return false; }
        const keepGoing = await new Promise<boolean>(resolve => {
            this._checkpoint = resolve;
            signal.addEventListener('abort', () => resolve(false), { once: true });
            this._post({ type: 'checkpoint', id: msgId, steps, reason });
        });
        this._checkpoint = null;
        return keepGoing;
    }

    /** The panel's answer to a file-change card. `allowAll` also allows every later change of the task. */
    answerWrite(permId: string, answer: WriteAnswer, allowAll = false): void {
        if (allowAll) { this.allowAllWrites = true; }
        const resolve = this._writes.get(permId);
        if (resolve) { this._writes.delete(permId); resolve(answer); }
    }

    answerCommand(permId: string, granted: boolean, allowAll = false): void {
        if (allowAll) { this.allowAllCommands = true; }
        const resolve = this._commands.get(permId);
        if (resolve) { this._commands.delete(permId); resolve(granted); }
    }

    /** Whether a question with this id is waiting here: a team's workers each have their own. */
    has(permId: string): boolean { return this._writes.has(permId) || this._commands.has(permId); }

    answerCheckpoint(keepGoing: boolean): void {
        this._checkpoint?.(keepGoing);
        this._checkpoint = null;
    }

    /** Every open question answered with no, so that a stopped turn can end. */
    cancelAll(): void {
        for (const resolve of this._writes.values()) { resolve({ granted: false }); }
        this._writes.clear();
        for (const resolve of this._commands.values()) { resolve(false); }
        this._commands.clear();
        this.answerCheckpoint(false);
    }

    /** The ids of the questions waiting for an answer (tests). */
    get pending(): string[] { return [...this._writes.keys(), ...this._commands.keys()]; }
}
