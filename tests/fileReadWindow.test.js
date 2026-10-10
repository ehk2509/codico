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
