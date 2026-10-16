/**
 * What the agent loop says to the model between steps to keep a turn going, efficient and honest,
 * each at most once per turn; and the stronger model a turn may be handed to.
 */
import { endsWithOfferOrQuestion } from './streamCompletion';

export const ASK_TO_FINISH = '[System] Your reply ends by offering to continue or asking how to proceed, but the request already asks for this work and Codico\'s check does not show it done. Do the remaining work now, the way the request asks. Ask only if the request truly leaves the choice open, and then say plainly what each option means.';
export const ASK_FOR_ANSWER = '[System] Your reply ended without any text. Give your final answer now: what you changed, how you checked it, and anything not done.';
export const BATCH_HINT = '[System] Each step re-sends the whole conversation. Reads and searches that do not depend on each other\'s results go together in one step: issue them all now.';

export class TurnNudges {
    private _askedToFinish = false;
    private _askedForAnswer = false;
    private _batchHintGiven = false;
    /** Steps in a row that made a single read or search, and nothing else. */
    private _singleReadSteps = 0;

    /** After a step: how many reads and other tools it ran. */
    stepDone(reads: number, others: number): void { this._singleReadSteps = reads === 1 && others === 0 ? this._singleReadSteps + 1 : 0; }

    /** For the first read of a step, after two single-read steps: a hint to append to its result (no extra step). */
    batchHint(readsThisStep: number): string {
        if (this._batchHintGiven || this._singleReadSteps < 2 || readsThisStep !== 1) { return ''; }
        this._batchHintGiven = true;
        return `\n\n${BATCH_HINT}`;
    }

    /** A reply that hands the decision back (an offer to go on, a question) while the requested work is not done. */
    askToFinish(reply: string, ranTools: boolean, unfinished: () => boolean): string | undefined {
        if (this._askedToFinish || !ranTools || !endsWithOfferOrQuestion(reply) || !unfinished()) { return undefined; }
        this._askedToFinish = true;
        return ASK_TO_FINISH;
    }

    /** Work was done but the reply ends without a word: the user would get no account of it. */
    askForAnswer(reply: string, ranTools: boolean): string | undefined {
        if (this._askedForAnswer || !ranTools || reply.trim()) { return undefined; }
        this._askedForAnswer = true;
        return ASK_FOR_ANSWER;
    }
}

/**
 * The stronger model a turn is handed to (codico.escalationModel, an OpenRouter model; off when
 * empty) when the reviewer disputes the request or the turn stops progressing. Once per turn.
 */
export class Escalation {
    model: string | undefined;

    constructor(private readonly _target: string, private readonly _current: string, private readonly _hasKey: boolean, private readonly _announce: (text: string) => void) {}

    escalate(why: string): boolean {
        const target = this._target.trim();
        if (this.model || !target || !this._hasKey || target === this._current) { return false; }
        this.model = target;
        this._announce(`\n\n> ⤴️ Handing the rest of this task to ${target}: ${why}\n\n`);
        return true;
    }
}
