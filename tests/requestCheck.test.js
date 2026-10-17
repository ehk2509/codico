const test = require('node:test');
const assert = require('node:assert/strict');
const { requestCheckGuidance } = require('../out/requestCheck.js');
const { PassportRecorder } = require('../out/patchPassport.js');

const changed = (file = 'src/parser.ts') => { const r = new PassportRecorder(); r.recordChange(file, 'a\n', 'b\n'); return r; };

test('a code change with no stated criteria and no reproduced failure: asked for both, and warned off a substitute', () => {
  const r = changed();
  r.recordCommand('npm test', 0, '# pass 9\n# fail 0\n');
  const text = requestCheckGuidance(r.build());
  assert.match(text, /^\[System Acceptance\] Before you finish, show that the request itself is met/);
  assert.match(text, /State its acceptance criteria in the request's own words/);
  assert.match(text, /a test of exactly the scenario they described, which fails without your change and passes with it/);
  assert.match(text, /a new syntax, option or mode that callers must switch to/);
});

test('a test that failed and then passed is the reproduction; with criteria too, nothing is asked', () => {
  const r = changed();
  r.recordCommand('node --test tests/parser.test.js', 1, '# pass 3\n# fail 1\n');
  r.recordCommand('node --test tests/parser.test.js', 0, '# pass 4\n# fail 0\n');
  const reproducedOnly = requestCheckGuidance(r.build());
  assert.match(reproducedOnly, /acceptance criteria/);
  assert.doesNotMatch(reproducedOnly, /fails without your change/);
  r.acceptance.setCriteria(['A normal write_file call keeps inner code fences']);
  assert.equal(requestCheckGuidance(r.build()), undefined);
});

test('no code changed (nothing, or only documentation): nothing is asked', () => {
  assert.equal(requestCheckGuidance(undefined), undefined);
  assert.equal(requestCheckGuidance(changed('README.md').build()), undefined);
  assert.equal(requestCheckGuidance(changed('docs/notes.txt').build()), undefined);
});

test('Codico runs the passing test without the change: a failure there is the reproduction, a pass is said plainly', () => {
  const r = changed();
  r.recordCommand('cd /ws && npm test 2>&1 | tail -5', 0, '# pass 9\n# fail 0\n');
  // The newest passing test on the final code, run as the agent wrote it
  assert.deepEqual(r.reproductionCandidate(), { key: 'npm test', command: 'cd /ws && npm test 2>&1 | tail -5' });
  assert.match(requestCheckGuidance(r.build()), /Codico reruns your passing test with your source changes undone, so you do not need to undo them yourself/);
  r.recordWithoutChange('npm test', 'failed');
  const failed = r.build().checks[0];
  assert.deepEqual([failed.fixed, failed.withoutChange], [true, 'failed']);
  assert.equal(r.reproductionCandidate(), undefined, 'not run again');
  assert.doesNotMatch(requestCheckGuidance(r.build()), /fails without your change/);

  const p = changed();
  p.recordCommand('npm test', 0, '# pass 9\n# fail 0\n');
  p.recordWithoutChange('npm test', 'passed');
  assert.equal(p.build().checks[0].fixed, false);
  assert.match(requestCheckGuidance(p.build()), /Codico ran `npm test` with your changes undone \(your tests kept\), and it still passed: it does not show the problem/);
  // A test that already failed in the turn, or ran before the last change, is not a candidate
  const q = changed();
  q.recordCommand('npm test', 1, '# pass 8\n# fail 1\n'); q.recordCommand('npm test', 0, '# pass 9\n# fail 0\n');
  assert.equal(q.reproductionCandidate(), undefined);
  const s = new PassportRecorder();
  s.recordCommand('npm test', 0, '# pass 9\n# fail 0\n'); s.recordChange('src/a.ts', 'a', 'b');
  assert.equal(s.reproductionCandidate(), undefined);
});
