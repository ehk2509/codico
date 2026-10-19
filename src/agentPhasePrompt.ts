import { ChatMessage, CHAT_SYSTEM_PROMPT, MUTATION_ONLY_SYSTEM_PROMPT, SYSTEM_PROMPT } from './openRouterClient';

/**
 * Strong action guidance after prolonged exploration. Discovery remains
 * available: the phase changes priority, not capabilities.
 */
export const ACTION_PHASE_SYSTEM_PROMPT = `## Current phase — act on the evidence

You have enough evidence to stop open-ended exploration.
Your next response should make the code change the request needs, in every place the request says it applies, unless one concrete missing fact is required for correctness.
If such a fact exists, inspect only that dependency/caller/invariant/test, then make the change immediately.

Discovery tools remain available, but they are an escape hatch for a named correctness gap—not a reason to keep surveying the repository.

After changing code:
1. verify the requested behavior;
2. verify every preservation or negative constraint;
3. run the narrowest meaningful test/build/diagnostics command;
4. revise if verification exposes a gap.`;

export const FOCUSED_ACTION_SYSTEM_PROMPT = `## Current phase — focused action

Broad repository discovery is complete. Do not restart searches, listings, symbol scans, fetches, or source-inspection shell commands such as grep/cat/find.
You already have enough evidence to choose the implementation area.

Only two focused evidence turns remain, and they must stay inside files you already identified:
- search_files is allowed only when glob is exactly one file that was already read; use it only to locate relevant line numbers;
- read_file is allowed only with explicit start_line/end_line on an identified file.

Repo-wide globs, listings, symbol scans, fetches, and source-inspection shell commands remain closed.
Do not use terminal commands to recover source context.
After at most those two locator/read turns, edit immediately. If edit_file misses, its result will include fresh nearby source context for the next edit.

Prefer edit_file or write_file now, then run the narrowest relevant verification command.

The goal is: existing evidence → exact-file locator → precise source range → code change → verification.`;

export const POST_EDIT_VERIFICATION_PROMPT = `## Current phase — satisfy the acceptance contract

You changed code. Do not declare success until every part of the request is done and verified.
Finish every part of the request, in every place the request says it applies (each form, path or caller it names). Read callers, consumers, shared abstractions, sibling implementations, or tests when needed. Change nothing the request does not call for.

Before finishing:
- review any [Local invariant audit] attached to the edit result; treat its semantic-completion candidates as explicit proof obligations, not background context;
- re-read lifecycle/state control flow after mutation when requested and reconcile every normal success, completion, terminal, cancellation, error, and no-op path;
- check requested behavior and every preservation / negative constraint;
- prefer verifying the owning abstraction instead of only the edited call site;
- for every named input form or public API, test the exact return value at that boundary. If a parser returns a raw value but the request requires normalization, fix the parser itself; a service normalizing it later does NOT verify that input form;
- inspect your own new assertions for the opposite of the requested behavior: a passing assertion of an unconverted input is evidence of an incomplete fix, not success;
- diagnostics, lint and compilation are static evidence; for lifecycle/state changes, run a behavior-level test-like command before considering the gate satisfied;
- if verification exposes a gap, revise this edit first and verify again.`;

export function systemPromptForAgentPhase(
    chatMode: boolean,
    explorationLocked: boolean,
    verificationPending: boolean,
    verificationFile?: string,
    taskContract = '',
    _verificationReadAllowed = true,
    focusedAction = false,
    focusedReadExhausted = false,
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

    if (focusedAction && focusedReadExhausted) {
        return `${MUTATION_ONLY_SYSTEM_PROMPT}${contract}`;
    }

    if (focusedAction) {
        return `${SYSTEM_PROMPT}\n\n${FOCUSED_ACTION_SYSTEM_PROMPT}${contract}`;
    }

    if (explorationLocked) {
        return `${SYSTEM_PROMPT}\n\n${ACTION_PHASE_SYSTEM_PROMPT}${contract}`;
    }

    return undefined;
}

/**
 * Splits a phase's prompt into the task's fixed system prompt and its phase guidance.
 * Changing the system prompt between requests would make every provider re-read the
 * whole conversation at full price; the guidance is sent after the conversation instead.
 */
export function splitPhasePrompt(prompt: string | undefined): { systemPrompt: string | undefined; phaseNote: string } {
    if (prompt?.startsWith(`${SYSTEM_PROMPT}\n\n`)) {
        return { systemPrompt: undefined, phaseNote: prompt.slice(SYSTEM_PROMPT.length).trim() };
    }
    return { systemPrompt: prompt, phaseNote: '' };
}

const CONTRACT_HEADING = '## Task acceptance contract';
const PHASE_RULES = [ACTION_PHASE_SYSTEM_PROMPT, FOCUSED_ACTION_SYSTEM_PROMPT, POST_EDIT_VERIFICATION_PROMPT];

/**
 * A phase note without what the conversation already holds. A task re-enters the same phase
 * many times (after every edit), and each note used to repeat the phase's rules and the whole
 * task contract: several thousand characters that are then resent with every later request.
 * A part is shortened only when the identical text is still in the history, so after a
 * compaction the next note is complete again.
 */
export function withoutRepeats(history: ChatMessage[], phaseNote: string): string {
    if (!phaseNote) { return phaseNote; }
    const earlier = history
        .filter(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('[System Phase]'))
        .map(message => message.content as string)
        .join('\n');
    if (!earlier) { return phaseNote; }

    const contractAt = phaseNote.indexOf(`\n\n${CONTRACT_HEADING}`);
    let guidance = contractAt >= 0 ? phaseNote.slice(0, contractAt) : phaseNote;
    let contract = contractAt >= 0 ? phaseNote.slice(contractAt + 2) : '';

    if (contract && earlier.includes(contract)) {
        contract = `${CONTRACT_HEADING}\n\nUnchanged: the task acceptance contract given earlier in this conversation still applies in full.`;
    }
    const rules = PHASE_RULES.find(known => guidance.startsWith(known) && earlier.includes(known));
    if (rules) {
        // The heading names the phase; what follows the rules (the edited file, the next step) is specific to this note
        guidance = `${rules.split('\n')[0]}\n\nThe rules of this phase are the same as in the earlier note for it; they still apply in full.${guidance.slice(rules.length)}`;
    }
    return contract ? `${guidance}\n\n${contract}` : guidance;
}

/**
 * Records a phase change in the conversation. It joins the newest message when that is a
 * plain user message not yet sent (roles keep alternating), and is otherwise added after it.
 * Earlier messages are never changed, so the provider's cached prefix stays valid.
 */
export function appendPhaseNote(history: ChatMessage[], phaseNote: string): void {
    const note = `[System Phase]\n${withoutRepeats(history, phaseNote) || 'The previous phase is complete; continue the task normally.'}`;
    const last = history[history.length - 1];
    if (last?.role === 'user' && typeof last.content === 'string') {
        history[history.length - 1] = { ...last, content: `${last.content}\n\n${note}` };
    } else {
        history.push({ role: 'user', content: note });
    }
}
