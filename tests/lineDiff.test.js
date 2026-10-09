const test = require('node:test');
const assert = require('node:assert/strict');
const { computeLineDiff } = require('../out/lineDiff.js');

const lines = (n, f = i => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n');

test('a change far below line 500 is shown, with context', () => {
  const before = lines(1200);
  const after = before.replace('line 900\n', 'line 900 CHANGED\n');
  const diff = computeLineDiff(before, after);
  assert.notEqual(diff, '', 'never an empty diff for a real change');
  assert.match(diff, /^@@\n line 897\n line 898\n line 899\n-line 900\n\+line 900 CHANGED\n line 901\n line 902\n line 903$/);
});

test('an insertion near the top of a large file does not mark the whole rest as changed', () => {
  const before = lines(900);
  const after = 'NEW HEADER\n' + before;
  const diff = computeLineDiff(before, after);
  assert.equal(diff, '+NEW HEADER\n line 1\n line 2\n line 3');
});

test('identical content gives an empty diff; separate changes become separate hunks', () => {
  assert.equal(computeLineDiff('a\nb', 'a\nb'), '');
  const before = lines(40);
  const after = before.replace('line 5\n', 'five\n').replace('line 35\n', 'thirty-five\n');
  const hunks = computeLineDiff(before, after).split('\n@@\n');
  assert.equal(hunks.length, 2);
  assert.match(hunks[0], /-line 5\n\+five/);
  assert.match(hunks[1], /-line 35\n\+thirty-five/);
});

test('a huge changed region still shows its lines instead of nothing', () => {
  const before = lines(3000, i => `old ${i}`);
  const after = lines(3000, i => `new ${i}`);
  const diff = computeLineDiff(before, after, 50);
  assert.match(diff, /^-old 1\n-old 2/);
  assert.match(diff, /…$/);
});
