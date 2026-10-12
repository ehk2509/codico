const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// A stand-in for VS Code over a real temporary folder
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-proposals-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const uri = (p) => ({ scheme: 'file', path: p, fsPath: p, toString: () => `file://${p}` });
class FileSystemError extends Error { constructor(code) { super(code); this.code = code; } }
const vscodeStub = {
  FileSystemError,
  EventEmitter: class { constructor() { this.event = () => {}; } fire() {} },
  Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)), file: uri, parse: (text) => ({ toString: () => text, path: text }) },
  workspace: {
    textDocuments: [],
    openTextDocument: async () => ({}),
    fs: {
      readFile: async (u) => { try { return new Uint8Array(fs.readFileSync(u.fsPath)); } catch { throw new FileSystemError('FileNotFound'); } },
      writeFile: async (u, bytes) => fs.writeFileSync(u.fsPath, bytes),
      createDirectory: async (u) => { fs.mkdirSync(u.fsPath, { recursive: true }); },
      delete: async (u) => fs.rmSync(u.fsPath),
    },
  },
  window: { showTextDocument: async () => undefined },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain); };
test.after(() => { Module._load = originalLoad; });

const { EditProposalManager } = require('../out/editProposalManager.js');
const { handleProposalMessage } = require('../out/editProposalMessages.js');
const { UndoRedoStack } = require('../out/undoRedoStack.js');

const OLD = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n';
const NEW = 'ONE\ntwo\nthree\nFOUR\nfive\nsix\nseven\neight\n';
const file = (name) => path.join(root, name);
const read = (name) => fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : null;
let overwrite;
function review(name, before, after) {
  if (before === null) { fs.rmSync(file(name), { force: true }); } else { fs.writeFileSync(file(name), before); }
  const proposals = new EditProposalManager(); const posted = []; overwrite = false;
  const undo = new UndoRedoStack(async () => true);
  proposals.queue({ filepath: name, uri: uri(file(name)), originalContent: before === null ? null : new Uint8Array(Buffer.from(before)), proposedContent: after, label: `edit ${name}` });
  const send = (msg) => handleProposalMessage(msg, proposals, undo, m => posted.push(m), async () => overwrite);
  const last = (type) => posted.filter(m => m.type === type).at(-1);
  return { proposals, posted, undo, send, last };
}

test('the panel is given each separate change of a proposed edit', () => {
  const { proposals } = review('a.txt', OLD, NEW);
  const [state] = proposals.webviewState;
  assert.deepEqual(state.hunks, [
    { index: 0, line: 1, removed: ['one'], added: ['ONE'], removedCount: 1, addedCount: 1 },
    { index: 1, line: 4, removed: ['four'], added: ['FOUR'], removedCount: 1, addedCount: 1 },
    { index: 2, line: 8, removed: [], added: ['eight'], removedCount: 0, addedCount: 1 },
  ]);
  // A new file is taken or left whole
  assert.deepEqual(review('new.txt', null, 'hello\n').proposals.webviewState[0].hunks, []);
});

test('accepting one change writes only that change; the rest stays proposed against the new file', async () => {
  const { proposals, send, last, undo } = review('a.txt', OLD, NEW);
  await send({ type: 'acceptHunk', filepath: 'a.txt', index: 1 });
  assert.equal(read('a.txt'), OLD.replace('four', 'FOUR'));
  assert.deepEqual(last('proposalsReady').proposals[0].hunks.map(h => [h.index, h.line, h.added]), [[0, 1, ['ONE']], [1, 8, ['eight']]]);
  assert.equal(undo.canUndo, true);
  assert.equal(last('undoRedoState').canUndo, true);
  // The whole file accepted afterwards is the full proposal
  await send({ type: 'acceptEdit', filepath: 'a.txt' });
  assert.equal(read('a.txt'), NEW);
  assert.equal(proposals.hasProposals, false);
  assert.ok(last('allProposalsResolved'));
  // Each step is its own undo
  await undo.undo();
  assert.equal(read('a.txt'), OLD.replace('four', 'FOUR'));
  await undo.undo();
  assert.equal(read('a.txt'), OLD);
});

test('rejecting one change drops it from the proposal and leaves the file alone', async () => {
  const { proposals, send, last } = review('a.txt', OLD, NEW);
  await send({ type: 'rejectHunk', filepath: 'a.txt', index: 0 });
  assert.equal(read('a.txt'), OLD);
  assert.equal(proposals.proposals[0].proposedContent, NEW.replace('ONE', 'one'));
  assert.deepEqual(last('proposalsReady').proposals[0].hunks.map(h => h.added), [['FOUR'], ['eight']]);
  await send({ type: 'acceptAllEdits' });
  assert.equal(read('a.txt'), NEW.replace('ONE', 'one'));
});

test('deciding the last change ends the review of that file', async () => {
  const taken = review('a.txt', OLD, NEW);
  for (let n = 0; n < 3; n++) { await taken.send({ type: 'acceptHunk', filepath: 'a.txt', index: 0 }); }
  assert.equal(read('a.txt'), NEW);
  assert.equal(taken.proposals.hasProposals, false);
  assert.ok(taken.last('allProposalsResolved'));

  const left = review('a.txt', OLD, NEW);
  for (let n = 0; n < 3; n++) { await left.send({ type: 'rejectHunk', filepath: 'a.txt', index: 0 }); }
  assert.equal(read('a.txt'), OLD);
  assert.equal(left.proposals.hasProposals, false);
  assert.ok(left.last('allProposalsResolved'));
});

test('a change that is not there, a new file, or a file edited meanwhile: nothing is written by surprise', async () => {
  const { proposals, send, posted } = review('a.txt', OLD, NEW);
  await send({ type: 'acceptHunk', filepath: 'a.txt', index: 9 });
  await send({ type: 'rejectHunk', filepath: 'other.txt', index: 0 });
  assert.deepEqual([read('a.txt'), posted.length, proposals.count], [OLD, 0, 1]);
  // Edited by hand since the proposal: asked first, and kept when the answer is no
  fs.writeFileSync(file('a.txt'), 'mine\n');
  await send({ type: 'acceptHunk', filepath: 'a.txt', index: 0 });
  assert.deepEqual([read('a.txt'), posted.length], ['mine\n', 0]);
  overwrite = true;
  await send({ type: 'acceptHunk', filepath: 'a.txt', index: 0 });
  assert.equal(read('a.txt'), OLD.replace('one', 'ONE'));

  const created = review('new.txt', null, 'hello\n');
  await created.send({ type: 'acceptHunk', filepath: 'new.txt', index: 0 });
  assert.equal(read('new.txt'), null);
  await created.send({ type: 'acceptEdit', filepath: 'new.txt' });
  assert.equal(read('new.txt'), 'hello\n');
});

test('a byte-order mark and Windows line endings survive a partial accept', async () => {
  const before = '﻿one\r\ntwo\r\nthree\r\nfour\r\n', after = '﻿one\r\nTWO\r\nthree\r\nFOUR\r\n';
  const { send } = review('bom.txt', before, after);
  await send({ type: 'acceptHunk', filepath: 'bom.txt', index: 1 });
  assert.deepEqual([...fs.readFileSync(file('bom.txt'))], [...Buffer.from('﻿one\r\ntwo\r\nthree\r\nFOUR\r\n')]);
});
