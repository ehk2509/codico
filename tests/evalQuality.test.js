const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { claimedCompletion, parseTap, regressions, unrelatedFiles, tokenCost, scoreRun, summarizeQuality, scorecardMarkdown } = require('../scripts/eval/quality.js');
const { claudeCodeEvidence } = require('../scripts/eval/agents.js');
const { compare, signTest } = require('../scripts/eval/compare.js');
const { PassportRecorder } = require('../out/patchPassport.js');

test('a reply that presents the task as done is a claim; questions and admissions are not', () => {
  assert.equal(claimedCompletion('Fixed the EOF handling in streamCompletion.ts. All 238 tests pass.'), true);
  assert.equal(claimedCompletion('Done. If you want me to also cover gzip streams, let me know.'), true);
  assert.equal(claimedCompletion('Should the error be retried, or reported to the user?'), false);
  assert.equal(claimedCompletion('Which file?\n<clarify>\nquestion: Which file?\n</clarify>'), false);
  assert.equal(claimedCompletion("I couldn't reproduce the failure, so nothing was changed."), false);
  assert.equal(claimedCompletion('The parser is updated, but two tests still fail on Windows paths.'), false);
  assert.equal(claimedCompletion(''), false);
});

// A child of a test reports to its parent runner, not as TAP, unless it is told it runs on its own
const withoutTestContext = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));

test('TAP from node --test: every test by its full name, skipped ones left out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-tap-'));
  fs.writeFileSync(path.join(dir, 'a.test.js'), `
const test = require('node:test');
test('adds', () => {});
test('group', async t => { await t.test('inner passes', () => {}); await t.test('inner fails', () => { throw new Error('x'); }); });
test('skipped', { skip: true }, () => {});
`);
  const out = cp.spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'a.test.js'], { cwd: dir, encoding: 'utf8', env: withoutTestContext() }).stdout;
  const results = parseTap(out);
  assert.equal(results.get('adds'), true);
  assert.equal(results.get('group › inner passes'), true);
  assert.equal(results.get('group › inner fails'), false);
  assert.equal(results.get('group'), false);
  assert.equal([...results.keys()].some(name => /skipped/.test(name)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('regressions: tests that passed before and fail after, innermost only; a suite that stops running breaks all', () => {
  const before = new Map([['a', true], ['g', true], ['g › x', true], ['g › y', true], ['old failure', false], ['gone', true]]);
  const after = new Map([['a', true], ['g', false], ['g › x', true], ['g › y', false], ['old failure', false]]);
  assert.deepEqual(regressions(before, after), { regressions: ['g › y'], removed: ['gone'], buildBroken: false });
  const broken = regressions(before, new Map());
  assert.equal(broken.buildBroken, true);
  assert.deepEqual(broken.regressions, ['a', 'g › x', 'g › y', 'gone']);
  // No tests found before the agent: not a check that passed, no check at all
  assert.equal(scoreRun({ success: true, before: new Map(), after: new Map() }).regressionChecked, false);
  assert.equal(scoreRun({ success: true, before, after }).testsBefore, 6);
  // A failure that was already there is not the agent's
  assert.deepEqual(regressions(new Map([['t', false]]), new Map([['t', false]])).regressions, []);
});

test('edit precision: source files outside the historical fix are unrelated; tests and docs never are', () => {
  assert.deepEqual(unrelatedFiles(['src/stream.ts', 'tests/stream.test.js', 'README.md', 'src/other.ts'], ['src/stream.ts', 'tests/streamCompletion.test.js']), ['src/other.ts']);
  assert.deepEqual(unrelatedFiles(['src/stream.ts'], ['src/stream.ts']), []);
});

test('cost from tokens at per-token prices; unknown prices give no cost', () => {
  assert.equal(tokenCost({ promptTokens: 1_000_000, completionTokens: 100_000 }, { prompt: 0.3e-6, completion: 1.2e-6 }).toFixed(4), '0.4200');
  assert.equal(tokenCost({ promptTokens: 1 }, null), null);
});

test("Claude Code's run read from its event stream: the checks it ran, after its last edit, and its cost", () => {
  const events = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: '# pass 10\n# fail 1\n' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixing.' }, { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/w/src/a.ts' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test 2>&1 | tail -5' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: [{ type: 'text', text: '# pass 11\n# fail 0\n' }] }] } },
    { type: 'result', result: 'Fixed: all 11 tests pass.', is_error: false, total_cost_usd: 0.1234, num_turns: 4, duration_ms: 9000, usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 } },
  ];
  const evidence = claudeCodeEvidence(['not json', ...events.map(e => JSON.stringify(e))].join('\n'), PassportRecorder);
  assert.equal(evidence.passport.verdict, 'verified');
  assert.equal(evidence.passport.checks[0].fixed, true);
  assert.equal(evidence.finalReply, 'Fixed: all 11 tests pass.');
  assert.equal(evidence.costUsd, 0.1234);
  assert.deepEqual([evidence.metrics.promptTokens, evidence.metrics.completionTokens, evidence.metrics.toolCalls, evidence.metrics.steps], [1000, 50, 3, 4]);
  const quality = scoreRun({ success: true, finalReply: evidence.finalReply, passport: evidence.passport, changedFiles: ['src/a.ts'], referenceFiles: ['src/a.ts'], costUsd: evidence.costUsd });
  assert.deepEqual([quality.testedAfterLastChange, quality.hadFailure, quality.claimed, quality.falseCompletion], [true, true, true, false]);
});

