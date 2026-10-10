const test = require('node:test');
const assert = require('node:assert/strict');

const { PassportRecorder, classifyCheck, checkKey, testSummary, countChangedLines, passportMarkdown } = require('../out/patchPassport.js');

test('which commands count as checks', () => {
  const kinds = (commands) => commands.map(classifyCheck);
  assert.deepEqual(kinds(['npm test', 'npm run test:ui', 'yarn test --watch=false', 'pnpm run e2e', 'npx jest src/a.test.ts', 'node --test tests/a.test.js',
    'node --test-name-pattern="x" --test tests/a.js', 'pytest -q', 'python -m pytest tests', 'go test ./...', 'cargo test', 'mvn -q test', './gradlew test', 'make test']),
    Array(14).fill('test'));
  assert.deepEqual(kinds(['npx tsc --noEmit', 'npm run typecheck', 'mypy src', 'cargo check']), Array(4).fill('typecheck'));
  assert.deepEqual(kinds(['npx eslint src', 'npm run lint', 'ruff check .', 'cargo clippy']), Array(4).fill('lint'));
  assert.deepEqual(kinds(['npm run compile', 'npm run build', 'cargo build --release', 'go build ./...', 'make']), Array(5).fill('build'));
  // Not checks: looking around, version control, searching for the word "test", a script of one's own
  assert.deepEqual(kinds(['ls tests', 'git status', 'grep -rn "npm test" .', 'cat package.json', 'node tmp/qa-verify.js', 'npm install', 'echo npm test', 'find . -name "*.test.js"', 'npx tsc --init']),
    Array(9).fill(null));
});

test('what only changes the output is ignored when comparing commands', () => {
  assert.equal(checkKey('cd /home/me/project && timeout 400 npm test 2>&1 | tail -20'), 'npm test');
  assert.equal(checkKey('CI=1 FORCE_COLOR=0 npm run test:ui 2>&1 | grep -E "^# (pass|fail)"'), 'npm run test:ui');
  assert.equal(checkKey('npm test'), checkKey('cd . && npm test | tail -5'));
  assert.equal(classifyCheck('cd /repo && timeout 300 npm run compile 2>&1 | tail -n 30'), 'build');
  // Different tests are different checks
  assert.notEqual(checkKey('node --test tests/a.js'), checkKey('node --test tests/b.js'));
});

test('test summaries of common runners', () => {
  assert.deepEqual(testSummary('ok 1 - a\n# tests 238\n# pass 238\n# fail 0\n'), { passed: 238, failed: 0 });
  assert.deepEqual(testSummary('# pass 10\n# fail 2\n'), { passed: 10, failed: 2 });
  assert.deepEqual(testSummary('Tests:       1 failed, 41 passed, 42 total\n'), { passed: 41, failed: 1 });
  assert.deepEqual(testSummary('\x1b[32m Tests \x1b[0m 12 passed (12)\n'), { passed: 12, failed: 0 });
  assert.deepEqual(testSummary('===== 3 failed, 20 passed in 1.42s =====\n'), { passed: 20, failed: 3 });
  assert.deepEqual(testSummary('======================== 20 passed in 0.31s ========================\n'), { passed: 20, failed: 0 });
  assert.deepEqual(testSummary('  14 passing (2s)\n  1 failing\n'), { passed: 14, failed: 1 });
  assert.deepEqual(testSummary('test result: FAILED. 7 passed; 2 failed; 0 ignored\n'), { passed: 7, failed: 2 });
  // The last summary wins when a command runs several suites
  assert.deepEqual(testSummary('# pass 5\n# fail 1\n...\n# pass 9\n# fail 0\n'), { passed: 9, failed: 0 });
  assert.equal(testSummary('compiled successfully\n'), null);
});

