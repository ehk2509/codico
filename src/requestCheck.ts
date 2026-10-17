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
    // A check that failed earlier in the turn (or that Codico saw fail without the change) and passes now: the problem was seen, then fixed
    const reproduced = passport.checks.some(check => check.fixed);
    if (stated && reproduced) { return undefined; }
    const passesAnyway = passport.checks.filter(check => check.withoutChange === 'passed').map(check => `\`${check.command}\``);
    return '[System Acceptance] Before you finish, show that the request itself is met, not a version of it:\n' +
        (stated ? '' : '- State its acceptance criteria in the request\'s own words (acceptance criteria): what the user asked for, not what your change does.\n') +
        (reproduced ? '' : '- Show it on the user\'s own case: a test of exactly the scenario they described, which fails without your change and passes with it. ' +
            (passesAnyway.length ? `Codico ran ${passesAnyway.join(', ')} with your changes undone (your tests kept), and it still passed: it does not show the problem.\n`
                : 'Codico reruns your passing test with your source changes undone, so you do not need to undo them yourself; it could not show a failure without your change.\n')) +
        '- If you replaced the requested behavior with something else (a new syntax, option or mode that callers must switch to), the request is not met: fix it as asked, or say plainly what you did instead.';
}
