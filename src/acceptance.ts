/**
 * Acceptance: whether the change does what was asked, as opposed to whether it builds. The
 * agent states the acceptance criteria and says which evidence shows each one; the evidence
 * itself is what Codico observed — assertions it ran in the browser, test and build commands
 * and their results, console errors — never what the model says. A criterion counts as
 * verified only when evidence it names passed after the last change to the code.
 */

export type EvidenceKind = 'expect' | 'check';

/** One thing Codico checked itself, with its result. */
export interface Evidence {
    id: string;
    kind: EvidenceKind;
    /** "text "Saved" visible in .toast", "npm test" */
    description: string;
    passed: boolean;
    /** Its result cannot be told (an exit code hidden by a pipe, no summary): no evidence either way. */
    unknown?: boolean;
    /** "12 passed, 0 failed", "found 0 matches", … */
    detail: string;
    /** The page it was checked on (browser assertions). */
    url?: string;
    /** Console and page errors seen on that page before the assertion. */
    consoleErrors?: string[];
    /** A screenshot saved as evidence, relative to the evidence folder. */
    screenshot?: string;
    at: number;
}

/** A step in the browser, kept for the evidence trail and the reviewer. */
export interface BrowserStep {
    action: string;
    target: string;
    url: string;
    /** The start of the page's visible text after the step. */
    text?: string;
    screenshot?: string;
    at: number;
}

export type CriterionStatus =
    | 'verified'   // evidence it names passed after the last change
    | 'failing'    // evidence it names failed after the last change, or the agent said it fails
    | 'stale'      // its evidence is from before the last change
    | 'claimed'    // said to be met, with no evidence Codico observed
    | 'open';      // never checked

export interface CriterionReport {
    id: string;
    text: string;
    status: CriterionStatus;
    /** It was shown to fail before the change: the bug or the missing feature was reproduced. */
    reproduced: boolean;
    /** What the agent said it did to check it, last time. */
    how?: string;
    evidence: Evidence[];
    /** An independent reviewer's opinion of the evidence, when one was asked. */
    review?: { agrees: boolean; reason: string };
}

export type AcceptanceVerdict = 'accepted' | 'partial' | 'disputed' | 'failing' | 'unverified';

export interface AcceptanceReport {
    verdict: AcceptanceVerdict;
    criteria: CriterionReport[];
    /** Console and page errors seen in the browser after the last change. */
    consoleErrors: string[];
    steps: number;
    /** The folder the screenshots and the report were saved in, when any were. */
    evidenceFolder?: string;
    /** The reviewer's judgement of whether the criteria and the tests cover the user's request as asked. */
    requestReview?: { agrees: boolean; reason: string };
}

interface Claim { at: number; result: 'pass' | 'fail'; how: string; evidence: string[] }
interface Criterion { id: string; text: string; claims: Claim[] }

export const MAX_CRITERIA = 12;

/** Records criteria, evidence and claims of one turn, on the clock of its change report. */
export class AcceptanceRecorder {
    private _criteria: Criterion[] = [];
    private readonly _evidence: Evidence[] = [];
    private readonly _steps: BrowserStep[] = [];
    private readonly _console: Array<{ at: number; text: string }> = [];
    private _reviews = new Map<string, { agrees: boolean; reason: string }>();
    evidenceFolder: string | undefined;

    constructor(private readonly _tick: () => number) {}

    get criteria(): ReadonlyArray<{ id: string; text: string }> { return this._criteria; }

    /** States the criteria; stating them again replaces the list (what was checked of a criterion with the same text is kept). */
    setCriteria(texts: string[]): string {
        const clean = texts.map(text => text.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, MAX_CRITERIA);
        if (clean.length === 0) { return 'ERROR: give at least one criterion.'; }
        const before = new Map(this._criteria.map(criterion => [criterion.text, criterion]));
        this._criteria = clean.map((text, i) => ({ id: `AC${i + 1}`, text, claims: before.get(text)?.claims ?? [] }));
        return this._criteria.map(criterion => `${criterion.id}: ${criterion.text}`).join('\n');
    }

    /** Something Codico checked; returns its evidence id. */
    addEvidence(evidence: Omit<Evidence, 'id' | 'at'>): string {
        const id = `E${this._evidence.length + 1}`;
        this._evidence.push({ ...evidence, id, at: this._tick() });
        return id;
    }