test('lines added and removed', () => {
  assert.deepEqual(countChangedLines('a\nb\nc\n', 'a\nB\nc\n'), { added: 1, removed: 1 });
  assert.deepEqual(countChangedLines('', 'one\ntwo\n'), { added: 2, removed: 0 });
  assert.deepEqual(countChangedLines('one\ntwo\n', ''), { added: 0, removed: 2 });
  assert.deepEqual(countChangedLines('a\nb\n', 'a\nb\n'), { added: 0, removed: 0 });
  assert.deepEqual(countChangedLines('a\r\nb\r\n', 'a\nb\nc\n'), { added: 1, removed: 0 }, 'line endings alone are not a change');
  assert.deepEqual(countChangedLines('1\n2\n3\n4\n5\n', '1\nx\n3\n4\ny\n5\nz\n'), { added: 3, removed: 1 });
  const big = Array.from({ length: 3000 }, (_, i) => 'line ' + i).join('\n');
  assert.deepEqual(countChangedLines(big, big.replace('line 1500', 'changed')), { added: 1, removed: 1 });
});

test('no file changed: no report', () => {
  const r = new PassportRecorder();
  r.recordCommand('npm test', 0, '# pass 3\n# fail 0\n');
  assert.equal(r.build(), undefined);
  // A file changed and then put back as it was is not a change
  r.recordChange('a.ts', 'x\n', 'y\n');
  r.recordChange('a.ts', 'y\n', 'x\n');
  assert.equal(r.build(), undefined);
});

test('verified: a check passed after the last change, and a check that failed first is marked as fixed', () => {
  const r = new PassportRecorder();
  r.recordCommand('npm test 2>&1 | tail -5', 0, '# pass 9\n# fail 1\n');   // the failure the task is about
  r.recordChange('src/a.ts', 'old\n', 'new\nmore\n');
  r.recordChange('tests/a.test.js', null, 'test\n');
  r.recordCommand('cd /repo && npm test | tail -5', 0, '# pass 10\n# fail 0\n');
  r.recordCommand('npm run compile', 0, 'Done');
  const p = r.build();
  assert.equal(p.verdict, 'verified');
  assert.deepEqual(p.files, [
    { path: 'src/a.ts', status: 'modified', added: 2, removed: 1, edits: 1, checked: true },
    { path: 'tests/a.test.js', status: 'created', added: 1, removed: 0, edits: 1, checked: true },
  ]);
  assert.deepEqual(p.checks, [
    { command: 'npm test', kind: 'test', outcome: 'passed', detail: '10 passed, 0 failed', stale: false, fixed: true, runs: 2 },
    { command: 'npm run compile', kind: 'build', outcome: 'passed', detail: 'exit 0', stale: false, fixed: false, runs: 1 },
  ]);
  assert.deepEqual(p.notes, []);
});

test('a file changed after the last passing check is called out', () => {
  const r = new PassportRecorder();
  r.recordChange('src/a.ts', 'a\n', 'b\n');
  r.recordCommand('npm test', 0, '# pass 4\n# fail 0\n');
  r.recordChange('src/b.ts', 'a\n', 'b\n');          // after the test run
  const p = r.build();
  // The test ran before the last change: it covers an earlier version of the code
  assert.equal(p.verdict, 'unverified');
  assert.equal(p.checks[0].stale, true);
  assert.deepEqual(p.files.map(f => [f.path, f.checked]), [['src/a.ts', true], ['src/b.ts', false]]);
  assert.deepEqual(p.notes, ['No check was run after the last file change: the checks below cover an earlier version of the code.']);
});

test('changes with no check at all are not verified', () => {
  const r = new PassportRecorder();
  r.recordChange('src/a.ts', 'a\n', 'b\n');
  r.recordCommand('git status', 0, '');
  const p = r.build();
  assert.equal(p.verdict, 'unverified');
  assert.deepEqual(p.checks, []);
  assert.deepEqual(p.notes, ['No test, build, type-check or lint command was run in this turn.']);
});

