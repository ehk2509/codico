/**
 * The change report ("patch passport"): what a turn changed and what evidence there is that
 * the change works. It is assembled from what Codico observed — files written, commands run
 * and their results — never from what the model says, and costs no model request.
 */

export type CheckKind = 'test' | 'build' | 'typecheck' | 'lint';
export type CheckOutcome = 'passed' | 'failed' | 'unknown';
export type Verdict = 'verified' | 'failing' | 'unverified';

export interface PassportFile {
    path: string;
    status: 'created' | 'modified';
    added: number;
    removed: number;
    /** How many times the file was written in the turn. */
    edits: number;
    /** A check passed after this file's last change. */
    checked: boolean;
}

export interface PassportCheck {
    command: string;
    kind: CheckKind;
    outcome: CheckOutcome;
    /** What the outcome rests on: "238 passed, 0 failed", "exit 1", … */
    detail: string;
    /** Its last run was before the last file change: it does not cover the final code. */
    stale: boolean;
    /** It failed earlier in the turn and passes now. */
    fixed: boolean;
    runs: number;
}

export interface PatchPassport {
    verdict: Verdict;
    files: PassportFile[];
    checks: PassportCheck[];
    /** What is not covered, in sentences. */
    notes: string[];
}

// ── Commands ─────────────────────────────────────────────────────────────────

const CHECK_PATTERNS: Array<[CheckKind, RegExp]> = [
    ['test', /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)\b[\w:.-]*|(?:npm|pnpm|yarn|bun)\s+run\s+[\w:.-]*(?:test|spec|e2e)[\w:.-]*|jest|vitest|mocha|ava|playwright\s+test|cypress\s+run|node\s+(?:\S+\s+)*--test\b|pytest|py\.test|python3?\s+-m\s+(?:pytest|unittest)|tox|go\s+test|cargo\s+(?:test|nextest)|dotnet\s+test|mvn\s+(?:\S+\s+)*(?:test|verify)|gradlew?\s+(?:\S+\s+)*(?:test|check)|phpunit|rspec|bundle\s+exec\s+(?:rspec|rake\s+test)|rake\s+test|ctest|make\s+(?:test|check))\b/],
    ['typecheck', /\b(?:tsc\b(?!\s+--init)|(?:npm|pnpm|yarn|bun)\s+run\s+[\w:.-]*(?:typecheck|type-check|tsc)[\w:.-]*|mypy|pyright|flow\s+check|cargo\s+check|go\s+vet)\b/],
    ['lint', /\b(?:eslint|biome\s+(?:check|lint)|(?:npm|pnpm|yarn|bun)\s+run\s+[\w:.-]*lint[\w:.-]*|ruff\s+check|flake8|pylint|golangci-lint|cargo\s+clippy|rubocop|stylelint|shellcheck)\b/],
    ['build', /\b(?:(?:npm|pnpm|yarn|bun)\s+run\s+[\w:.-]*(?:build|compile)[\w:.-]*|cargo\s+build|go\s+build|mvn\s+(?:\S+\s+)*(?:compile|package)|gradlew?\s+(?:\S+\s+)*(?:build|assemble)|dotnet\s+build|make(?:\s+(?:all|build))?\s*$|webpack|vite\s+build|esbuild)\b/],
];