    browserStep(step: Omit<BrowserStep, 'at'>): void { this._steps.push({ ...step, at: this._tick() }); }
    consoleError(text: string): void { this._console.push({ at: this._tick(), text: text.slice(0, 500) }); }
    get steps(): readonly BrowserStep[] { return this._steps; }
    get evidence(): readonly Evidence[] { return this._evidence; }

    /** The agent says what it did to check a criterion, and which evidence shows it. Returns what Codico makes of it. */
    claim(id: string, result: 'pass' | 'fail', how: string, evidence: string[]): { ok: boolean; text: string } {
        const criterion = this._criteria.find(c => c.id.toLowerCase() === id.trim().toLowerCase());
        if (!criterion) {
            return { ok: false, text: this._criteria.length ? `ERROR: no criterion "${id}". The criteria are ${this._criteria.map(c => c.id).join(', ')}.` : 'ERROR: state the acceptance criteria first (action "criteria").' };
        }
        const known = new Set(this._evidence.map(e => e.id));
        const unknown = evidence.filter(e => !known.has(e.toUpperCase()));
        if (unknown.length) { return { ok: false, text: `ERROR: no evidence ${unknown.join(', ')}. Evidence ids come from browser_expect results and from test, build and type-check commands (E1, E2…).` }; }
        criterion.claims.push({ at: this._tick(), result, how: how.trim().slice(0, 1000), evidence: evidence.map(e => e.toUpperCase()) });
        return { ok: true, text: `${criterion.id} recorded as ${result === 'pass' ? 'met' : 'not met'}${evidence.length ? ` on ${evidence.map(e => e.toUpperCase()).join(', ')}` : ', with no evidence Codico observed: it will count as claimed, not verified'}.` };
    }

    /**
     * The criteria a check named (run_terminal verifies), recorded as met or not on its result, so the
     * agent need not record them in a step of its own. A result that cannot be told records nothing.
     */
    claimByCheck(ids: readonly string[], evidenceId: string, command: string): string {
        const result = this._evidence.find(e => e.id === evidenceId);
        if (!result || ids.length === 0) { return ''; }
        if (result.unknown) { return `${ids.join(', ')} not recorded: the result of this command cannot be told.`; }
        const how = `\`${command.trim().slice(0, 200)}\` ${result.passed ? 'passed' : 'failed'}`;
        return ids.map(id => this.claim(id, result.passed ? 'pass' : 'fail', how, [evidenceId]).text).join('\n');
    }

    setReview(id: string, review: { agrees: boolean; reason: string }): void { this._reviews.set(id, review); }

