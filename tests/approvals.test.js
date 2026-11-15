const test = require('node:test');
const assert = require('node:assert/strict');
const { Approvals } = require('../out/approvals.js');

function setup() {
  const posted = [];
  return { approvals: new Approvals(m => posted.push(m)), posted };
}
const lastPermId = (posted) => posted[posted.length - 1].permId;

test('"allow all" on a command only counts while that question is open', async () => {
  const { approvals, posted } = setup();
  const answer = approvals.askCommand(permId => ({ type: 'terminalPermissionRequest', id: 'm1', permId, command: 'npm test', rules: [] }));
  const permId = lastPermId(posted);
  approvals.answerCommand(permId, true, true);
  assert.equal(await answer, true);
  assert.equal(approvals.allowAllCommands, true, 'allowed from the open card');
});

test('a stale or unknown card cannot switch approvals off for the rest of the task', async () => {
  const { approvals, posted } = setup();
  const answer = approvals.askCommand(permId => ({ type: 'terminalPermissionRequest', id: 'm1', permId, command: 'npm test', rules: [] }));
  const permId = lastPermId(posted);
  approvals.cancelAll();
  assert.equal(await answer, false, 'a cancelled question is declined');
  // The card is still on screen and gets clicked: its question is gone
  approvals.answerCommand(permId, true, true);
  approvals.answerCommand('never-asked', true, true);
  assert.equal(approvals.allowAllCommands, false, 'a command question that is not open grants nothing');
  approvals.answerWrite(permId, { granted: true }, true);
  approvals.answerWrite('never-asked', { granted: true }, true);
  assert.equal(approvals.allowAllWrites, false, 'neither does a write question that is not open');
});

test('file changes: "allow all" from an open card allows the later ones, and answers the open one', async () => {
  const { approvals, posted } = setup();
  const first = approvals.askWrite({ id: 'm1', filepath: 'a.js', diff: '', editableContent: 'x' });
  approvals.answerWrite(lastPermId(posted), { granted: true }, true);
  assert.deepEqual(await first, { granted: true });
  assert.deepEqual(await approvals.askWrite({ id: 'm1', filepath: 'b.js', diff: '', editableContent: 'y' }), { granted: true }, 'asked no more');
  assert.equal(posted.length, 1, 'the second change was not put to the user');
});

test('cancelling tells the panel which cards to close, and says nothing when nothing was open', async () => {
  const { approvals, posted } = setup();
  approvals.cancelAll();
  assert.deepEqual(posted, [], 'no question was open');

  const write = approvals.askWrite({ id: 'm1', filepath: 'a.js', diff: '', editableContent: 'x' });
  const command = approvals.askCommand(permId => ({ type: 'terminalPermissionRequest', id: 'm1', permId, command: 'ls', rules: [] }));
  const opened = approvals.pending;
  assert.equal(opened.length, 2);
  approvals.cancelAll();
  assert.deepEqual(await write, { granted: false });
  assert.equal(await command, false);
  const note = posted[posted.length - 1];
  assert.equal(note.type, 'permissionsCancelled');
  assert.deepEqual([...note.permIds].sort(), [...opened].sort());
  assert.deepEqual(approvals.pending, []);
});
