const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');

// The long, real spelling of the folder, which is what git and the editor report
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codico-bgm-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const sh = (cwd, ...args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// A stand-in for the editor: what it is asked, and the answers a user would give
const ui = { folder: undefined, trusted: true, answers: [], asked: [], opened: [], documents: [], notices: [], status: { text: '', shown: false } };
const answer = (kind, payload) => { ui.asked.push({ kind, ...payload }); const next = ui.answers.shift(); return typeof next === 'function' ? next(payload) : next; };
const vscodeStub = {
  StatusBarAlignment: { Left: 1 },
  Uri: { file: (p) => ({ fsPath: p }) },
  workspace: {
    get workspaceFolders() { return ui.folder ? [{ uri: { fsPath: ui.folder } }] : undefined; },
    get isTrusted() { return ui.trusted; },
    getConfiguration: () => ({ get: (key, fallback) => key === 'backgroundTasksDirectory' ? path.join(root, 'worktrees') : fallback }),
    openTextDocument: async (options) => { ui.documents.push(options); return options; },
  },
  window: {
    createStatusBarItem: () => ({ show() { ui.status.shown = true; }, hide() { ui.status.shown = false; }, dispose() {}, set text(v) { ui.status.text = v; }, get text() { return ui.status.text; } }),
    showInputBox: async (options) => answer('input', { options }),
    showQuickPick: async (items, options) => answer('pick', { items, options }),
    showWarningMessage: async (message, options, ...buttons) => { ui.notices.push(message); return options && options.modal ? answer('modal', { message, detail: options.detail, buttons }) : undefined; },
    showInformationMessage: async (message, ...buttons) => { ui.notices.push(message); return buttons.length ? answer('info', { message, buttons }) : undefined; },
    showErrorMessage: async (message) => { ui.notices.push('ERROR ' + message); },
    showTextDocument: async () => undefined,
  },
  commands: { executeCommand: async (command, target, options) => { ui.opened.push({ command, folder: target && target.fsPath, options }); } },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain); };
test.after(() => { Module._load = originalLoad; });

const { BackgroundTaskManager, worktreesRoot } = require('../out/backgroundTaskManager.js');
const { BackgroundTaskStore } = require('../out/backgroundTaskStore.js');

let n = 0; const managers = [];
test.after(() => managers.forEach(m => m.dispose()));
function setup() {
  const repo = path.join(root, 'repo' + (++n)); fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main'); sh(repo, 'config', 'core.autocrlf', 'false'); sh(repo, 'config', 'user.email', 't@example.com'); sh(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 1;\n'); sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'first');
  Object.assign(ui, { folder: repo, trusted: true, answers: [], asked: [], opened: [], documents: [], notices: [] });
  const store = new BackgroundTaskStore(path.join(root, 'store' + n));
  const manager = new BackgroundTaskManager(store); managers.push(manager);
  return { repo, store, manager };
}
const choose = (id) => ({ items }) => items.find(item => item.value === id || item.id === id);