    /**
     * The acceptance part of the change report.
     * @param lastChange when the code last changed (0: not in this turn)
     * @param checks the test, build and type-check runs of the turn, as evidence
     */
    build(lastChange: number): AcceptanceReport | undefined {
        if (this._criteria.length === 0) {
            // Preserve a request-level review dispute when the agent omitted acceptance criteria.
            const requestReview = this._reviews.get('REQUEST');
            if (!requestReview) { return undefined; }
            return {
                verdict: requestReview.agrees ? 'unverified' : 'disputed',
                criteria: [], consoleErrors: [], steps: this._steps.length,
                evidenceFolder: this.evidenceFolder, requestReview,
            };
        }
        const byId = new Map(this._evidence.map(e => [e.id, e]));
        const criteria = this._criteria.map((criterion): CriterionReport => {
            const last = criterion.claims[criterion.claims.length - 1];
            const evidence = last ? last.evidence.map(id => byId.get(id)).filter((e): e is Evidence => !!e) : [];
            // A failure shown before the code changed is the reproduction of what was to be fixed
            const reproduced = lastChange > 0 && criterion.claims.some(claim => claim.at < lastChange
                && (claim.result === 'fail' || claim.evidence.some(id => byId.get(id)?.passed === false)));
            // Only evidence about the final code counts; what failed before the change is the reproduction.
            // A failed run that a later run of the same check passed is superseded (as when the old code was
            // restored in the terminal, with git stash, to reproduce the failure).
            const superseded = (e: Evidence) => !e.passed && this._evidence.some(later => later.at > e.at && later.passed && later.kind === e.kind && later.description === e.description);
            // A result that cannot be told shows nothing: it neither fails nor verifies a criterion
            const current = evidence.filter(e => e.at > lastChange && !superseded(e) && !e.unknown);
            let status: CriterionStatus;
            if (!last) { status = 'open'; }
            else if ((last.result === 'fail' && last.at > lastChange) || current.some(e => !e.passed)) { status = 'failing'; }
            else if (last.result === 'fail') { status = 'stale'; }
            else if (evidence.length === 0) { status = 'claimed'; }
            else if (current.length === 0) { status = evidence.some(e => e.at > lastChange && e.unknown) && !evidence.some(e => e.at > lastChange && !e.unknown) ? 'claimed' : 'stale'; }
            else { status = 'verified'; }
            return { id: criterion.id, text: criterion.text, status, reproduced, how: last?.how, evidence, review: this._reviews.get(criterion.id) };
        });
        const verified = criteria.filter(c => c.status === 'verified' && c.review?.agrees !== false).length;
        const disputed = criteria.some(c => c.status === 'verified' && c.review?.agrees === false);
        const requestReview = this._reviews.get('REQUEST');
        const allVerified: AcceptanceVerdict = requestReview?.agrees === false ? 'disputed' : 'accepted';
        const verdict: AcceptanceVerdict = criteria.some(c => c.status === 'failing') ? 'failing'
            : verified === criteria.length ? allVerified : verified > 0 ? 'partial' : disputed ? 'disputed' : 'unverified';
        const consoleErrors = [...new Set(this._console.filter(entry => entry.at > lastChange).map(entry => entry.text))];
        return { verdict, criteria, consoleErrors, steps: this._steps.length, evidenceFolder: this.evidenceFolder, ...(requestReview ? { requestReview } : {}) };
    }
}

const STATUS_TEXT: Record<CriterionStatus, string> = {
    verified: 'verified', failing: 'failing', stale: 'checked before the last change', claimed: 'claimed, no evidence', open: 'not checked',
};

export const ACCEPTANCE_TEXT: Record<AcceptanceVerdict, string> = {
    accepted: 'Accepted: every criterion verified on the final code',
    partial: 'Partly accepted: not every criterion is verified',
    disputed: 'Not accepted: the reviewer disputes the evidence',
    failing: 'Not accepted: a criterion fails',
    unverified: 'Not accepted: no criterion is verified',
};

/** One criterion for the report, the reviewer and the model. */
export function criterionLine(criterion: CriterionReport): string {
    const evidence = criterion.evidence.map(e => `${e.id} ${e.passed ? 'passed' : 'failed'}: ${e.description} (${e.detail})`).join('; ');
    const review = criterion.review ? ` Reviewer ${criterion.review.agrees ? 'agrees' : 'disputes'}: ${criterion.review.reason}` : '';
    return `${criterion.id} [${STATUS_TEXT[criterion.status]}${criterion.reproduced ? ', reproduced before the change' : ''}] ${criterion.text}${evidence ? ` — ${evidence}` : ''}${review}`;
}

/** The acceptance section of the change report, as Markdown. */
/**
 * One line for the end of the reply when the acceptance was not established, so the reply never
 * presents as done what Codico's own check does not accept. Undefined when it was accepted.
 */
export function verdictNote(report: AcceptanceReport | undefined, changedCode = false): string | undefined {
    // Code changed and no criteria were ever stated: nothing shows the request is met
    if (!report) { return changedCode ? `\n\n> **Codico's check: no acceptance criteria were stated**, so nothing shows that the request is met. Whatever the reply above says, this is not verified as done.` : undefined; }
    if (report.verdict === 'accepted') { return undefined; }
    const open = report.criteria.filter(c => c.status !== 'verified' || c.review?.agrees === false)
        .map(c => `${c.id} ${c.review?.agrees === false ? 'disputed by the reviewer' : STATUS_TEXT[c.status]}`);
    if (report.requestReview?.agrees === false) { open.push(`the request as asked, disputed by the reviewer: ${report.requestReview.reason.replace(/[.\s]+$/, '')}`); }
    return `\n\n> **Codico's check: ${ACCEPTANCE_TEXT[report.verdict]}.**${open.length ? ` ${open.join('; ')}.` : ''} Whatever the reply above says, this is not verified as done.`;
}

