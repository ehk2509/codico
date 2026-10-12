const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// A stand-in for VS Code over a real temporary folder
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-rewind-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const uri = (p) => ({ scheme: 'file', path: p, fsPath: p, toString: () => `file://${p}` });
class FileSystemError extends Error { constructor(code) { super(code); this.code = code; } }
const dialogs = []; const notices = [];
let answer;
const vscodeStub = {
  FileSystemError,
  Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)), file: uri },
  workspace: {
    textDocuments: [],
    fs: {
      readFile: async (u) => { try { return new Uint8Array(fs.readFileSync(u.fsPath)); } catch { throw new FileSystemError('FileNotFound'); } },
      writeFile: async (u, bytes) => fs.writeFileSync(u.fsPath, bytes),
      createDirectory: async (u) => { fs.mkdirSync(u.fsPath, { recursive: true }); },
      delete: async (u) => fs.rmSync(u.fsPath),
    },
  },
  window: {
    showWarningMessage: async (message, options, ...buttons) => { dialogs.push({ message, detail: options.detail, buttons }); return answer; },
    showInformationMessage: async (message) => { notices.push(message); },
    showTextDocument: async () => undefined,
  },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain); };
test.after(() => { Module._load = originalLoad; });

const { UndoRedoStack } = require('../out/undoRedoStack.js');
const { turnsFrom, rewindSummary, rewindOutcome, rewindFiles, REWIND_ALL, REWIND_CONVERSATION } = require('../out/rewind.js');

const bytes = (text) => text === null ? null : new TextEncoder().encode(text);
const file = (name) => path.join(root, name);
const read = (name) => fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : null;
let overwrite; let asked;
function project(files) {
  for (const name of fs.readdirSync(root)) { fs.rmSync(file(name), { recursive: true }); }
  for (const [name, text] of Object.entries(files)) { fs.writeFileSync(file(name), text); }
  dialogs.length = 0; notices.length = 0; asked = []; overwrite = false; answer = REWIND_ALL;
  return new UndoRedoStack(async (message) => { asked.push(message); return overwrite; });
}
// What the agent does: change the file on disk and record the change under the turn in progress
function change(stack, turn, name, after) {
  stack.turn = turn;
  const before = read(name);
  fs.writeFileSync(file(name), after);
  stack.push({ filepath: name, uri: uri(file(name)), before: bytes(before), after: bytes(after), label: `edit ${name}` });
}

test('the turns a rewind removes: the message and every one after it', () => {
  const display = [{ role: 'user', id: 't1', text: 'a' }, { role: 'assistant', text: 'x' }, { role: 'user', id: 't2', text: 'b' }, { role: 'assistant', text: 'y' }, { role: 'user', text: 'no id' }, { role: 'user', id: 't3', text: 'c' }];
  assert.deepEqual(turnsFrom(display, 't2'), ['t2', 't3']);
  assert.deepEqual(turnsFrom(display, 't1'), ['t1', 't2', 't3']);
  assert.deepEqual(turnsFrom(display, 'gone'), []);
});

test('rewinding puts every file back as it was before that message, across several turns and edits', async () => {
  const stack = project({ 'a.txt': 'a0', 'b.txt': 'b0' });
  change(stack, 't1', 'a.txt', 'a1');
  change(stack, 't2', 'a.txt', 'a2');
  change(stack, 't2', 'b.txt', 'b1');
  change(stack, 't2', 'new.txt', 'created');
  change(stack, 't3', 'a.txt', 'a3');
  const plan = stack.planRewind(['t2', 't3']);
  assert.deepEqual(plan.files.map(f => [f.filepath, f.changes, f.restoreTo && new TextDecoder().decode(f.restoreTo)]), [['a.txt', 2, 'a1'], ['b.txt', 1, 'b0'], ['new.txt', 1, null]]);
  assert.equal(plan.incomplete, false);
  const result = await stack.rewind(['t2', 't3']);
  assert.deepEqual(result, { restored: ['a.txt', 'b.txt', 'new.txt'], kept: [] });
  // The first turn's change stays; a file Codico created is gone again
  assert.deepEqual([read('a.txt'), read('b.txt'), read('new.txt')], ['a1', 'b0', null]);
  assert.deepEqual(asked, []);
  // What is left to undo is the first turn; Redo reapplies the rewound changes, oldest first
  assert.equal(stack.undoLabel, 'edit a.txt');
  assert.equal(stack.planRewind(['t2', 't3']).files.length, 0);
  for (const expected of ['a2', 'a2', 'a2', 'a3']) { await stack.redo(); assert.equal(read('a.txt'), expected); }
  assert.deepEqual([read('b.txt'), read('new.txt'), stack.canRedo], ['b1', 'created', false]);
  // And all of it can be rewound once more
  await stack.rewind(['t1', 't2', 't3']);
  assert.deepEqual([read('a.txt'), read('b.txt'), read('new.txt')], ['a0', 'b0', null]);
});

