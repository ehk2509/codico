const test = require('node:test');
const assert = require('node:assert/strict');
const { ProgressTracker, MAX_STEPS_WITHOUT_PROGRESS } = require('../out/progressTracker.js');

const edit = { type: 'edit_file', result: '[edit_file: src/a.ts] Edit applied successfully.' };
const read = { type: 'read_file', result: '[read_file: src/a.ts lines 1–40 of 40]' };
const tests = (passed, failed) => ({ type: 'run_terminal', command: 'npm test 2>&1 | tail -5', result: `[run_terminal: npm test]\nExit: ${failed ? 1 : 0}\n# pass ${passed}\n# fail ${failed}\n` });

test('exploring before the first change is never counted as stalling', () => {
  const p = new ProgressTracker();
  for (let i = 0; i < 50; i++) { p.step([read]); }
  assert.equal(p.stalled(), false);
});

test('after a change, steps that only re-read and re-run checks with the same result stall the turn', () => {
  assert.equal(MAX_STEPS_WITHOUT_PROGRESS, 20);
  const p = new ProgressTracker();
  p.step([edit]);
  p.step([tests(8, 0)]);                // a new check result: progress
  for (let i = 0; i < 19; i++) { p.step([read, tests(8, 0)]); }
  assert.equal(p.stalled(), false);
  p.step([tests(8, 0)]);
  assert.equal(p.stalled(), true);
});

test('a code change, a new check, or a check whose outcome changed is progress', () => {
  const p = new ProgressTracker();
  p.step([edit]);
  for (let i = 0; i < 10; i++) { p.step([read]); }
  p.step([tests(7, 1)]);
  assert.equal(p.idleSteps, 0, 'a check not run before');
  for (let i = 0; i < 5; i++) { p.step([read]); }
  p.step([tests(8, 0)]);
  assert.equal(p.idleSteps, 0, 'the same check, a different outcome');
  for (let i = 0; i < 5; i++) { p.step([read]); }
  p.step([{ type: 'write_file', result: '[write_file: src/b.ts] Written successfully (3 lines).' }]);
  assert.equal(p.idleSteps, 0, 'a change');
  // A failed edit is not a change
  p.step([{ type: 'edit_file', result: '[edit_file: src/a.ts] ERROR: old_str not found' }]);
  assert.equal(p.idleSteps, 1);
});

test('handing the turn to another model starts the count again', () => {
  const p = new ProgressTracker();
  p.step([edit]);
  for (let i = 0; i < 20; i++) { p.step([read]); }
  assert.equal(p.stalled(), true);
  p.reset();
  assert.deepEqual([p.stalled(), p.idleSteps], [false, 0]);
});
