const MAX_TASK_CONTRACT_CHARS = 2200;
const MAX_CHECKLIST_ITEMS = 4;
const MAX_CHECKLIST_ITEM_CHARS = 220;

function normalized(text: string): string {
    return text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function clauses(text: string): string[] {
    return text
        .split(/(?<=[.!?])\s+|\n+/)
        .map(part => part.trim())
        .filter(Boolean);
}

function boundedClauses(text: string, predicate?: (part: string) => boolean): string[] {
    const selected = predicate ? clauses(text).filter(predicate) : clauses(text);
    return selected
        .slice(0, MAX_CHECKLIST_ITEMS)
        .map(part => part.length > MAX_CHECKLIST_ITEM_CHARS
            ? part.slice(0, MAX_CHECKLIST_ITEM_CHARS - 1).trimEnd() + '…'
            : part);
}

function preservationClauses(text: string): string[] {
    const preserve = /\b(?:keep|preserve|unchanged|without|do not|don't|must not|should not|still|remain|avoid|only)\b/i;
    return boundedClauses(text, part => preserve.test(part));
}

export function buildTaskAcceptanceContract(rawText: string): string {
    const request = normalized(rawText).slice(0, MAX_TASK_CONTRACT_CHARS);
    const acceptance = boundedClauses(request);
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
- when an edit introduces a reusable helper for an observable behavior change, verify a production caller/path actually invokes that helper; a standalone helper definition is not behavioral completion;
- verify every explicit preservation / negative constraint;
- if a focused test exists, run it;
- otherwise inspect control-flow or integration paths that distinguish the failure case from normal success/completion paths before finishing.`;
}


const MUTATION_INTENT_RE = /\b(?:fix|implement|change|update|modify|refactor|patch|correct|add|remove|replace|prevent|make|wire|integrate|create)\b/i;

/**
 * Conservative signal used only to prevent an agent from declaring success
 * after a long focused coding pass without making any code change.
 */
export function taskLikelyRequiresMutation(rawText: string): boolean {
    return MUTATION_INTENT_RE.test(normalized(rawText));
}
