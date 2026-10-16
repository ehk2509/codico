/**
 * Whether an agent turn is still getting anywhere. Progress is a successful code change, or a
 * check (test, build, type-check, lint) whose result is new: a command not run before, or a
 * different outcome than its last run. Steps that only read, search, re-run checks with the same
 * result or re-record criteria are not progress. Counted only once the code has changed, so the
 * exploration before the first edit is never cut short.
 */
import { checkKey, classifyCheck, testSummary } from './patchPassport';

/** Steps without progress, after the first change, before the turn is stopped. */
export const MAX_STEPS_WITHOUT_PROGRESS = 20;

export interface StepTool { type: string; command?: string; result: string }

const CHANGED = /^\[(?:write_file|edit_file)[^\]]*\]\s+(?:Written successfully|Edit applied successfully)/m;

/** The outcome of a check run, as text: its test counts, or its exit status. */
function outcome(result: string): string {
    const summary = testSummary(result);
    if (summary) { return `${summary.passed}/${summary.failed}`; }
    return /^Exit:\s*(\S+)/m.exec(result)?.[1] ?? /timed out/i.exec(result)?.[0] ?? '?';
}

export class ProgressTracker {
    private _changed = false;
    private _idle = 0;
    private readonly _checks = new Map<string, string>();

    /** One step's tool calls and their results. */
    step(tools: StepTool[]): void {
        let progress = false;
        for (const tool of tools) {
            if ((tool.type === 'write_file' || tool.type === 'edit_file') && CHANGED.test(tool.result)) { progress = true; this._changed = true; continue; }
            if (tool.type !== 'run_terminal' || !tool.command || !classifyCheck(tool.command)) { continue; }
            const key = checkKey(tool.command);
            const now = outcome(tool.result);
            if (this._checks.get(key) !== now) { progress = true; }
            this._checks.set(key, now);
        }
        this._idle = progress || !this._changed ? 0 : this._idle + 1;
    }

    /** Steps in a row without progress since the code first changed. */
    get idleSteps(): number { return this._idle; }

    stalled(limit = MAX_STEPS_WITHOUT_PROGRESS): boolean { return this._changed && this._idle >= limit; }
}
