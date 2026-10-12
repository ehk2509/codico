const test = require('node:test');
const assert = require('node:assert/strict');
const { computeHunks, withHunks, hunkPreviews, HUNK_PREVIEW_LINES } = require('../out/hunks.js');

const OLD = ['import a', 'import b', '', 'function one() {', '  return 1;', '}', '', 'function two() {', '  return 2;', '}', '', 'export { one, two };'].join('\n');
const NEW = ['import a', 'import b', 'import c', '', 'function one() {', '  return 100;', '}', '', 'function two() {', '  return 2;', '}', '', 'function three() {', '  return 3;', '}', '', 'export { one, two, three };'].join('\n');

test('the separate changes of an edit, each with where it is and what it replaces', () => {
  const hunks = computeHunks(OLD, NEW);
  assert.deepEqual(hunks.map(h => [h.index, h.oldStart, h.removed, h.added]), [
    [0, 2, [], ['import c']],
    [1, 4, ['  return 1;'], ['  return 100;']],
    [2, 11, ['export { one, two };'], ['function three() {', '  return 3;', '}', '', 'export { one, two, three };']],
  ]);
  assert.deepEqual(computeHunks(OLD, OLD), []);
  assert.deepEqual(computeHunks('a\nb', 'a\nb\nc').map(h => [h.oldStart, h.removed, h.added]), [[2, [], ['c']]]);
  assert.deepEqual(computeHunks('a\nb\nc', 'b\nc').map(h => [h.oldStart, h.removed, h.added]), [[0, ['a'], []]]);
  assert.deepEqual(computeHunks('', 'x').map(h => [h.removed, h.added]), [[[''], ['x']]]);
});

test('taking every change gives the new file, none the old one, and any subset is exact', () => {
  assert.equal(withHunks(OLD, NEW, () => true), NEW);
  assert.equal(withHunks(OLD, NEW, () => false), OLD);
  const onlyReturn = withHunks(OLD, NEW, i => i === 1);
  assert.equal(onlyReturn, OLD.replace('return 1;', 'return 100;'));
  const withoutReturn = withHunks(OLD, NEW, i => i !== 1);
  assert.equal(withoutReturn, NEW.replace('return 100;', 'return 1;'));
  // Accepting one change, then looking at what is left: the other two, renumbered
  assert.deepEqual(computeHunks(onlyReturn, NEW).map(h => h.added[0]), ['import c', 'function three() {']);
  // Windows line endings and a missing final newline are part of the lines, so they survive
  const crlf = 'a\r\nb\r\nc\r\nd\r\ne', crlfNew = 'a\r\nB\r\nc\r\nd\r\nE';
  assert.equal(withHunks(crlf, crlfNew, i => i === 0), 'a\r\nB\r\nc\r\nd\r\ne');
  assert.equal(withHunks(crlf, crlfNew, () => true), crlfNew);
});

test('every subset of changes of generated edits is consistent', () => {
  let seed = 7; const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 200; round++) {
    const before = Array.from({ length: 5 + rand(30) }, () => 'line ' + rand(12));
    const after = before.slice();
    for (let k = 0; k < 1 + rand(5); k++) {
      const at = rand(after.length + 1); const kind = rand(3);
      if (kind === 0) { after.splice(at, 0, 'new ' + rand(50)); } else if (kind === 1) { after.splice(at, 1); } else { after.splice(at, 1, 'changed ' + rand(50)); }
    }
    const a = before.join('\n'), b = after.join('\n');
    const hunks = computeHunks(a, b);
    assert.equal(withHunks(a, b, () => true), b);
    assert.equal(withHunks(a, b, () => false), a);
    // One at a time, in any order, ends at the new text
    let current = a;
    while (computeHunks(current, b).length > 0) { const left = computeHunks(current, b); current = withHunks(current, b, i => i === left[rand(left.length)].index); }
    assert.equal(current, b);
    // Rejecting one leaves a text whose remaining changes are the others
    if (hunks.length > 1) { assert.equal(computeHunks(a, withHunks(a, b, i => i !== 0)).length, hunks.length - 1); }
  }
});

test('a rewrite too large to align is one change, and what the panel gets is cut to a few lines', () => {
  const big = Array.from({ length: 700 }, (_, i) => 'old ' + i).join('\n'), bigNew = Array.from({ length: 700 }, (_, i) => 'new ' + i).join('\n');
  assert.equal(computeHunks(big, bigNew).length, 1);
  const [preview] = hunkPreviews(big, bigNew);
  assert.deepEqual([preview.line, preview.removed.length, preview.removedCount, preview.added.length, preview.addedCount], [1, HUNK_PREVIEW_LINES, 700, HUNK_PREVIEW_LINES, 700]);
  assert.equal(hunkPreviews('a', 'x'.repeat(900))[0].added[0].length, 301);
  assert.deepEqual(hunkPreviews(OLD, NEW).map(h => h.line), [3, 5, 12]);
  // A change with no line to show says what it is
  assert.deepEqual(hunkPreviews('a\nb\n', 'A\nb'), [{ index: 0, line: 1, removed: ['a'], added: ['A'], removedCount: 1, addedCount: 1 },
    { index: 1, line: 2, removed: [], added: [], removedCount: 0, addedCount: 0, note: 'Removes the newline at the end of the file' }]);
  assert.equal(hunkPreviews('a\nb', 'a\nb\n')[0].note, 'Adds a newline at the end of the file');
  assert.equal(hunkPreviews('a\n\nb', 'a\nb')[0].note, undefined, 'an empty line removed elsewhere is an ordinary change');
});
