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

You changed code. Do not declare success until the change is verified.
Start with the edited component, but follow callers, consumers, shared abstractions, sibling implementations, or tests when needed to prove correctness. Discovery remains available for that purpose.

Before finishing:
- review any [Local invariant audit] attached to the edit result;
- check requested behavior and every preservation / negative constraint;
- identify normal success, completion, terminal, cancellation, and no-op paths that must remain unchanged when relevant;
- prefer verifying the owning abstraction instead of only the edited call site;
- run the narrowest relevant test, build, lint, or diagnostics command;
- if verification exposes a gap, revise and verify again.`;

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
        return `${SYSTEM_PROMPT}\n\n${POST_EDIT_VERIFICATION_PROMPT}${target}${contract}`;
    }

    if (explorationLocked) {
        return `${SYSTEM_PROMPT}\n\n${ACTION_PHASE_SYSTEM_PROMPT}${contract}`;
    }

    return undefined;
}
