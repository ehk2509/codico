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
        '- Where the request gives an example (an input and what it must produce), test that very input through the code the user calls (the tool, command or public function, not a helper behind it) and check the stated output.\n' +
        '- Where the request says a value is normalized (cleaned, trimmed, formatted), it is normalized at every entry point the request names, each form it accepts and the code callers use, not at one of them only.\n' +
        '- If you replaced the requested behavior with something else (a new syntax, option or mode that callers must switch to), the request is not met: fix it as asked, or say plainly what you did instead.';
}
