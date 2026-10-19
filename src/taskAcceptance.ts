const MAX_TASK_CONTRACT_CHARS = 2200;

function normalized(text: string): string {
    return text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The rules the agent keeps in view while working, with the request itself. Nothing is derived
 * from the request by splitting its sentences: a checklist of its first sentences dropped most of
 * a long request and cut a rule from the cases it applies to, and a sentence that only described
 * the problem ("…knows its workers only by an id") was taken for a constraint to preserve.
 */
export function buildTaskAcceptanceContract(rawText: string): string {
    const request = normalized(rawText).slice(0, MAX_TASK_CONTRACT_CHARS);
    return `## Task acceptance contract

The original user request remains authoritative. A fix is incomplete unless it satisfies every part of the requested behavior and keeps everything the request says must not change.

Original request:
${request}

Implementation discipline:
- identify the abstraction or API boundary that owns the behavior before patching a convenient call site;
- apply each requested rule wherever the request says it applies (every form, path or caller it names), through one shared piece of code rather than a copy per place;
- for an input conversion (cleaning, normalization, formatting, parsing), identify what value each named public entry point must RETURN, not merely what a later service stores. The converted value must be observable through every requested entry point;
- for input conversions, enforce the invariant at the owning action or service boundary even if parsers already normalize; callers can invoke services with raw values directly;
- inspect callers, consumers, sibling implementations, or existing tests when they materially affect correctness;
- do not optimize for guessed hidden tests or a particular file layout: optimize for requested observable behavior.

Verification requirements:
- verify changed behavior, not only compilation;
- when the request names multiple forms or APIs, exercise EACH public entry point independently and assert its exact returned value before testing downstream consumers; tests of eventual persistence do not prove an input parser is correct;
- test the owning service or action DIRECTLY with the unconverted input, without a parser/helper in front. Verify its observable output and stored state; testing a service with an already-clean value misses this edge;
- an assertion that a named input boundary returns an UNCONVERTED value when the request requires a converted value is a failing test of the request, even when that assertion passes and a later service converts it. Fix the boundary and the test;
- when an edit introduces a reusable helper for an observable behavior change, verify a production caller/path actually invokes that helper; a standalone helper definition is not behavioral completion;
- verify everything the request says must stay unchanged;
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
