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
