const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveEditMatch, applyEditMatch, editFailureContext } = require('../out/editMatcher.js');

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

test('an edit matched without its indentation takes the file\'s, not both', () => {
  const source = 'def add(a, b):\n    return a - b\n';
  // Tab-indented old and new text, in a file indented with spaces (seen with qwen3 on Ollama)
  const one = resolveEditMatch(source, '\treturn a - b');
  assert.equal(one.match.mode, 'trimmed-boundary');
  assert.equal(applyEditMatch(source, one.match, '\treturn a + b', '\treturn a - b'), 'def add(a, b):\n    return a + b\n');
  // Outer newlines of the new text are not added a second time
  const two = resolveEditMatch(source, '\n    return a - b\n');
  assert.equal(applyEditMatch(source, two.match, '\n    return a + b\n', '\n    return a - b\n'), source.replace('-', '+'));
  // Several lines: the tab of each line becomes the file's four spaces, also on a line the edit adds
  const many = resolveEditMatch(source, 'def add(a, b):\n\treturn a - b');
  assert.equal(many.match.mode, 'whitespace-tolerant');
  assert.equal(applyEditMatch(source, many.match, 'def add(a, b):\n\tif a is None:\n\t\treturn b\n\treturn a + b', 'def add(a, b):\n\treturn a - b'),
    'def add(a, b):\n    if a is None:\n        return b\n    return a + b\n');
});

test('a file indented with tabs keeps its tabs', () => {
  const source = 'function f() {\n\tif (x) {\n\t\tgo();\n\t}\n}';
  const requested = 'if (x) {\n    go();\n}';
  const result = resolveEditMatch(source, requested);
  assert.equal(applyEditMatch(source, result.match, 'if (x) {\n    stop();\n    go();\n}', requested),
    'function f() {\n\tif (x) {\n\t\tstop();\n\t\tgo();\n\t}\n}');
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


test('failed edit recovery returns nearby current source around a unique requested anchor', () => {
  const source = [
    'const before = 1;',
    'function resumeStream() {',
    '  const existing = true;',
    '  return existing;',
    '}',
    'const after = 2;',
  ].join('\n');

  const requested = [
    'function resumeStream() {',
    '  const stale = true;',
    '  return stale;',
    '}',
  ].join('\n');

  const excerpt = editFailureContext(source, requested, 1);
  assert.match(excerpt, /2: function resumeStream\(\)/);
  assert.match(excerpt, /3:   const existing = true;/);
  assert.doesNotMatch(excerpt, /const after = 2/);
});

test('failed edit recovery stays empty when no meaningful anchor exists', () => {
  assert.equal(editFailureContext('const actual = 1;', 'totally different words'), '');
});