export function acceptanceMarkdown(report: AcceptanceReport): string[] {
    const mark: Record<CriterionStatus, string> = { verified: '✅', failing: '❌', stale: '⚠️', claimed: '❔', open: '⬜' };
    const lines = ['', `### Acceptance — ${ACCEPTANCE_TEXT[report.verdict]}`, ...report.criteria.map(c => {
        const evidence = c.evidence.map(e => `${e.id} ${e.passed ? 'passed' : 'failed'}: ${e.description} (${e.detail})${e.screenshot ? ` [screenshot](${e.screenshot})` : ''}`);
        return [`- ${mark[c.status]} **${c.id}** ${c.text} — ${STATUS_TEXT[c.status]}${c.reproduced ? '; reproduced before the change' : ''}`,
            ...evidence.map(line => `  - ${line}`),
            ...(c.review ? [`  - Reviewer ${c.review.agrees ? 'agrees' : 'disputes'}: ${c.review.reason}`] : [])].join('\n');
    })];
    if (report.requestReview) { lines.push(`- ${report.requestReview.agrees ? '✅' : '❌'} **The request as asked** — reviewer ${report.requestReview.agrees ? 'agrees' : 'disputes'}: ${report.requestReview.reason}`); }
    if (report.consoleErrors.length) { lines.push('', `Console errors after the last change (${report.consoleErrors.length}):`, ...report.consoleErrors.slice(0, 10).map(text => `- \`${text.replace(/`/g, "'").slice(0, 200)}\``)); }
    if (report.evidenceFolder) { lines.push('', `Evidence (screenshots, replay, report): \`${report.evidenceFolder}\``); }
    return lines;
}

/** A test file the agent wrote or changed, as the reviewer reads it. */
export interface ReviewedTest { path: string; text: string }

/** What the reviewer is asked: the request, the criteria, and only what Codico observed. Nothing of the agent's reasoning. */
/**
 * What a reviewer needs of a changed file: the part the turn changed, with some lines around it,
 * not the file's start (new tests are often appended to a long test file). A new file, or a short
 * one, is given whole.
 */
export function changedPart(before: string | null | undefined, after: string, max = 20000, context = 20): string {
    const cut = (text: string) => text.length > max ? `${text.slice(0, max)}\n… (cut)` : text;
    if (before === null || before === undefined || after.length <= max) { return cut(after); }
    const a = before.split('\n'); const b = after.split('\n');
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) { start++; }
    let end = 0;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) { end++; }
    const from = Math.max(0, start - context); const to = Math.min(b.length, b.length - end + context);
    const lines = b.slice(from, to).map((line, i) => `${from + i + 1}\t${line}`).join('\n');
    return `(lines ${from + 1}–${to} of ${b.length}: the part this turn changed; the rest of the file is unchanged)\n${cut(lines)}`;
}

/**
 * Local proof obligations to check before spending a reviewer model call.
 * A missing checklist or an unverified criterion already makes the acceptance fail;
 * independent review is useful only after the agent has produced final-code evidence.
 * This never upgrades a verdict to accepted: only the independent reviewer can.
 */
export function acceptanceReviewPreflight(report: AcceptanceReport | undefined, request: string, changedCode: boolean): string | undefined {
    if (!changedCode || !request.trim()) { return undefined; }
    if (!report || report.criteria.length === 0) {
        return 'No acceptance criteria registered for the original request. State them in the request\'s own words and verify each on the final code.';
    }
    const pending = report.criteria.filter(c => c.status !== 'verified');
    if (pending.length) {
        return `Acceptance evidence is not ready: ${pending.map(c => `${c.id} (${c.status})`).join(', ')}. Run the exact requested behavior on the final code and record passing evidence for every criterion before independent review.`;
    }
    return undefined;
}

/** Maximum source/test context for reviewer model calls, shared fairly between files. */
export function reviewSnippetBudget(fileCount: number, totalChars: number, perFileCap: number): number {
    return Math.min(perFileCap, Math.floor(totalChars / Math.max(1, fileCount)));
}

