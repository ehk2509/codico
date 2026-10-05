const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveEditMatch, applyEditMatch } = require('../out/editMatcher.js');

test('exact unique edit matches are preferred', () => {
  const source = 'before\nconst value = 1;\nafter';
  const result = resolveEditMatch(source, 'const value = 1;');
  assert.equal(result.match.mode, 'exact');
  assert.equal(applyEditMatch(source, result.match, 'const value = 2;'), 'before\nconst value = 2;\nafter');
});

test('outer whitespace drift is tolerated only when unique', () => {
  const source = 'before\nconst value = 1;\nafter';
  const result = resolveEditMatch(source, '\n  const value = 1;  \n');
  assert.equal(result.match.mode, 'trimmed-boundary');
  assert.equal(applyEditMatch(source, result.match, 'const value = 2;'), 'before\nconst value = 2;\nafter');
});

test('indentation and whitespace-run drift can resolve a unique edit', () => {
  const source = [
    'function demo() {',
    '    if (ready) {',
    '        finish();',
    '    }',
    '}',
  ].join('\n');

  const requested = [
    'if (ready) {',
    '  finish();',
    '}',
  ].join('\n');

  const result = resolveEditMatch(source, requested);
  assert.equal(result.match.mode, 'whitespace-tolerant');
  const updated = applyEditMatch(source, result.match, 'if (ready) {\n        complete();\n    }');
  assert.match(updated, /complete\(\)/);
  assert.doesNotMatch(updated, /finish\(\)/);
});

test('ambiguous exact edits are rejected', () => {
  const source = 'const x = 1;\nconst x = 1;';
  assert.deepEqual(resolveEditMatch(source, 'const x = 1;'), { error: 'ambiguous', candidates: 2 });
});

test('ambiguous whitespace-tolerant edits are rejected', () => {
  const source = [
    'if  (ready) {  finish(); }',
    'if   (ready)   {   finish();   }',
  ].join('\n');
  const result = resolveEditMatch(source, 'if (ready) { finish(); }');
  assert.equal(result.error, 'ambiguous');
  assert.ok(result.candidates >= 2);
});

test('semantic text differences are never fuzzed', () => {
  const source = 'if (ready) { finish(); }';
  assert.deepEqual(resolveEditMatch(source, 'if (done) { finish(); }'), { error: 'not_found', candidates: 0 });
});