/** The command with what only changes how its output is shown taken off: `cd x &&`, `timeout 30`, `2>&1 | tail -5`. */
export function checkKey(command: string): string {
    return command
        .replace(/^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '')
        .replace(/\s*\d?>&\d|\s*2>\s*\/dev\/null/g, '')
        .replace(/\s*\|\s*(?:tail|head|grep|cat|tee|less|sed|awk|cut|sort|uniq|wc)\b(?:'[^']*'|"[^"]*"|[^|'"])*/g, '')
        .replace(/(^|&&\s*|;\s*)(?:env\s+)?(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/g, '$1')
        .replace(/\b(?:timeout|time|nice)\s+(?:-\S+\s+)*\d*[smh]?\s+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** What kind of check a command is, or null when it is not one (an `ls`, a `git status`, a script). */
export function classifyCheck(command: string): CheckKind | null {
    const key = checkKey(command);
    // A search for the word "test" is not a test run
    if (/^(?:grep|rg|find|ls|cat|echo|git|sed|awk|head|tail|wc|which|pwd)\b/.test(key)) { return null; }
    for (const [kind, pattern] of CHECK_PATTERNS) { if (pattern.test(key)) { return kind; } }
    return null;
}

/** A pipe hides the exit code of the command before it (unless the shell is told otherwise). */
function exitCodeHidden(command: string): boolean {
    const unquoted = command.replace(/'[^']*'|"[^"]*"/g, '');
    return /(?<!\|)\|(?!\|)/.test(unquoted) && !/pipefail/.test(command);
}

/** Pass and fail counts printed by a test runner, when the output has a summary we know. */
export function testSummary(output: string): { passed: number; failed: number } | null {
    const text = output.replace(/\x1b\[[0-9;]*m/g, '');
    const last = (pattern: RegExp): number | null => {
        const all = [...text.matchAll(pattern)];
        return all.length ? Number(all[all.length - 1][1]) : null;
    };
    const pair = (passed: number | null, failed: number | null): { passed: number; failed: number } | null =>
        passed === null && failed === null ? null : { passed: passed ?? 0, failed: failed ?? 0 };
    return pair(last(/^# pass (\d+)$/gm), last(/^# fail (\d+)$/gm))                                   // node --test (TAP)
        ?? pair(last(/^\s*Tests:\s.*?(\d+) passed/gm), last(/^\s*Tests:\s.*?(\d+) failed/gm))        // jest
        ?? pair(last(/^\s*Tests\s+.*?(\d+) passed/gm), last(/^\s*Tests\s+.*?(\d+) failed/gm))        // vitest
        ?? pair(last(/=+ .*?(\d+) passed.*? in [\d.]+s/g), last(/=+ .*?(\d+) (?:failed|error)/g))    // pytest
        ?? pair(last(/^\s*(\d+) passing\b/gm), last(/^\s*(\d+) failing\b/gm))                         // mocha
        ?? pair(last(/test result: \w+\. (\d+) passed/g), last(/test result: \w+\. \d+ passed; (\d+) failed/g)) // cargo
        ?? pair(last(/^\s*(\d+) passed\b/gm), last(/^\s*(\d+) failed\b/gm));                          // playwright and others
}

// ── Lines changed ────────────────────────────────────────────────────────────

const MAX_LCS_CELLS = 4_000_000;

/** Lines added and removed between two versions of a file. */
export function countChangedLines(before: string, after: string): { added: number; removed: number } {
    const a = before === '' ? [] : before.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    const b = after === '' ? [] : after.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) { start++; }
    let end = 0;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) { end++; }
    const midA = a.slice(start, a.length - end);
    const midB = b.slice(start, b.length - end);
    // Too large to compare line by line: every line of the changed region counts
    if (midA.length * midB.length > MAX_LCS_CELLS) { return { added: midB.length, removed: midA.length }; }
    let previous = new Array<number>(midB.length + 1).fill(0);
    for (let i = 1; i <= midA.length; i++) {
        const row = new Array<number>(midB.length + 1).fill(0);
        for (let j = 1; j <= midB.length; j++) {
            row[j] = midA[i - 1] === midB[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], row[j - 1]);
        }
        previous = row;
    }
    const common = previous[midB.length];
    return { added: midB.length - common, removed: midA.length - common };
}

// ── Recorder ─────────────────────────────────────────────────────────────────

interface FileRecord { before: string | null; after: string; edits: number; lastChange: number }
interface CheckRun { outcome: CheckOutcome; detail: string; at: number }
interface CheckRecord { command: string; kind: CheckKind; runs: CheckRun[] }

/** Collects what one turn changed and checked, in the order it happened. */
export class PassportRecorder {
    private _clock = 0;
    private readonly _files = new Map<string, FileRecord>();
    private readonly _checks = new Map<string, CheckRecord>();

    /**
     * A file was written.
     * @param before its text before the write; null when the file did not exist
     */
    recordChange(path: string, before: string | null, after: string): void {
        const at = ++this._clock;
        const known = this._files.get(path);
        if (known) { known.after = after; known.edits++; known.lastChange = at; }
        else { this._files.set(path, { before, after, edits: 1, lastChange: at }); }
    }

    /** A command finished. Commands that are not checks are ignored. */
    recordCommand(command: string, exitCode: number | null, output = ''): void {
        const kind = classifyCheck(command);
        if (!kind) { return; }
        const key = checkKey(command);
        const record = this._checks.get(key) ?? { command: key, kind, runs: [] };
        this._checks.set(key, record);
        record.runs.push({ ...this._outcome(command, kind, exitCode, output), at: ++this._clock });
    }

    private _outcome(command: string, kind: CheckKind, exitCode: number | null, output: string): { outcome: CheckOutcome; detail: string } {
        const summary = kind === 'test' ? testSummary(output) : null;
        if (summary) {
            return { outcome: summary.failed > 0 ? 'failed' : 'passed', detail: `${summary.passed} passed, ${summary.failed} failed` };
        }
        if (exitCode === null) { return { outcome: 'failed', detail: 'did not finish' }; }
        // A failure always counts; a success behind a pipe proves nothing
        if (exitCode !== 0) { return { outcome: 'failed', detail: `exit ${exitCode}` }; }
        if (exitCodeHidden(command)) { return { outcome: 'unknown', detail: 'result hidden by a pipe' }; }
        return { outcome: 'passed', detail: 'exit 0' };
    }

    /** The report, or undefined when the turn left no file changed. */
    build(): PatchPassport | undefined {
        const changed = [...this._files.entries()].filter(([, file]) => (file.before ?? '') !== file.after || file.before === null);
        if (changed.length === 0) { return undefined; }
        const lastChange = Math.max(...changed.map(([, file]) => file.lastChange));

        const checks: PassportCheck[] = [...this._checks.values()].map(record => {
            const latest = record.runs[record.runs.length - 1];
            return {
                command: record.command, kind: record.kind, outcome: latest.outcome, detail: latest.detail,
                stale: latest.at < lastChange,
                fixed: latest.outcome === 'passed' && record.runs.slice(0, -1).some(run => run.outcome === 'failed'),
                runs: record.runs.length,
            };
        });
        const current = checks.filter(check => !check.stale);
        const lastPass = Math.max(0, ...[...this._checks.values()].flatMap(record => record.runs.filter(run => run.outcome === 'passed').map(run => run.at)));

        const files: PassportFile[] = changed.map(([path, file]) => ({
            path, status: file.before === null ? 'created' as const : 'modified' as const,
            ...countChangedLines(file.before ?? '', file.after), edits: file.edits, checked: lastPass > file.lastChange,
        })).sort((a, b) => a.path.localeCompare(b.path));

        const verdict: Verdict = current.some(check => check.outcome === 'failed') ? 'failing'
            : current.some(check => check.outcome === 'passed') ? 'verified' : 'unverified';

        const notes: string[] = [];
        const list = (paths: string[]): string => paths.length <= 3 ? paths.join(', ') : `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more`;
        if (checks.length === 0) {
            notes.push('No test, build, type-check or lint command was run in this turn.');
        } else if (current.length === 0) {
            notes.push('No check was run after the last file change: the checks below cover an earlier version of the code.');
        } else if (verdict !== 'failing') {
            const unchecked = files.filter(file => !file.checked).map(file => file.path);
            if (unchecked.length > 0 && verdict === 'verified') { notes.push(`Changed after the last passing check: ${list(unchecked)}.`); }
        }
        for (const check of current) {
            if (check.outcome === 'unknown') { notes.push(`\`${check.command}\` ran, but its result cannot be told: the exit code was hidden by a pipe and no test summary was printed.`); }
        }
        if (verdict === 'verified' && !current.some(check => check.kind === 'test' && check.outcome === 'passed')) {
            notes.push('No tests were run: only the build, type-check or lint passed.');
        }
        return { verdict, files, checks, notes };
    }
}

// ── Text form ────────────────────────────────────────────────────────────────

const VERDICT_TEXT: Record<Verdict, string> = {
    verified: 'Verified: checks passed after the last change',
    failing: 'Checks failing',
    unverified: 'Not verified: no check passed after the last change',
};

/** The report as Markdown, for a pull request or a commit message. */
export function passportMarkdown(passport: PatchPassport): string {
    const added = passport.files.reduce((sum, file) => sum + file.added, 0);
    const removed = passport.files.reduce((sum, file) => sum + file.removed, 0);
    const lines = [`## Change report`, '', `**${VERDICT_TEXT[passport.verdict]}**`, '',
        `### Files changed (${passport.files.length}, +${added} −${removed})`,
        ...passport.files.map(file => `- \`${file.path}\` — ${file.status === 'created' ? 'new, ' : ''}+${file.added} −${file.removed}`)];
    if (passport.checks.length > 0) {
        lines.push('', '### Checks', ...passport.checks.map(check => {
            const mark = check.outcome === 'passed' ? '✅' : check.outcome === 'failed' ? '❌' : '❔';
            const extras = [check.detail, check.fixed ? 'was failing earlier in this change' : '', check.stale ? 'ran before the last change' : ''].filter(Boolean).join('; ');
            return `- ${mark} \`${check.command}\` (${check.kind}) — ${extras}`;
        }));
    }
    if (passport.notes.length > 0) { lines.push('', '### Not covered', ...passport.notes.map(note => `- ${note}`)); }
    return lines.join('\n') + '\n';
}
