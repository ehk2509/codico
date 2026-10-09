const test = require('node:test');
const assert = require('node:assert/strict');
const { ToolLoopGuard } = require('../out/toolLoopGuard.js');

const read = { type: 'read_file', filepath: 'src/a.ts' };
const edit = (n) => ({ type: 'edit_file', filepath: 'src/a.ts', oldStr: `n=${n}`, newStr: `n=${n + 1}` });
const tests = { type: 'run_terminal', command: 'npm test' };

test('the same call repeated with nothing changing in between is a loop', () => {
  const guard = new ToolLoopGuard();
  assert.deepEqual([1, 2, 3, 4].map(() => guard.check(read).loop), [false, false, false, true]);
});

test('re-reading a file after editing it is not a loop', () => {
  const guard = new ToolLoopGuard();
  for (let n = 0; n < 10; n++) {
    assert.equal(guard.check(read).loop, false, `read ${n + 1}`);
    guard.ran(read);
    assert.equal(guard.check(edit(n)).loop, false);
    guard.ran(edit(n));
  }
});

test('re-running the tests after each fix is not a loop; re-running them unchanged is', () => {
  const guard = new ToolLoopGuard();
  for (let n = 0; n < 6; n++) {
    assert.equal(guard.check(tests).loop, false);
    guard.ran(tests);
    guard.check(edit(n)); guard.ran(edit(n));
  }
  const idle = new ToolLoopGuard();
  assert.deepEqual([1, 2, 3, 4].map(() => { const r = idle.check(tests).loop; idle.ran(tests); return r; }), [false, false, false, true]);
});

test('a command makes reads worth repeating, but an identical write is always counted', () => {
  const guard = new ToolLoopGuard();
  for (let n = 0; n < 5; n++) {
    assert.equal(guard.check(read).loop, false);
    guard.check(tests); guard.ran(tests);
  }
  const write = { type: 'write_file', filepath: 'a.txt', content: 'x' };
  const results = [];
  for (let n = 0; n < 4; n++) { results.push(guard.check(write).loop); guard.ran(write); }
  assert.deepEqual(results, [false, false, false, true], 'writing the same content again changes nothing');
});
