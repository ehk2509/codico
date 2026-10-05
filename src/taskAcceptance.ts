const MAX_TASK_CONTRACT_CHARS = 3500;

function normalized(text: string): string {
    return text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function clauses(text: string): string[] {
    return text
        .split(/(?<=[.!?])\s+|\n+/)
        .map(part => part.trim())
        .filter(Boolean)
        .slice(0, 10);
}

function preservationClauses(text: string): string[] {
    const preserve = /\b(?:keep|preserve|unchanged|without|do not|don't|must not|should not|still|remain|avoid|only)\b/i;
    return clauses(text).filter(part => preserve.test(part)).slice(0, 8);
}

export function buildTaskAcceptanceContract(rawText: string): string {
    const request = normalized(rawText).slice(0, MAX_TASK_CONTRACT_CHARS);
    const acceptance = clauses(request);
    const preservation = preservationClauses(request);
    const checklist = acceptance.length > 0
        ? '\n\nAcceptance checklist derived from the request:\n' + acceptance.map(item => `- ${item}`).join('\n')
        : '';
    const preservationBlock = preservation.length > 0
        ? '\n\nExplicit preservation / negative constraints:\n' + preservation.map(item => `- ${item}`).join('\n')
        : '';

    return `## Task acceptance contract

The original user request remains authoritative. A fix is incomplete unless it satisfies the requested behavior and preserves every stated invariant.

Original request:
${request}${checklist}${preservationBlock}

Implementation discipline:
- identify the abstraction or API boundary that owns the behavior before patching a convenient call site;
- prefer one reusable invariant over enumerating only variants visible in the first file;
- inspect callers, consumers, sibling implementations, or existing tests when they materially affect correctness;
- do not optimize for guessed hidden tests or a particular file layout: optimize for requested observable behavior.

Verification requirements:
- verify changed behavior, not only compilation;
- verify every explicit preservation / negative constraint;
- if a focused test exists, run it;
- otherwise inspect control-flow or integration paths that distinguish the failure case from normal success/completion paths before finishing.`;
}
