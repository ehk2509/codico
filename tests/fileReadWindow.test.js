const test = require('node:test');
const assert = require('node:assert/strict');
const { sliceFileByLines } = require('../out/fileReadWindow.js');

test('small files are returned whole by default', () => {
  const result = sliceFileByLines('a\nb\nc');
  assert.deepEqual(
    { text: result.text, start: result.startLine, end: result.endLine, total: result.totalLines, truncated: result.truncated },
    { text: 'a\nb\nc', start: 1, end: 3, total: 3, truncated: false },
  );
});

test('large default reads are bounded and explicit ranges are clamped', () => {
  const content = Array.from({ length: 1000 }, (_, i) => 'line ' + (i + 1)).join('\n');
  const first = sliceFileByLines(content);
  assert.equal(first.startLine, 1);
  assert.equal(first.endLine, 300);
  assert.equal(first.truncated, true);

  const range = sliceFileByLines(content, 450, 900);
  assert.equal(range.startLine, 450);
  assert.equal(range.endLine, 849);
  assert.match(range.text, /^line 450/);
  assert.match(range.text, /line 849$/);
});

test('a large file outline lists symbols with line ranges, nested one level', () => {
  const { formatOutline } = require('../out/fileReadWindow.js');
  const text = formatOutline([
    { name: 'AgentProvider', kind: 'class', startLine: 40, endLine: 2800, depth: 0 },
    { name: '_handleReadFile', kind: 'method', startLine: 2040, endLine: 2066, depth: 1 },
    { name: 'activate', kind: 'function', startLine: 2810, endLine: 2830, depth: 0 },
  ]);
  assert.equal(text, 'L40–2800  class AgentProvider\n  L2040–2066  method _handleReadFile\nL2810–2830  function activate');
  const many = formatOutline(Array.from({ length: 5 }, (_, i) => ({ name: 'f' + i, kind: 'function', startLine: i + 1, endLine: i + 1, depth: 0 })), 3);
  assert.match(many, /… 2 more symbols/);
});

test('reads are numbered like cat -n, from the line the window starts at', () => {
  const { numberLines } = require('../out/fileReadWindow.js');
  assert.equal(numberLines('a\n\n  c', 1), '1\ta\n2\t\n3\t  c');
  assert.equal(numberLines('x\ny', 998), '998\tx\n999\ty');
});

test('line numbers copied from a read are taken off an edit, and only then', () => {
  const { withoutLineNumbers } = require('../out/fileReadWindow.js');
  const { withoutCopiedLineNumbers } = require('../out/editMatcher.js');
  assert.equal(withoutLineNumbers('12\tconst a = 1;\n13\t\n14\t  return a;'), 'const a = 1;\n\n  return a;');
  assert.equal(withoutLineNumbers('  7\tx'), 'x');
  // Not numbered lines: left alone
  assert.equal(withoutLineNumbers('const a = 1;\n13\treturn a;'), null);
  assert.equal(withoutLineNumbers('12 const a = 1;'), null, 'a number and a space is code, not a line number');
  assert.equal(withoutLineNumbers(''), null);

  const source = 'alpha=1\nbeta=2\ngamma=3\n';
  assert.deepEqual(withoutCopiedLineNumbers(source, '2\tbeta=2', '2\tbeta=20'), { oldText: 'beta=2', newText: 'beta=20' });
  // The new text was written without numbers: it is used as it is
  assert.deepEqual(withoutCopiedLineNumbers(source, '2\tbeta=2\n3\tgamma=3', 'beta=20\ngamma=30'), { oldText: 'beta=2\ngamma=3', newText: 'beta=20\ngamma=30' });
  // The old text matches as given: nothing is touched, even if it looks numbered
  const tsv = '1\tone\n2\ttwo\n';
  assert.deepEqual(withoutCopiedLineNumbers(tsv, '2\ttwo', '2\tTWO'), { oldText: '2\ttwo', newText: '2\tTWO' });
  // Stripping would not match either: left for the normal "not found" message
  assert.deepEqual(withoutCopiedLineNumbers(source, '9\tdelta=4', '9\tx'), { oldText: '9\tdelta=4', newText: '9\tx' });
});

test('the prompt asks for looks to be batched, and for files to be read with the read tool', () => {
  const { SYSTEM_PROMPT } = require('../out/openRouterClient.js');
  const { NATIVE_TOOL_PROMPT } = require('../out/nativeTools.js');
  assert.doesNotMatch(SYSTEM_PROMPT, /one tool fence at a time|One tool per response/i);
  assert.match(SYSTEM_PROMPT, /issue them together in the same response/);
  assert.match(SYSTEM_PROMPT, /never with run_terminal \(no cat, sed, awk, head, tail or grep/);
  assert.match(SYSTEM_PROMPT, /start_line: <optional first line>/);
  assert.match(NATIVE_TOOL_PROMPT, /several tool calls in the same response/);
  // Rule numbers stay in sequence
  const rules = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf('## Rules')).match(/^\d+(?=\. )/gm).map(Number);
  assert.deepEqual(rules, rules.map((_, i) => i + 1));
});