test('starting a task: asks what it may do, makes its branch and folder, records it and opens its window', async () => {
  const { repo, store, manager } = setup();
  assert.equal(worktreesRoot(), path.join(root, 'worktrees'));
  ui.answers = ['Add a health check endpoint', choose('edits')];
  const task = await manager.start();
  assert.equal(ui.asked[0].kind, 'input');
  assert.deepEqual(ui.asked[1].items.map(i => i.value), ['edits', 'all', 'ask']);
  assert.match(ui.asked[1].items[1].detail, /Commands are not confined to the worktree/);
  assert.equal(task.branch.startsWith('codico/add-a-health-check-endpoint-'), true);
  assert.equal(task.worktree, path.join(root, 'worktrees', path.basename(repo), path.basename(task.worktree)));
  assert.deepEqual([task.status, task.permissions, task.baseBranch, fs.realpathSync.native(task.repoRoot)], ['starting', 'edits', 'main', repo]);
  assert.equal(fs.existsSync(path.join(task.worktree, 'app.js')), true);
  assert.deepEqual((await store.all()).map(t => t.id), [task.id]);
  assert.deepEqual(ui.opened, [{ command: 'vscode.openFolder', folder: task.worktree, options: { forceNewWindow: true } }]);
  assert.match(ui.notices.at(-1), /background task started on branch codico\/[\s\S]*trusting the parent folder/);
  assert.match(ui.status.text, /Codico: 1 running/);
  assert.equal(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
});

test('starting is refused or abandoned without leaving anything behind', async () => {
  const { repo, store, manager } = setup();
  const nothingMade = async () => { assert.deepEqual(await store.all(), []); assert.equal(sh(repo, 'branch', '--list', 'codico/*').trim(), ''); assert.deepEqual(ui.opened, []); };
  ui.trusted = false;
  assert.equal(await manager.start('x'), undefined);
  assert.match(ui.notices.at(-1), /need a trusted workspace/);
  ui.trusted = true;
  ui.answers = [undefined];                       // the input box is dismissed
  assert.equal(await manager.start(), undefined);
  ui.answers = [undefined];                       // the permissions list is dismissed
  assert.equal(await manager.start('Refactor it'), undefined);
  // Uncommitted work here will not be in the task: said before anything is created, and Cancel stops it
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 2;\n');
  ui.answers = [choose('ask'), undefined];
  assert.equal(await manager.start('Refactor it'), undefined);
  const warned = ui.asked.find(a => a.kind === 'modal');
  assert.match(warned.message, /starts from the last commit\. 1 uncommitted change in this window will not be part of it\./);
  await nothingMade();
  // Not a git repository
  ui.folder = root;
  assert.equal(await manager.start('x'), undefined);
  assert.match(ui.notices.at(-1), /not in a git repository/);
});

test('a finished task is reviewed as one patch, merged after confirmation, and cleaned up', async () => {
  const { repo, store, manager } = setup();
  ui.answers = [choose('edits')];
  const task = await manager.start('Change the answer');
  fs.writeFileSync(path.join(task.worktree, 'app.js'), 'module.exports = 42;\n');
  fs.writeFileSync(path.join(task.worktree, 'extra.js'), 'exports.x = 1;\n');
  // Still running: it is not merged under the agent's feet
  await store.update(task.id, { status: 'running', heartbeat: Date.now() });
  assert.equal(await manager.merge(await store.get(task.id)), false);
  assert.match(ui.notices.at(-1), /still running/);
  const finished = await store.update(task.id, { status: 'finished' });

  await manager.review(finished);
  assert.equal(ui.documents[0].language, 'diff');
  assert.match(ui.documents[0].content, /^# Background task: Change the answer\n# Branch codico\/change-the-answer-[0-9a-f]{6}, 2 files changed since [0-9a-f]{8}\n/);
  assert.match(ui.documents[0].content, /\+module\.exports = 42;[\s\S]*\+exports\.x = 1;/);

  ui.answers = [undefined];                       // the confirmation is dismissed
  assert.equal(await manager.merge(finished), false);
  assert.equal(fs.readFileSync(path.join(repo, 'app.js'), 'utf8'), 'module.exports = 1;\n');
  ui.asked = []; ui.answers = ['Merge', 'Remove Its Worktree and Branch'];
  assert.equal(await manager.merge(finished), true);
  assert.match(ui.asked[0].detail, /Change the answer\n\n[\s\S]*2 files changed[\s\S]*If it conflicts with your changes, the merge is undone/);
  assert.equal(fs.readFileSync(path.join(repo, 'app.js'), 'utf8'), 'module.exports = 42;\n');
  assert.equal(fs.existsSync(path.join(repo, 'extra.js')), true);
  assert.equal(fs.existsSync(task.worktree), false);
  assert.deepEqual(await store.all(), []);
  assert.equal(sh(repo, 'branch', '--list', 'codico/*').trim(), '');
});

test('a conflicting merge changes nothing here and says where the work still is; discard asks first', async () => {
  const { repo, store, manager } = setup();
  ui.answers = [choose('edits')];
  const task = await store.update((await manager.start('Clash')).id, { status: 'finished' });
  fs.writeFileSync(path.join(task.worktree, 'app.js'), 'module.exports = "task";\n');
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = "mine";\n'); sh(repo, 'commit', '-qam', 'mine');
  ui.answers = ['Merge'];
  assert.equal(await manager.merge(task), false);
  assert.match(ui.notices.at(-1), /^ERROR Codico: not merged, the task's changes conflict with changes made here since it started\. Nothing here was changed; the task's work is still on branch codico\/clash-/);
  assert.equal(sh(repo, 'status', '--porcelain').trim(), '');
  assert.equal((await store.all()).length, 1);

  ui.asked = []; ui.answers = [undefined];
  assert.equal(await manager.discard(task), false);
  assert.match(ui.asked[0].detail, /Its worktree \(.*\) and its branch codico\/clash-[0-9a-f]{6} are deleted, with everything the task did\. This cannot be undone\./);
  assert.equal(fs.existsSync(task.worktree), true);
  ui.answers = ['Discard'];
  assert.equal(await manager.discard(task), true);
  assert.equal(fs.existsSync(task.worktree), false);
  assert.deepEqual(await store.all(), []);
  assert.equal(ui.status.shown, false);
});

test('the list shows each task of this repository with its state; changes are announced once', async () => {
  const { repo, store, manager } = setup();
  ui.answers = [choose('all')];
  const task = await manager.start('Write the docs');
  // A task of another repository is not this window's business
  await store.save({ ...task, id: 'ffffffffffffffff', repoRoot: path.join(root, 'other'), prompt: 'Elsewhere' });
  await store.update(task.id, { status: 'waiting', note: 'approve a command', heartbeat: Date.now() });
  ui.asked = []; ui.notices = []; ui.answers = [undefined, undefined];
  await manager.refresh();
  assert.deepEqual(ui.notices, ['A Codico background task needs you: "Write the docs" (approve a command)']);
  assert.match(ui.status.text, /Codico: 1 needs you/);
  await manager.refresh();
  assert.equal(ui.notices.length, 1, 'not announced again while nothing changes');
  ui.asked = [];
  await manager.manage();
  const list = ui.asked[0].items;
  assert.deepEqual(list.map(i => i.label), ['$(add) Start a background task…', '$(bell-dot) Write the docs']);
  assert.equal(list[1].description, 'needs you: approve a command');
  // Finished: announced with a way to review, and the actions for a chosen task
  await store.update(task.id, { status: 'finished', tokens: 12345, requests: 9 });
  ui.asked = []; ui.notices = []; ui.answers = ['Review Changes'];
  await manager.refresh();
  // The review it chose runs git: wait for its outcome, not for a fixed time
  for (let i = 0; i < 100 && !ui.notices.some(n => /has not changed any file/.test(n)); i++) { await new Promise(r => setTimeout(r, 50)); }
  assert.deepEqual(ui.asked[0].buttons, ['Review Changes', 'Open Its Window']);
  assert.match(ui.notices.join('\n'), /Codico finished a background task: "Write the docs"[\s\S]*has not changed any file/);
  ui.asked = []; ui.answers = [({ items }) => items[1], choose('open')];
  ui.opened = [];
  await manager.manage();
  assert.equal(ui.asked[0].items[1].detail, `${task.branch} · 12,345 tokens in 9 requests`);
  assert.deepEqual(ui.asked[1].items.map(i => i.id), ['review', 'open', 'merge', 'discard']);
  assert.equal(ui.opened[0].folder, task.worktree);
  assert.equal(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
});

test('a background task can be published as a pull request: its work is committed on its branch first', async () => {
  const { repo, store } = setup();
  const published = [];
  const manager = new BackgroundTaskManager(store, async (input) => { published.push(input); return 'https://github.com/acme/widgets/pull/1'; }); managers.push(manager);
  ui.answers = [choose('edits')];
  const task = await manager.start('Add a health check');
  fs.writeFileSync(path.join(task.worktree, 'health.js'), 'ok\n');
  await store.update(task.id, { status: 'running', heartbeat: Date.now() });
  assert.equal(await manager.pullRequest(await store.get(task.id)), undefined);
  assert.match(ui.notices.at(-1), /still running\. Open the pull request when it has finished/);
  const finished = await store.update(task.id, { status: 'finished' });
  assert.equal(await manager.pullRequest(finished), 'https://github.com/acme/widgets/pull/1');
  assert.deepEqual([published[0].branch, published[0].baseBranch, published[0].prompt, fs.realpathSync.native(published[0].cwd)], [task.branch, 'main', 'Add a health check', fs.realpathSync.native(task.worktree)]);
  assert.match(published[0].stat, /health\.js[\s\S]*1 file changed/);
  // What the pull request will carry is on the branch, not left lying in the folder
  assert.equal(sh(task.worktree, 'status', '--porcelain').trim(), '');
  assert.match(sh(repo, 'log', '--format=%s', '-1', task.branch), /^Codico: Add a health check/);
  // The list offers it only when publishing is possible, and nothing is published for a task that changed nothing
  ui.asked = []; ui.answers = [({ items }) => items[1], undefined];
  await manager.manage();
  assert.deepEqual(ui.asked[1].items.map(i => i.id), ['review', 'open', 'merge', 'pr', 'discard']);
  ui.answers = [choose('edits')];
  const idle = await store.update((await manager.start('Nothing to do')).id, { status: 'finished' });
  assert.equal(await manager.pullRequest(idle), undefined);
  assert.equal(published.length, 1);
});

test('the panel is told the summary when it changes, and a task that has not started after a while is explained once', async () => {
  const { store, manager } = setup();
  const told = []; manager.onSummary = (text, needsUser) => told.push([text, needsUser]);
  await manager.refresh();
  assert.deepEqual(told, [['', false]], 'no task: the panel shows nothing');
  ui.answers = [choose('edits')];
  const task = await manager.start('Tidy the docs');
  assert.deepEqual(told.at(-1), ['1 running', false]);
  const before = told.length;
  await manager.refresh(); await manager.refresh();
  assert.equal(told.length, before, 'not repeated while nothing changes');
  // Its window never took it up: the folder is waiting to be trusted there
  await store.save({ ...(await store.get(task.id)), createdAt: Date.now() - 60_000 });
  ui.notices = [];
  await manager.refresh(); await manager.refresh();
  assert.deepEqual(told.at(-1), ['1 needs you', true]);
  assert.equal(ui.notices.filter(n => /has not started: "Tidy the docs"\. Its window is probably asking whether you trust the folder/.test(n)).length, 1, 'said once, not every few seconds');
  await store.update(task.id, { status: 'finished' });
  await manager.refresh();
  assert.deepEqual(told.at(-1), ['1 background task', false]);
});
