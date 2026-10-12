const test = require('node:test');
const assert = require('node:assert/strict');
const { matchLines } = require('../out/lineMatch.js');
const { countChangedLines } = require('../out/patchPassport.js');
const { computeHunks, withHunks } = require('../out/hunks.js');
const { computeLineDiff } = require('../out/lineDiff.js');

// The length of a longest common subsequence, by the plain table: what any alignment is checked against
function lcsLength(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) { const row = new Array(b.length + 1).fill(0); for (let j = 1; j <= b.length; j++) { row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]); } prev = row; }
  return prev[b.length];
}

test('the lines two versions share: in order, really equal, and as many as possible', () => {
  let seed = 11; const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 300; round++) {
    const a = Array.from({ length: rand(40) }, () => 'l' + rand(9));
    const b = a.slice();
    for (let k = 0; k < rand(8); k++) { const at = rand(b.length + 1); const kind = rand(3); if (kind === 0) { b.splice(at, 0, 'n' + rand(9)); } else if (kind === 1) { b.splice(at, 1); } else { b.splice(at, 1, 'l' + rand(9)); } }
    const pairs = matchLines(a, b);
    assert.equal(pairs.length, lcsLength(a, b), `round ${round}`);
    for (let p = 0; p < pairs.length; p++) {
      assert.equal(a[pairs[p][0]], b[pairs[p][1]]);
      if (p > 0) { assert.ok(pairs[p][0] > pairs[p - 1][0] && pairs[p][1] > pairs[p - 1][1]); }
    }
  }
  assert.deepEqual(matchLines([], []), []);
  assert.deepEqual(matchLines(['a'], []), []);
  assert.deepEqual(matchLines(['a', 'b'], ['a', 'b']), [[0, 0], [1, 1]]);
  // More changes than it is asked to follow: it says so instead of taking forever
  assert.equal(matchLines(Array.from({ length: 50 }, (_, i) => 'a' + i), Array.from({ length: 50 }, (_, i) => 'b' + i), 20), null);
});

// A 2,865-line file with one line changed near the top and 25 added near the end:
// the change the report showed as "+2819 −2794"
const LONG = Array.from({ length: 2865 }, (_, i) => `line ${i} of the file`);
const EDITED = LONG.slice();
EDITED[7] = 'the import line, shortened';
EDITED.splice(2810, 0, ...Array.from({ length: 25 }, (_, i) => `    new method line ${i}`));

test('the change report counts two small edits far apart in a long file as what they are', () => {
  assert.deepEqual(countChangedLines(LONG.join('\n') + '\n', EDITED.join('\n') + '\n'), { added: 26, removed: 1 });
  // A file rewritten from top to bottom still counts every line
  const other = LONG.map((_, i) => `entirely different ${i}`);
  assert.deepEqual(countChangedLines(LONG.join('\n'), other.join('\n')), { added: 2865, removed: 2865 });
});

test('the same edit is two separate changes to review, and a readable diff to approve', () => {
  const before = LONG.join('\n'), after = EDITED.join('\n');
  const hunks = computeHunks(before, after);
  assert.deepEqual(hunks.map(h => [h.oldStart, h.removed.length, h.added.length]), [[7, 1, 1], [2810, 0, 25]]);
  assert.equal(withHunks(before, after, i => i === 0), LONG.map((l, i) => i === 7 ? 'the import line, shortened' : l).join('\n'));
  assert.equal(withHunks(before, after, () => true), after);
  const diff = computeLineDiff(before, after, 400).split('\n');
  assert.equal(diff.filter(l => l.startsWith('-')).length, 1, 'one removed line, not thousands');
  assert.equal(diff.filter(l => l.startsWith('+')).length, 26);
  assert.ok(diff.length < 60, `${diff.length} lines`);
});