export function reviewPrompt(report: AcceptanceReport, steps: readonly BrowserStep[], diffStat: string, tests: readonly ReviewedTest[] = [], request = '', sources: readonly ReviewedTest[] = []): string {
    const evidence = report.criteria.map(c => [`${c.id}: ${c.text}`, `  Agent says it checked it by: ${c.how ?? '(nothing)'}`,
        ...c.evidence.map(e => `  ${e.id} ${e.passed ? 'PASSED' : 'FAILED'} [${e.kind}] ${e.description} — ${e.detail}${e.url ? ` on ${e.url}` : ''}${e.consoleErrors?.length ? ` (console errors on the page: ${e.consoleErrors.slice(0, 3).join(' | ')})` : ''}`)].join('\n')).join('\n\n');
    const trail = steps.slice(-25).map(step => `- ${step.action} ${step.target} → ${step.url}${step.text ? `\n  page text: ${step.text.slice(0, 300).replace(/\s+/g, ' ')}` : ''}`).join('\n');
    return `You review the acceptance of a code change, independently of the agent that made it. For each criterion decide whether the evidence below, which the tool observed itself, actually shows that the criterion is met on the final code. A build or a test that does not exercise the criterion does not show it. An assertion that checks something weaker than the criterion does not show it. When the tests are given, read their assertions: one that compares loosely (a substring, a trimmed or partial value) where the criterion needs an exact result, or that tests a different case than the one the criterion names, does not show it.\n\n` +
        (request.trim() ? `The user's request, which the change must meet as asked:\n${request.trim().slice(0, 4000)}\n\n` : '') +
        `Files changed:\n${diffStat || '(none)'}\n\n` +
        (sources.length ? `Changed production implementation (not proof that unmodified paths work):\n${sources.map(s => `--- ${s.path}\n${s.text}`).join('\n\n')}\n\n` : '') +
        `Criteria and evidence:\n${evidence}\n\n` +
        (tests.length ? `Tests the agent wrote or changed:\n${tests.map(t => `--- ${t.path}\n${t.text}`).join('\n\n')}\n\n` : '') +
        `Browser steps (most recent last):\n${trail || '(none)'}\n` +
        `${report.consoleErrors.length ? `\nConsole errors after the last change:\n${report.consoleErrors.slice(0, 10).join('\n')}\n` : ''}\n` +
        (report.criteria.length ? 'Answer with one line per criterion and nothing else, in this form:\nAC1: yes — <one sentence why>\nAC2: no — <one sentence why>' : 'No acceptance criteria were registered. This cannot be accepted as completed work. Answer with a REQUEST: no line explaining what must be verified.') +
        (request.trim() ? '\nThen one more line on whether the criteria and the tests, together, cover the request as the user asked it: every case, argument and value it names, with the behavior it asks for. Where the request names several entry points, forms or public functions, each needs a test that checks what that entry point itself returns or does; a test of a later consumer does not show it. Count only the entry points the request names or its callers use: do not require tests of internal code (the agent loop, a host, a framework) the request does not mention. Production snippets are context, not proof. If a named entry point has no such test, answer REQUEST: no and name it. If a test asserts that a named entry point returns a value unconverted where the request says it is converted, answer REQUEST: no and quote that assertion, even if a later step converts the value. Do not infer coverage from a passing suite. A different mechanism (a new syntax, option or mode) or a narrower case does not cover the request. Where the request gives an example (an input and what it must produce), a test must give that very input to the code the user calls (the tool, command or public function, not a helper behind it) and check the stated output; a test of the helper alone, or with an input already in its final form, does not cover it. Where the request says a value is converted (cleaned, normalized, formatted) on a path it names, a test that expects the unconverted value on that path contradicts the request:\nREQUEST: yes — <why> (or no — <what is not covered>)' : '');
}

/** The reviewer's answer, criterion by criterion. */
export function parseReview(text: string): Map<string, { agrees: boolean; reason: string }> {
    const result = new Map<string, { agrees: boolean; reason: string }>();
    for (const match of text.matchAll(/^\s*\**\s*(AC\d+|REQUEST)\s*\**\s*[:\-–]\s*(yes|no)\b[\s,.:;—–-]*(.*)$/gim)) {
        result.set(match[1].toUpperCase(), { agrees: match[2].toLowerCase() === 'yes', reason: match[3].trim().slice(0, 300) || (match[2].toLowerCase() === 'yes' ? 'the evidence shows it' : 'the evidence does not show it') });
    }
    return result;
}
