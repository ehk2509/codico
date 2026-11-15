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

test('an acceptance claim that is refused and made again, reworded, is a loop; new evidence or another criterion is not', () => {
  const claim = (how, extra = {}) => ({ type: 'acceptance', action: 'verify', criterion: 'AC1', result: 'pass', evidence: ['E1'], how, ...extra });
  const guard = new ToolLoopGuard();
  const wordings = ['ran the tests', 'The tests pass.', 'Tests passed after the fix', 'verified by running node test/cart.test.js', 'all green'];
  assert.deepEqual(wordings.map(how => guard.check(claim(how)).loop), [false, false, false, true, true]);
  // Different evidence, a different criterion or a different result is a different claim
  assert.equal(guard.check(claim('x', { evidence: ['E2'] })).loop, false);
  assert.equal(guard.check(claim('x', { criterion: 'AC2' })).loop, false);
  assert.equal(guard.check(claim('x', { result: 'fail' })).loop, false);
  // The order evidence is listed in does not make a claim new
  const first = new ToolLoopGuard();
  const counts = [['E1', 'E2'], ['E2', 'E1'], ['E1', 'E2'], ['E2', 'E1']].map(evidence => first.check(claim('y', { evidence })).loop);
  assert.deepEqual(counts, [false, false, false, true]);
});
