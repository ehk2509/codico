/**
 * Whether a turn that changed code has shown that the request itself is met, and if not,
 * what to ask for before the reply may end. A change can pass its own checks and still not be
 * what was asked: a test written for a variant of the problem, or the requested behavior
 * replaced by something else (a new syntax or mode callers must switch to).
 */
import { isDocumentationFile } from './agentEfficiency';
import { PatchPassport } from './patchPassport';

export function requestCheckGuidance(passport: PatchPassport | undefined): string | undefined {
    const code = passport?.files.filter(file => !isDocumentationFile(file.path)) ?? [];
    if (!passport || code.length === 0) { return undefined; }
    const stated = (passport.acceptance?.criteria.length ?? 0) > 0;
    // A check that failed earlier in the turn and passes now: the problem was seen, then fixed
    const reproduced = passport.checks.some(check => check.fixed);
    if (stated && reproduced) { return undefined; }
    return '[System Acceptance] Before you finish, show that the request itself is met, not a version of it:\n' +
        (stated ? '' : '- State its acceptance criteria in the request\'s own words (acceptance criteria): what the user asked for, not what your change does.\n') +
        (reproduced ? '' : '- Show it on the user\'s own case: a test of exactly the scenario they described, which fails without your change and passes with it. If no check of yours failed before your change, you have not shown the problem was reproduced.\n') +
        '- If you replaced the requested behavior with something else (a new syntax, option or mode that callers must switch to), the request is not met: fix it as asked, or say plainly what you did instead.';
}

/** The largest source change (lines added and removed) whose review may be skipped. */
export const TRIVIAL_CHANGE_LINES = 20;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go)$|(^|\/)test_[^/]*\.py$/;

/**
 * A change the independent review would add little to: small (at most TRIVIAL_CHANGE_LINES source
 * lines, tests and docs aside), every criterion verified, each on a check that failed before the
 * change and passes after it (the failure reproduced, then fixed).
 */
export function triviallyCovered(passport: PatchPassport | undefined): boolean {
    const acceptance = passport?.acceptance;
    if (!passport || !acceptance || acceptance.criteria.length === 0 || acceptance.criteria.some(c => c.status !== 'verified')) { return false; }
    const source = passport.files.filter(f => !isDocumentationFile(f.path) && !TEST_FILE.test(f.path.replace(/\\/g, '/')));
    const lines = source.reduce((n, f) => n + f.added + f.removed, 0);
    const fixed = new Set(passport.checks.filter(c => c.fixed && !c.stale).map(c => `${c.kind}: ${c.command}`));
    return lines <= TRIVIAL_CHANGE_LINES && acceptance.criteria.every(c => c.evidence.some(e => e.kind === 'check' && fixed.has(e.description)));
}
