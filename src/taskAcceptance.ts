const MAX_TASK_CONTRACT_CHARS = 3500;

function normalized(text: string): string {
    return text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function preservationClauses(text: string): string[] {
    const preserve = /\b(?:keep|preserve|unchanged|without|do not|don't|must not|should not|still|remain|avoid|only)\b/i;
    return text
        .split(/(?<=[.!?])\s+|\n+/)
        .map(part => part.trim())
        .filter(part => part.length > 0 && preserve.test(part))
        .slice(0, 8);
}

/**
 * Keeps the user's acceptance criteria salient after long autonomous tool loops.
 * It does not invent requirements: preservation clauses are copied from the
 * original request and the full request remains the source of truth.
 */
export function buildTaskAcceptanceContract(rawText: string): string {
    const request = normalized(rawText).slice(0, MAX_TASK_CONTRACT_CHARS);
    const preservation = preservationClauses(request);
    const preservationBlock = preservation.length > 0
        ? '\n\nExplicit preservation / negative constraints:\n' +
            preservation.map(item => `- ${item}`).join('\n')
        : '';

    return `## Task acceptance contract

The original user request remains authoritative. A fix is incomplete unless it satisfies the requested change and preserves every stated invariant.

Original request:
${request}${preservationBlock}

Verification requirements:
- verify the changed behavior;
- verify every explicit "keep / preserve / unchanged / without / do not / must not" constraint;
- if focused tests do not exist, inspect the control-flow paths that distinguish the failure case from normal success/completion paths before finishing.`;
}
