/**
 * Quality scoring of holdout runs: what a run proves beyond "the hidden verifier passed".
 * Every figure rests on what was observed — the project's own tests before and after the
 * agent, the files the historical fix changed, the commands the agent ran and their results —
 * and only the claim of completion is read from the agent's reply.
 */

// ── Claims ───────────────────────────────────────────────────────────────────

const ADMITS = /\b(?:could(?:n['’]t| not)|was(?:n['’]t| not) able|were(?:n['’]t| not) able|unable to|cannot (?:fix|complete|resolve|reproduce|finish)|can['’]t (?:fix|complete|resolve|reproduce|finish)|did(?:n['’]t| not) (?:manage|succeed|fix|resolve|finish|complete)|not (?:yet )?(?:fixed|resolved|complete|done|working)|(?:still|remains?) (?:fail|failing|broken|unresolved)|partially (?:fixed|done|implemented)|gave up|ran out of)\b/i;

// Codico's own test for a reply that announces a step without taking it ("Let me run the tests:"),
// when the extension is compiled; otherwise a simpler test of the reply's last sentence
let announcesStep = text => /(?:^|[.!?]\s+)(?:now\s+)?(?:let me|let's|i(?:'ll| will)|next,? i(?:'ll| will))\b[^.!?]*[:.]?\s*$/i.test(text) || /:\s*$/.test(text);
try { announcesStep = require('../../out/streamCompletion.js').isUnfulfilledActionAnnouncement; } catch { /* not compiled */ }

/** The run ended on an announced next step: it was cut off (at the step limit), not finished. */
function stoppedMidWork(reply) {
  const text = String(reply || '').trim();
  return !!text && announcesStep(text);
}

/**
 * Whether the agent's final reply presents the task as done: it neither asks a question, nor
 * says that something is left undone, nor announces a step it has yet to take. A heuristic on
 * wording; an empty reply claims nothing.
 */
function claimedCompletion(reply) {
  const text = String(reply || '').trim();
  if (!text) { return false; }
  if (/<clarify>/i.test(text) || stoppedMidWork(text)) { return false; }
  const lastLine = text.split(/\r?\n/).filter(line => line.trim()).pop() || '';
  if (/\?\s*$/.test(lastLine) && !/\b(?:let me know|want me to|should I)\b/i.test(lastLine)) { return false; }
  return !ADMITS.test(text);
}

// ── The project's tests, before and after ────────────────────────────────────

/**
 * Test results from TAP output (node --test --test-reporter=tap): each test's name, prefixed
 * by its parents' (file, describe), and whether it passed. Skipped and todo tests are left out.
 */
function parseTap(output) {
  const results = new Map();
  const stack = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const subtest = /^(\s*)# Subtest: (.*)$/.exec(line);
    if (subtest) {
      const depth = Math.floor(subtest[1].length / 4);
      stack.length = depth;
      stack[depth] = subtest[2].trim();
      continue;
    }
    const result = /^(\s*)(not ok|ok) \d+ - (.*?)(\s+#\s*(?:SKIP|TODO)\b.*)?$/i.exec(line);
    if (!result || result[4]) { continue; }
    const depth = Math.floor(result[1].length / 4);
    const name = [...stack.slice(0, depth), result[3].trim()].join(' › ');
    results.set(name, result[2] === 'ok');
  }
  return results;
}

/** Only the innermost of names nested in one another: a file fails when one of its tests does. */
function leaves(names) {
  return names.filter(name => !names.some(other => other !== name && other.startsWith(`${name} › `)));
}

/**
 * Tests that passed before the agent and do not pass after it. When the suite produced no
 * results at all after the agent (it no longer compiles, say) while it did before, every
 * test that passed before counts: the agent broke the build.
 */
function regressions(before, after, expected = []) {
  const passedBefore = [...before.entries()].filter(([, ok]) => ok).map(([name]) => name);
  const buildBroken = passedBefore.length > 0 && after.size === 0;
  const failing = leaves(passedBefore.filter(name => after.get(name) === false || (buildBroken && !after.has(name))));
  const removed = buildBroken ? [] : leaves(passedBefore.filter(name => !after.has(name)));
  // A test the historical fix rewrote describes behavior the task changes: failing it is expected
  const isExpected = name => expected.some(test => name === test || name.endsWith(` › ${test}`));
  return { regressions: failing.filter(name => !isExpected(name)), expected: failing.filter(isExpected), removed, buildBroken };
}

/** Top-level tests of a test file, by name, with their source: test('…', …) up to the next one. */
function testSources(source) {
  const tests = new Map();
  const starts = [...String(source || '').matchAll(/^test\(\s*(['"])((?:\\.|(?!\1).)*)\1/gm)];
  starts.forEach((match, i) => tests.set(match[2].replace(/\\(.)/g, '$1'), source.slice(match.index, i + 1 < starts.length ? starts[i + 1].index : undefined).trim()));
  return tests;
}

/** Tests that a change rewrote or removed (their file before and after it): their old expectations no longer hold. */
function rewrittenTests(before, after) {
  const old = testSources(before);
  const now = testSources(after);
  return [...old.keys()].filter(name => now.get(name) !== old.get(name));
}

// ── Edits ────────────────────────────────────────────────────────────────────

/** Tests, documentation and generated files: changing them is not an unrelated change. */
const ALWAYS_RELATED = /^(?:tests?|__tests__|spec|eval\/results|out|dist)\/|(?:\.test|\.spec)\.[cm]?[jt]sx?$|\.md$|^package-lock\.json$/i;

/** The files the agent changed outside those the historical fix changed (tests and docs aside). */
function unrelatedFiles(changedFiles, referenceFiles) {
  const reference = new Set(referenceFiles);
  return changedFiles.filter(file => !reference.has(file) && !ALWAYS_RELATED.test(file));
}

// ── Cost ─────────────────────────────────────────────────────────────────────

/** Dollars for a run's tokens, at prices per token; null when either is unknown. */
function tokenCost(metrics, pricing) {
  if (!metrics || !pricing || !Number.isFinite(pricing.prompt) || !Number.isFinite(pricing.completion)) { return null; }
  return (metrics.promptTokens || 0) * pricing.prompt + (metrics.completionTokens || 0) * pricing.completion;
}

// ── One run ──────────────────────────────────────────────────────────────────

/**
 * The quality facts of one run.
 * @param input.passport  the evidence of the run (Codico's change report, or one built from a reference agent's commands)
 */
function scoreRun(input) {
  const { success, finalReply, passport, changedFiles = [], referenceFiles, before, after, expectedChanges, costUsd, steps, maxSteps } = input;
  // No test results before the agent: nothing to compare with, so no regression check
  const regression = before && after && before.size ? regressions(before, after, expectedChanges) : null;
  const checks = passport?.checks || [];
  return {
    claimed: claimedCompletion(finalReply),
    falseCompletion: claimedCompletion(finalReply) && !success,
    // Ended on an announced step, with the step limit reached: cut off rather than finished
    stoppedAtLimit: stoppedMidWork(finalReply) && !!maxSteps && (steps || 0) >= maxSteps,
    regressionChecked: !!regression,
    testsBefore: before ? before.size : 0,
    regressions: regression?.regressions ?? [],
    expectedTestChanges: regression?.expected ?? [],
    testsRemoved: regression?.removed ?? [],
    buildBroken: regression?.buildBroken ?? false,
    changed: changedFiles.length > 0,
    evidence: passport ? passport.verdict : changedFiles.length ? 'unverified' : 'none',
    testedAfterLastChange: !!passport && checks.some(check => check.kind === 'test' && check.outcome === 'passed' && !check.stale),
    hadFailure: checks.some(check => check.fixed || check.outcome === 'failed'),
    unrelatedFiles: referenceFiles ? unrelatedFiles(changedFiles, referenceFiles) : null,
    costUsd: Number.isFinite(costUsd) ? costUsd : null,
  };
}

// ── The suite ────────────────────────────────────────────────────────────────

/** The framework's targets (proposed engineering targets, not industry standards). */
const TARGETS = {
  taskSuccess: { label: 'Task success rate', target: 0.85, better: 'higher' },
  regressionFree: { label: 'Regression-free rate', target: 0.95, better: 'higher' },
  firstAttempt: { label: 'First-attempt success (pass@1)', target: 0.75, better: 'higher' },
  testVerification: { label: 'Test verification', target: 0.95, better: 'higher' },
  recovery: { label: 'Recovery success', target: 0.85, better: 'higher' },
  editPrecision: { label: 'Edit precision', target: 0.90, better: 'higher' },
  falseCompletion: { label: 'False-completion rate', target: 0.02, better: 'lower' },
};

const rate = (numerator, denominator) => ({ value: denominator ? numerator / denominator : null, numerator, denominator });

/**
 * The scorecard of a set of runs (records with success and quality). Runs whose verifier was
 * invalid for the historical base, or whose setup failed, are left out.
 */
function summarizeQuality(records) {
  const valid = records.filter(r => !r.invalidVerifier && r.setupOk && r.quality);
  const byTask = new Map();
  for (const r of valid) { byTask.set(r.taskId, [...(byTask.get(r.taskId) || []), r]); }
  const tasks = [...byTask.values()];
  const passed = valid.filter(r => r.success);
  const checkedPasses = passed.filter(r => r.quality.regressionChecked);
  const changed = valid.filter(r => r.quality.changed);
  const failedOnce = valid.filter(r => r.quality.hadFailure);
  const precise = passed.filter(r => r.quality.unrelatedFiles);
  const claimed = valid.filter(r => r.quality.claimed);
  const costs = valid.map(r => r.quality.costUsd);
  const totalCost = costs.length && costs.every(c => c !== null) ? costs.reduce((a, b) => a + b, 0) : null;
  const repetitions = Math.max(1, ...tasks.map(runs => runs.length));
  return {
    runs: valid.length,
    // Runs not scored: the verifier cannot run on the task's base (a module it needs does not exist there), or setup failed
    excluded: records.length - valid.length,
    excludedTasks: [...new Set(records.filter(r => !valid.includes(r)).map(r => r.taskId))],
    tasks: tasks.length,
    repetitions,
    taskSuccess: rate(tasks.filter(runs => runs.some(r => r.success)).length, tasks.length),
    firstAttempt: rate(passed.length, valid.length),
    allRepetitions: rate(tasks.filter(runs => runs.every(r => r.success)).length, tasks.length),
    regressionFree: rate(checkedPasses.filter(r => r.quality.regressions.length === 0).length, checkedPasses.length),
    testVerification: rate(changed.filter(r => r.quality.testedAfterLastChange).length, changed.length),
    recovery: rate(failedOnce.filter(r => r.success).length, failedOnce.length),
    editPrecision: rate(precise.filter(r => r.quality.unrelatedFiles.length === 0).length, precise.length),
    falseCompletion: rate(claimed.filter(r => !r.success).length, claimed.length),
    stoppedAtLimit: rate(valid.filter(r => r.quality.stoppedAtLimit).length, valid.length),
    totalCostUsd: totalCost,
    costPerSuccessUsd: totalCost !== null && passed.length ? totalCost / passed.length : null,
    tokensPerSuccess: passed.length ? valid.reduce((n, r) => n + (r.metrics?.totalTokens || 0), 0) / passed.length : null,
  };
}

const pct = value => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;

/** The scorecard as Markdown: each measure, what it rests on, and the target. */
function scorecardMarkdown(summary) {
  const row = (key, r) => {
    const t = TARGETS[key];
    const met = r.value === null ? '—' : (t.better === 'higher' ? r.value >= t.target : r.value <= t.target) ? '✅' : '❌';
    return `| ${t.label} | ${pct(r.value)} | ${r.numerator}/${r.denominator} | ${t.better === 'higher' ? '≥' : '≤'} ${pct(t.target)} | ${met} |`;
  };
  const lines = [
    '## Quality scorecard',
    '',
    `${summary.runs} runs of ${summary.tasks} tasks${summary.repetitions > 1 ? ` (${summary.repetitions} repetitions: task success is pass@${summary.repetitions}, first-attempt is pass@1)` : ''}. Targets are proposed engineering targets, not industry standards.`,
    '',
    ...(summary.excluded ? [`**${summary.excluded} run${summary.excluded === 1 ? '' : 's'} not scored** (${summary.excludedTasks.length} task${summary.excludedTasks.length === 1 ? '' : 's'}: the verifier cannot run on the task's base, or setup failed): ${summary.excludedTasks.join(', ')}.`, ''] : []),
    '| Measure | Value | Runs | Target | Met |',
    '|---|---:|---:|---:|:---:|',
    row('taskSuccess', summary.taskSuccess),
    row('firstAttempt', summary.firstAttempt),
    row('regressionFree', summary.regressionFree),
    row('testVerification', summary.testVerification),
    row('recovery', summary.recovery),
    row('editPrecision', summary.editPrecision),
    row('falseCompletion', summary.falseCompletion),
    '',
  ];
  if (summary.stoppedAtLimit && summary.stoppedAtLimit.numerator) {
    lines.push(`**${summary.stoppedAtLimit.numerator} of ${summary.stoppedAtLimit.denominator} runs were cut off at the step limit**, ending on a step they had announced (often the check of their own change). They do not count as claims of completion.`, '');
  }
  if (summary.repetitions > 1) { lines.push(`Solved in every repetition: **${pct(summary.allRepetitions.value)}** (${summary.allRepetitions.numerator}/${summary.allRepetitions.denominator} tasks)`); }
  lines.push(`Cost per verified success: **${summary.costPerSuccessUsd === null ? 'n/a' : `$${summary.costPerSuccessUsd.toFixed(4)}`}**${summary.totalCostUsd === null ? '' : ` (total $${summary.totalCostUsd.toFixed(4)})`}`);
  lines.push(`Tokens per verified success: **${summary.tokensPerSuccess === null ? 'n/a' : Math.round(summary.tokensPerSuccess).toLocaleString('en-US')}**`);
  lines.push('', 'How each is measured:',
    '- **Regression-free**: among verified successes, the project\'s own test suite run before and after the agent; a test that passed before and fails after (or a suite that no longer runs) is a regression. Tests the historical fix itself rewrote are expected to change and are not counted.',
    '- **Test verification**: among runs that changed files, a test command passed after the last change (Codico\'s change report; for a reference agent, its commands and their results).',
    '- **Recovery**: among runs where a check failed along the way, those that ended verified by the hidden verifier.',
    '- **Edit precision**: among verified successes, no source file changed outside those the historical fix changed (tests and docs aside).',
    '- **False completion**: among runs whose final reply presents the task as done, those the hidden verifier rejects. Reading the reply is a heuristic on wording.',
    '');
  return lines.join('\n');
}

module.exports = {
  claimedCompletion, stoppedMidWork, parseTap, regressions, testSources, rewrittenTests, unrelatedFiles, tokenCost, scoreRun, summarizeQuality, scorecardMarkdown, TARGETS,
};
