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
  assert.match(text, /Where the request gives an example \(an input and what it must produce\), test that very input through the code the user calls/);
  assert.match(text, /it is normalized at every entry point the request names, each form it accepts and the code callers use/);
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

test('request check requires direct service or action input, independently of parsers', () => {
  const message = requestCheckGuidance(changed().build());
  assert.match(message, /Exercise the owning service\/action directly with raw unconverted input/);
  assert.match(message, /parser-to-service tests alone cannot prove this/);
});