test('a failing check after the last change', () => {
  const r = new PassportRecorder();
  r.recordChange('src/a.ts', 'a\n', 'b\n');
  r.recordCommand('npm run compile', 0, '');
  r.recordCommand('npm test', 1, 'boom');
  const p = r.build();
  assert.equal(p.verdict, 'failing');
  assert.deepEqual(p.checks.map(c => [c.command, c.outcome, c.detail]), [['npm run compile', 'passed', 'exit 0'], ['npm test', 'failed', 'exit 1']]);
  // A command that did not finish (timed out) is a failure
  const t = new PassportRecorder();
  t.recordChange('a', 'a', 'b'); t.recordCommand('npm test', null, '');
  assert.deepEqual([t.build().verdict, t.build().checks[0].detail], ['failing', 'did not finish']);
});

test('a pipe hides the exit code: success is only believed with a test summary', () => {
  const hidden = new PassportRecorder();
  hidden.recordChange('a', 'a', 'b');
  hidden.recordCommand('npm run compile 2>&1 | tail -5', 0, 'error TS2304: Cannot find name');
  const p = hidden.build();
  assert.equal(p.verdict, 'unverified');
  assert.deepEqual([p.checks[0].outcome, p.checks[0].detail], ['unknown', 'result hidden by a pipe']);
  assert.match(p.notes.join('\n'), /`npm run compile` ran, but its result cannot be told/);
  // The failed tests are seen through the pipe
  const seen = new PassportRecorder();
  seen.recordChange('a', 'a', 'b');
  seen.recordCommand('npm test 2>&1 | tail -5', 0, '# pass 3\n# fail 2\n');
  assert.deepEqual([seen.build().verdict, seen.build().checks[0].detail], ['failing', '3 passed, 2 failed']);
  // pipefail, a quoted bar and "||" are not hidden results
  for (const command of ['set -o pipefail; npm run compile | tail -5', 'npm run compile -- --define "a|b"', 'npm run compile || true']) {
    const r = new PassportRecorder(); r.recordChange('a', 'a', 'b'); r.recordCommand(command, 0, '');
    assert.equal(r.build().checks[0].outcome, 'passed', command);
  }
});

test('only a build passed: verified, with a note that no tests ran', () => {
  const r = new PassportRecorder();
  r.recordChange('a', 'a', 'b');
  r.recordCommand('npx tsc --noEmit', 0, '');
  const p = r.build();
  assert.equal(p.verdict, 'verified');
  assert.deepEqual(p.notes, ['No tests were run: only the build, type-check or lint passed.']);
});

test('several writes to one file count once, from its first state to its last', () => {
  const r = new PassportRecorder();
  r.recordChange('a.ts', '1\n2\n', '1\nx\n');
  r.recordChange('a.ts', '1\nx\n', '1\nx\ny\n');
  const p = r.build();
  assert.deepEqual(p.files, [{ path: 'a.ts', status: 'modified', added: 2, removed: 1, edits: 2, checked: false }]);
});

test('the Markdown form', () => {
  const r = new PassportRecorder();
  r.recordCommand('npm test', 1, '# pass 9\n# fail 1\n');
  r.recordChange('src/a.ts', 'old\n', 'new\n');
  r.recordChange('src/new.ts', null, 'x\ny\n');
  r.recordCommand('npm test', 0, '# pass 10\n# fail 0\n');
  r.recordChange('README.md', 'a\n', 'b\n');
  assert.equal(passportMarkdown(r.build()), [
    '## Change report', '',
    '**Not verified: no check passed after the last change**', '',
    '### Files changed (3, +4 −2)',
    '- `README.md` — +1 −1',
    '- `src/a.ts` — +1 −1',
    '- `src/new.ts` — new, +2 −0',
    '',
    '### Checks',
    '- ✅ `npm test` (test) — 10 passed, 0 failed; was failing earlier in this change; ran before the last change',
    '',
    '### Not covered',
    '- No check was run after the last file change: the checks below cover an earlier version of the code.',
    '',
  ].join('\n'));
});