const run = (taskId, success, quality, extra = {}) => ({ taskId, setupOk: true, success, metrics: { totalTokens: 1000 }, quality: {
  claimed: true, regressionChecked: true, regressions: [], changed: true, testedAfterLastChange: true, hadFailure: false, unrelatedFiles: [], costUsd: 0.01, ...quality }, ...extra });

test('the scorecard: each measure over the runs it applies to, pass@k against pass@1', () => {
  const records = [
    run('t1', true, {}), run('t1', false, { hadFailure: true }),
    run('t2', true, { regressions: ['other test'], hadFailure: true }), run('t2', true, { unrelatedFiles: ['src/x.ts'] }),
    run('t3', false, { claimed: false, testedAfterLastChange: false }), run('t3', false, { claimed: true }),
    { taskId: 't4', invalidVerifier: true, setupOk: false },
  ];
  const s = summarizeQuality(records);
  assert.deepEqual([s.runs, s.tasks, s.repetitions], [6, 3, 2]);
  assert.deepEqual([s.taskSuccess.numerator, s.taskSuccess.denominator], [2, 3]);
  assert.deepEqual([s.firstAttempt.numerator, s.firstAttempt.denominator], [3, 6]);
  assert.deepEqual([s.allRepetitions.numerator, s.regressionFree.numerator, s.regressionFree.denominator], [1, 2, 3]);
  assert.deepEqual([s.testVerification.numerator, s.testVerification.denominator], [5, 6]);
  assert.deepEqual([s.recovery.numerator, s.recovery.denominator], [1, 2]);
  assert.deepEqual([s.editPrecision.numerator, s.editPrecision.denominator], [2, 3]);
  assert.deepEqual([s.falseCompletion.numerator, s.falseCompletion.denominator], [2, 5]);
  assert.equal(s.costPerSuccessUsd.toFixed(4), '0.0200');
  const md = scorecardMarkdown(s);
  assert.match(md, /\| Task success rate \| 66\.7% \| 2\/3 \| ≥ 85\.0% \| ❌ \|/);
  assert.match(md, /\| False-completion rate \| 40\.0% \| 2\/5 \| ≤ 2\.0% \| ❌ \|/);
  assert.match(md, /pass@2/);
  assert.deepEqual([s.excluded, s.excludedTasks], [1, ['t4']]);
  assert.match(md, /\*\*1 run not scored\*\* \(1 task: [^)]*\): t4\./);
});

test('two results compared task by task, with a sign test', () => {
  assert.equal(signTest(0, 0), 1);
  assert.equal(signTest(5, 0).toFixed(4), '0.0625');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-cmp-'));
  const write = (dir, records) => { fs.mkdirSync(dir); records.forEach((r, i) => fs.writeFileSync(path.join(dir, `${r.taskId}-${i}.json`), JSON.stringify(r))); fs.writeFileSync(path.join(dir, 'summary.json'), '{}'); };
  write(path.join(root, 'a'), [run('t1', true, {}, { agent: 'codico', model: 'm1' }), run('t2', true, {}), run('t3', false, {})]);
  write(path.join(root, 'b'), [run('t1', false, {}, { agent: 'claude-code' }), run('t2', true, {}), run('t9', true, {})]);
  const md = compare(path.join(root, 'a'), path.join(root, 'b'));
  assert.match(md, /\*\*A\*\*: codico \(m1\)/);
  assert.match(md, /2 tasks run by both \(tasks only one side ran are left out\)/);
  assert.match(md, /A better on \*\*1\*\*, B better on \*\*0\*\*, equal on \*\*1\*\*/);
  assert.match(md, /\| t1 \| 1\/1 \| 0\/1 \| A \|/);
  fs.rmSync(root, { recursive: true, force: true });
});
