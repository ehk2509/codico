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

test('a small change whose criteria all rest on a reproduced-then-fixed check needs no review; anything else does', () => {
  const { triviallyCovered } = require('../out/requestCheck.js');
  const make = (lines) => {
    const r = new PassportRecorder();
    r.acceptance.setCriteria(['A normal write_file call keeps inner code fences']);
    r.recordChange('src/toolParser.ts', 'a\n', Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n') + '\n');
    r.recordCommand('node --test tests/toolParser.test.js', 1, '# pass 6\n# fail 1\n');
    const pass = r.recordCommand('node --test tests/toolParser.test.js', 0, '# pass 7\n# fail 0\n');
    r.acceptance.claim('AC1', 'pass', 'the test of the user case', [pass]);
    return r;
  };
  assert.equal(triviallyCovered(make(5).build()), true);
  assert.equal(triviallyCovered(make(40).build()), false, 'a larger change is reviewed');
  // Verified, but on a check that never failed: no reproduction, so it is reviewed
  const r = new PassportRecorder();
  r.acceptance.setCriteria(['works']);
  r.recordChange('src/a.ts', 'x\n', 'y\n');
  const once = r.recordCommand('npm test', 0, '# pass 3\n# fail 0\n');
  r.acceptance.claim('AC1', 'pass', 'ran it', [once]);
  assert.equal(triviallyCovered(r.build()), false);
  assert.equal(triviallyCovered(undefined), false);
});
