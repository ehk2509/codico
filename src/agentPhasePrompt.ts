import { CHAT_SYSTEM_PROMPT, SYSTEM_PROMPT } from './openRouterClient';

/**
 * Strong action guidance after prolonged exploration. Discovery remains
 * available: the phase changes priority, not capabilities.
 */
export const ACTION_PHASE_SYSTEM_PROMPT = `## Current phase — act on the evidence

You have enough evidence to stop open-ended exploration.
Your next response should make the smallest evidence-backed code change unless one concrete missing fact is required for correctness.
If such a fact exists, inspect only that dependency/caller/invariant/test, then make the change immediately.

Discovery tools remain available, but they are an escape hatch for a named correctness gap—not a reason to keep surveying the repository.

After changing code:
1. verify the requested behavior;
2. verify every preservation or negative constraint;
3. run the narrowest meaningful test/build/diagnostics command;
4. revise if verification exposes a gap.`;

export const POST_EDIT_VERIFICATION_PROMPT = `## Current phase — satisfy the acceptance contract

You changed code. Do not declare success until the current edit is verified.
Keep mutation focus on the edited file until its local invariant is coherent. You may read callers, consumers, shared abstractions, sibling implementations, or tests when needed, but do not mutate siblings merely to broaden the fix before the current edit passes verification.

Before finishing or broadening:
- review any [Local invariant audit] attached to the edit result; treat its semantic-completion candidates as explicit proof obligations, not background context;
- re-read lifecycle/state control flow after mutation when requested and reconcile every normal success, completion, terminal, cancellation, error, and no-op path;
- check requested behavior and every preservation / negative constraint;
- prefer verifying the owning abstraction instead of only the edited call site;
- diagnostics, lint and compilation are static evidence; for lifecycle/state changes, run a behavior-level test-like command before considering the gate satisfied;
- if verification exposes a gap, revise this edit first and verify again.`;

export function systemPromptForAgentPhase(
    chatMode: boolean,
    explorationLocked: boolean,
    verificationPending: boolean,
    verificationFile?: string,
    taskContract = '',
    _verificationReadAllowed = true,
): string | undefined {
    if (chatMode) { return CHAT_SYSTEM_PROMPT; }

    const contract = taskContract ? `\n\n${taskContract}` : '';

    if (verificationPending) {
        const target = verificationFile ? `\nEdited file: \`${verificationFile}\`.` : '';
        const nextStep = _verificationReadAllowed
            ? '\nNext verification step: re-read the edited control flow once before relying on static checks.'
            : '\nThe post-edit control-flow read is complete; prefer a behavior-level test next.';
        return `${SYSTEM_PROMPT}\n\n${POST_EDIT_VERIFICATION_PROMPT}${target}${nextStep}${contract}`;
    }

    if (explorationLocked) {
        return `${SYSTEM_PROMPT}\n\n${ACTION_PHASE_SYSTEM_PROMPT}${contract}`;
    }

    return undefined;
}
