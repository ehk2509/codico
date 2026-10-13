const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codico-cp-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// A user whose own git configuration has hooks and signing: none of it may run for a checkpoint
const hooks = path.join(root, 'user-hooks'); fs.mkdirSync(hooks);
const hookMarker = path.join(root, 'HOOK-RAN');
for (const name of ['pre-commit', 'post-commit', 'commit-msg']) { fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\necho ran >> "${hookMarker.replace(/\\/g, '/')}"\n`, { mode: 0o755 }); }
const globalConfig = path.join(root, 'gitconfig');
fs.writeFileSync(globalConfig, `[core]\n\thooksPath = ${hooks.replace(/\\/g, '/')}\n\tautocrlf = true\n[commit]\n\tgpgsign = true\n[user]\n\tsigningkey = NOSUCHKEY\n`);
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const ui = { answers: [], asked: [], notices: [], saved: 0, commands: [] };
const vscodeStub = {
  workspace: { saveAll: async () => { ui.saved++; return true; }, workspaceFolders: [], isTrusted: true, getConfiguration: () => ({ get: (k, d) => d }) },
  window: {
    showWarningMessage: async (message, options, ...buttons) => { ui.asked.push({ message, detail: options.detail, buttons }); return ui.answers.shift(); },
    showInformationMessage: async (message, ...buttons) => { ui.notices.push({ message, buttons }); return undefined; },
  },
  commands: { executeCommand: async (c) => { ui.commands.push(c); } },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain); };
test.after(() => { Module._load = originalLoad; });

const { CheckpointService, restoreSummary, restoreOutcome } = require('../out/checkpoints.js');
const { shadowDir, takeSnapshot, snapshotExists } = require('../out/checkpointGit.js');
const { rewindFiles, REWIND_ALL, REWIND_CONVERSATION } = require('../out/rewind.js');
const { UndoRedoStack } = require('../out/undoRedoStack.js');

let n = 0;
function project(files) {
  const dir = path.join(root, 'project' + (++n)); fs.mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) { write(dir, name, text); }
  const storage = path.join(root, 'storage' + n);
  return { dir, storage, service: new CheckpointService(storage, () => [dir]) };
}
const write = (dir, name, text) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); };
const read = (dir, name) => fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8') : null;
const tree = (dir) => { const out = {}; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.git') { continue; } const p = path.join(d, e.name); if (e.isDirectory()) { walk(p); } else { out[path.relative(dir, p).replace(/\\/g, '/')] = fs.readFileSync(p, 'utf8'); } } }; walk(dir); return out; };

test('a checkpoint restores the whole folder: edited, created and deleted files, whoever changed them', async () => {
  const { dir, service } = project({ 'src/app.js': 'v1\n', 'src/util.js': 'util\n', 'README.md': '# P\r\nwindows line\r\n', 'data/keep.txt': 'keep\n' });
  const before = tree(dir);
  const checkpoint = await service.begin('add a feature');
  assert.deepEqual(Object.keys(checkpoint), [dir]);
  assert.match(checkpoint[dir], /^[0-9a-f]{40}$/);
  // The agent edits a file; a command generates one and deletes another; the user edits a third
  write(dir, 'src/app.js', 'v2 by the agent\n');
  write(dir, 'generated/out.txt', 'made by a command\n');
  fs.rmSync(path.join(dir, 'src/util.js'));
  write(dir, 'README.md', '# P\r\nedited by hand\r\n');
  const plan = await service.plan(checkpoint);
  assert.deepEqual(plan.folders[0].changes.map(c => `${c.status} ${c.path}`).sort(), ['added generated/out.txt', 'deleted src/util.js', 'modified README.md', 'modified src/app.js']);
  assert.equal(plan.files, 4);
  assert.deepEqual(await service.restore(plan), { restored: 4, errors: [] });
  assert.deepEqual(tree(dir), before, 'byte for byte, line endings included');
  assert.equal(fs.existsSync(path.join(dir, 'generated')), false);
});

test('checkpoints outlive the session, and a rewind can be undone', async () => {
  const { dir, storage, service } = project({ 'a.txt': 'one\n' });
  const checkpoint = await service.begin('first');
  write(dir, 'a.txt', 'two\n'); write(dir, 'b.txt', 'new\n');
  // "After a restart": nothing in memory, only what is on disk
  const later = new CheckpointService(storage, () => [dir]);
  const plan = await later.plan(JSON.parse(JSON.stringify(checkpoint)));
  await later.restore(plan);
  assert.deepEqual(tree(dir), { 'a.txt': 'one\n' });
  // Undo brings back what was there just before the rewind; undoing again returns to the checkpoint
  assert.deepEqual(await later.undoLast(), { restored: 2, errors: [] });
  assert.deepEqual(tree(dir), { 'a.txt': 'two\n', 'b.txt': 'new\n' });
  await new CheckpointService(storage, () => [dir]).undoLast();
  assert.deepEqual(tree(dir), { 'a.txt': 'one\n' });
  assert.equal(await project({ 'x': 'y' }).service.undoLast(), undefined, 'nothing to undo where nothing was rewound');
});

test('what .gitignore excludes is neither copied nor touched, and the project\'s own repository is left alone', async () => {
  const { dir, storage, service } = project({ '.gitignore': '.env\nbuild/\n', '.env': 'SECRET=1\n', 'build/out.js': 'built\n', 'node_modules/x/index.js': 'dep\n', 'src/a.js': 'a\n' });
  const sh = (...args) => cp.execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'none') } });
  sh('init', '-q', '-b', 'main'); sh('config', 'user.email', 't@e.com'); sh('config', 'user.name', 'T'); sh('add', '-A'); sh('commit', '-q', '-m', 'mine');
  const head = sh('rev-parse', 'HEAD'); const refs = sh('for-each-ref');
  const checkpoint = await service.begin('change things');
  // Nothing of the secret or the dependencies is in Codico's store
  const store = shadowDir(storage, dir);
  const stored = cp.execFileSync('git', [`--git-dir=${store}`, 'ls-tree', '-r', '--name-only', checkpoint[dir]], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(stored.sort(), ['.gitignore', 'src/a.js']);
  write(dir, '.env', 'SECRET=2\n'); write(dir, 'build/out.js', 'rebuilt\n'); write(dir, 'src/a.js', 'changed\n');
  const plan = await service.plan(checkpoint);
  assert.deepEqual(plan.folders[0].changes, [{ status: 'modified', path: 'src/a.js' }]);
  await service.restore(plan);
  assert.deepEqual([read(dir, 'src/a.js'), read(dir, '.env'), read(dir, 'build/out.js')], ['a\n', 'SECRET=2\n', 'rebuilt\n']);
  // The project's own git: same commit, same refs, and what it sees is only what the user would expect
  assert.equal(sh('rev-parse', 'HEAD'), head);
  assert.equal(sh('for-each-ref'), refs);
  assert.equal(sh('status', '--porcelain').trim(), '');
  assert.equal(fs.existsSync(path.join(dir, '.git', 'refs', 'codico')), false);
});

test('taking a checkpoint runs nothing of the user\'s git setup: no hooks, no signing, no line-ending conversion', { skip: process.platform === 'win32' }, async () => {
  const { dir, storage, service } = project({ 'a.txt': 'unix\n', 'b.txt': 'dos\r\n' });
  const checkpoint = await service.begin('x');
  assert.ok(checkpoint, 'a signing key that does not exist does not stop it');
  assert.equal(fs.existsSync(hookMarker), false, 'the user\'s commit hooks did not run');
  write(dir, 'a.txt', 'changed\n'); write(dir, 'b.txt', 'changed\r\n');
  await service.restore(await service.plan(checkpoint));
  assert.deepEqual([read(dir, 'a.txt'), read(dir, 'b.txt')], ['unix\n', 'dos\r\n']);
  assert.match(fs.readFileSync(path.join(shadowDir(storage, dir), 'CODICO-CHECKPOINTS.txt'), 'utf8'), /Safe to delete/);
});

test('a checkpoint that cannot be used is said to be so, and nothing is done', async () => {
  const { dir, storage, service } = project({ 'a.txt': 'one\n' });
  const checkpoint = await service.begin('x');
  assert.equal(await service.plan(undefined), undefined);
  assert.equal(await service.plan({ [dir]: '0'.repeat(40) }), undefined, 'a snapshot that does not exist');
  assert.equal(await service.plan({ [path.join(root, 'elsewhere')]: checkpoint[dir] }), undefined, 'a folder that is not open');
  assert.equal(await service.plan({ [dir]: 'HEAD; rm -rf /' }), undefined, 'only a commit id is accepted');
  assert.equal(await new CheckpointService(storage, () => [dir], () => false).plan(checkpoint), undefined, 'checkpoints turned off');
  assert.equal(await new CheckpointService(storage, () => [dir], () => false).begin('x'), undefined);
  assert.equal(await new CheckpointService(storage, () => []).begin('x'), undefined, 'no folder open');
  // Cleared: the old checkpoint is gone, a new one can be taken
  await service.clear();
  assert.equal(await snapshotExists(storage, dir, checkpoint[dir]), false);
  assert.equal(await service.plan(checkpoint), undefined);
  assert.ok(await service.begin('again'));
  assert.equal(read(dir, 'a.txt'), 'one\n');
});

test('a tool waits for the turn\'s checkpoint, and checkpoints of two turns do not collide', async () => {
  const { dir, service } = project(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`f${i}.txt`, 'x'.repeat(2000) + i])));
  const first = service.begin('one');
  let done = false; first.then(() => { done = true; });
  await service.ready;
  assert.equal(done, true, 'ready resolves only once the snapshot exists');
  write(dir, 'f0.txt', 'changed');
  const [a, b] = await Promise.all([service.begin('two'), service.begin('three')]);
  assert.ok(a && b);
  const plan = await service.plan(await first);
  assert.deepEqual(plan.folders[0].changes, [{ status: 'modified', path: 'f0.txt' }]);
});

test('what the user is asked before a rewind through checkpoints', () => {
  const plan = { files: 3, folders: [{ folder: '/w/app', target: 'a', now: 'b', changes: [{ status: 'modified', path: 'src/a.js' }, { status: 'added', path: 'out.log' }, { status: 'deleted', path: 'old.js' }] }] };
  const asked = restoreSummary(plan, 2);
  assert.equal(asked.message, 'Rewind to before this message? 2 messages and their replies are removed from the conversation.');
  assert.equal(asked.detail, '3 files return to what they were when the message was sent:\n    src/a.js\n    out.log  (created since: deleted)\n    old.js  (deleted since: restored)\n\n' +
    'This covers every change since then: by Codico, by terminal commands, and by you. "Codico: Undo Last Rewind" brings the present state back.\n\n' +
    'Not covered: files your .gitignore excludes (dependencies, build output, local settings such as .env).');
  assert.match(restoreSummary({ files: 0, folders: [{ folder: '/w/app', target: 'a', now: 'b', changes: [] }] }, 1).detail, /^The files are already as they were then, so no file is touched\./);
  const two = restoreSummary({ files: 2, folders: [{ folder: '/w/app', target: 'a', now: 'b', changes: [{ status: 'modified', path: 'x' }] }, { folder: '/w/lib', target: 'a', now: 'b', changes: [{ status: 'modified', path: 'x' }] }] }, 1);
  assert.match(two.detail, /    app\/x\n    lib\/x\n/);
  assert.equal(restoreOutcome({ restored: 2, errors: [] }), 'Codico: conversation rewound, 2 files put back');
  assert.match(restoreOutcome({ restored: 0, errors: ['app: locked'] }), /no file changed; not restored: app: locked$/);
});

test('rewind uses the checkpoint when there is one: confirmation, conversation only, and the in-memory record set aside', async () => {
  const { dir, service } = project({ 'a.txt': 'one\n' });
  const checkpoint = await service.begin('x');
  write(dir, 'a.txt', 'two\n'); write(dir, 'made-by-command.txt', 'x\n');
  const stack = new UndoRedoStack(async () => true);
  stack.turn = 't1';
  stack.push({ filepath: 'a.txt', uri: { toString: () => 'file:a', fsPath: path.join(dir, 'a.txt') }, before: Buffer.from('one\n'), after: Buffer.from('two\n'), label: 'edit a.txt' });
  Object.assign(ui, { answers: [undefined], asked: [], notices: [], saved: 0 });
  assert.equal(await rewindFiles(stack, ['t1'], false, service, checkpoint), false, 'dismissed: nothing happens');
  assert.equal(ui.saved, 1, 'open editors are saved first, so the present state can be brought back exactly');
  assert.deepEqual(ui.asked[0].buttons, [REWIND_ALL, REWIND_CONVERSATION]);
  assert.match(ui.asked[0].detail, /2 files return[\s\S]*a\.txt\n    made-by-command\.txt  \(created since: deleted\)/);
  assert.equal(read(dir, 'a.txt'), 'two\n');
  ui.answers = [REWIND_CONVERSATION];
  assert.equal(await rewindFiles(stack, ['t1'], false, service, checkpoint), true);
  assert.deepEqual([read(dir, 'a.txt'), stack.canUndo], ['two\n', true]);
  ui.answers = [REWIND_ALL];
  assert.equal(await rewindFiles(stack, ['t1'], false, service, checkpoint), true);
  assert.deepEqual(tree(dir), { 'a.txt': 'one\n' }, 'the file a command created is gone too');
  assert.deepEqual([stack.canUndo, stack.canRedo], [false, false]);
  assert.deepEqual(ui.notices.at(-1), { message: 'Codico: conversation rewound, 2 files put back', buttons: ['Undo Rewind'] });
  // No checkpoint (a thread from before this version): the session's own record is used, as before
  ui.asked = []; ui.answers = ['Rewind Conversation'];
  assert.equal(await rewindFiles(stack, ['t1'], false, service, undefined), true);
  assert.match(ui.asked[0].detail, /^No file change by Codico is recorded for these messages/);
});