test('a file edited by hand since is asked about, and kept unless the user says otherwise', async () => {
  const stack = project({ 'a.txt': 'a0', 'b.txt': 'b0' });
  change(stack, 't1', 'a.txt', 'a1');
  change(stack, 't1', 'b.txt', 'b1');
  fs.writeFileSync(file('a.txt'), 'mine');
  assert.deepEqual(await stack.rewind(['t1']), { restored: ['b.txt'], kept: ['a.txt'] });
  assert.deepEqual([read('a.txt'), read('b.txt')], ['mine', 'b0']);
  assert.match(asked[0], /^a\.txt has changed since Codico last changed it\. Put back the earlier version anyway/);
  // The kept file's change is not offered by Redo: that would overwrite the hand edit later
  await stack.redo();
  assert.deepEqual([read('a.txt'), read('b.txt'), stack.canRedo], ['mine', 'b1', false]);

  const second = project({ 'a.txt': 'a0' });
  change(second, 't1', 'a.txt', 'a1');
  fs.writeFileSync(file('a.txt'), 'mine');
  overwrite = true;
  assert.deepEqual(await second.rewind(['t1']), { restored: ['a.txt'], kept: [] });
  assert.equal(read('a.txt'), 'a0');
  // Put back by hand already: nothing to ask
  const third = project({ 'a.txt': 'a0' });
  change(third, 't1', 'a.txt', 'a1');
  fs.writeFileSync(file('a.txt'), 'a0');
  assert.deepEqual(await third.rewind(['t1']), { restored: ['a.txt'], kept: [] });
  assert.deepEqual(asked, []);
});

test('a change already undone is not undone twice, and one that fell out of the record is said to be missing', async () => {
  const stack = project({ 'a.txt': 'a0', 'b.txt': 'b0' });
  change(stack, 't1', 'a.txt', 'a1');
  change(stack, 't1', 'b.txt', 'b1');
  await stack.undo();
  assert.deepEqual(stack.planRewind(['t1']).files.map(f => f.filepath), ['a.txt']);
  await stack.rewind(['t1']);
  assert.deepEqual([read('a.txt'), read('b.txt')], ['a0', 'b0']);

  const long = project({ 'a.txt': '0' });
  for (let i = 1; i <= 301; i++) { change(long, i === 1 ? 'old' : 'new', 'a.txt', String(i)); }
  assert.equal(long.planRewind(['old', 'new']).incomplete, true);
  assert.equal(long.planRewind(['new']).incomplete, false);
  assert.match(rewindSummary(long.planRewind(['old', 'new']), 2).detail, /Some of the oldest changes of these messages are no longer recorded and are not put back\./);
});

test('what the user is asked and told', () => {
  const stack = project({ 'a.txt': 'a0' });
  change(stack, 't1', 'a.txt', 'a1');
  change(stack, 't1', 'made.txt', 'x');
  const one = rewindSummary(stack.planRewind(['t1']), 1);
  assert.equal(one.message, 'Rewind to before this message? It and its reply are removed from the conversation.');
  assert.equal(one.detail, '2 files are put back as they were before it:\n    a.txt\n    made.txt  (created by Codico: deleted)\n\nRedo reapplies these changes one at a time.\n\nNot put back: what terminal commands changed, and changes made before VS Code was last restarted.');
  const none = rewindSummary(stack.planRewind(['other']), 3);
  assert.equal(none.message, 'Rewind to before this message? 3 messages and their replies are removed from the conversation.');
  assert.match(none.detail, /^No file change by Codico is recorded for these messages, so no file is touched\./);
  assert.equal(rewindOutcome({ restored: ['a', 'b'], kept: [] }), 'Codico: conversation rewound, 2 files put back');
  assert.equal(rewindOutcome({ restored: [], kept: ['a.txt'] }), 'Codico: conversation rewound, no file changed; kept as it is: a.txt');
});

test('the dialog: cancel changes nothing, "Conversation Only" leaves the files, the full rewind puts them back', async () => {
  const stack = project({ 'a.txt': 'a0' });
  change(stack, 't1', 'a.txt', 'a1');
  answer = undefined;
  assert.equal(await rewindFiles(stack, ['t1'], false), false);
  assert.equal(read('a.txt'), 'a1');
  assert.deepEqual(dialogs[0].buttons, [REWIND_ALL, REWIND_CONVERSATION]);
  answer = REWIND_CONVERSATION;
  assert.equal(await rewindFiles(stack, ['t1'], false), true);
  assert.equal(read('a.txt'), 'a1');
  assert.equal(stack.canUndo, true, 'the change can still be undone by hand');
  answer = REWIND_ALL;
  assert.equal(await rewindFiles(stack, ['t1'], false), true);
  assert.equal(read('a.txt'), 'a0');
  assert.equal(notices.at(-1), 'Codico: conversation rewound, 1 file put back');
  // Nothing recorded: one button, and nothing about files to choose
  answer = 'Rewind Conversation';
  assert.equal(await rewindFiles(stack, ['t9'], false), true);
  assert.deepEqual(dialogs.at(-1).buttons, ['Rewind Conversation']);
  // An automated run has nobody to ask
  change(stack, 't2', 'a.txt', 'a2');
  const before = dialogs.length;
  assert.equal(await rewindFiles(stack, ['t2'], true), true);
  assert.deepEqual([read('a.txt'), dialogs.length], ['a0', before]);
});
