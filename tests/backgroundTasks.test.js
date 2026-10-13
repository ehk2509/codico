const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');

// The runner asks VS Code for the window's folder and to show the panel
let windowFolder;
const vscodeStub = { workspace: { get workspaceFolders() { return windowFolder ? [{ uri: { fsPath: windowFolder } }] : undefined; } }, commands: { executeCommand: async () => undefined } };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain); };
test.after(() => { Module._load = originalLoad; });

const { taskSlug, branchName, worktreeFolderName, lostItsWindow, statusLabel, isActive, activeSummary, announcement, taskPreface, parseTask, STALE_AFTER_MS } = require('../out/backgroundTasks.js');
const { BackgroundTaskStore } = require('../out/backgroundTaskStore.js');
const { repositoryRoot, createWorktree, uncommittedCount, taskChanges, commitTaskWork, mergeTask, removeWorktree } = require('../out/backgroundGit.js');
const { runTaskOfThisWindow, taskOfThisWindow, statusFromMessage } = require('../out/backgroundTaskRunner.js');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codico-bg-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const sh = (cwd, ...args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let n = 0;
function repository(files = { 'README.md': '# Project\n', 'src/app.js': 'module.exports = 1;\n' }) {
  const dir = path.join(root, 'repo' + (++n));
  fs.mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@example.com'); sh(dir, 'config', 'user.name', 'T');
  for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); }
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'first');
  return dir;
}
const task = (over = {}) => ({ id: 'a1b2c3d4e5f60718', prompt: 'Add an archive button', repoRoot: '/r', worktree: '/w', branch: 'codico/add-an-archive-button-a1b2c3', baseCommit: 'abc', permissions: 'edits', status: 'running', createdAt: 1000, updatedAt: 1000, ...over });

test('a task gets a readable branch and folder name from its first words', () => {
  assert.equal(taskSlug('Add an "Archive thread" action to this extension, please'), 'add-an-archive-thread-action');
  assert.equal(taskSlug('Répare le café ☕ & 100% des tests'), 'repare-le-cafe-100-des');
  assert.equal(taskSlug('../../etc/passwd; rm -rf ~'), 'etc-passwd-rm-rf');
  assert.equal(taskSlug('   '), 'task');
  assert.equal(branchName('Fix the login bug', 'a1b2c3d4e5f60718'), 'codico/fix-the-login-bug-a1b2c3');
  assert.equal(worktreeFolderName('Fix the login bug', 'a1b2c3d4e5f60718'), 'fix-the-login-bug-a1b2c3');
  assert.ok(taskSlug('x'.repeat(200)).length <= 36);
});

test('status: a task whose window stopped reporting is shown as stopped, not as running for ever', () => {
  const now = 1_000_000;
  const running = task({ status: 'running', heartbeat: now - 5000 });
  assert.equal(statusLabel(running, now), 'running');
  assert.equal(isActive(running, now), true);
  const lost = task({ status: 'running', heartbeat: now - STALE_AFTER_MS - 1 });
  assert.equal(lostItsWindow(lost, now), true);
  assert.equal(statusLabel(lost, now), 'stopped (its window was closed)');
  assert.equal(isActive(lost, now), false);
  // A finished task is never "lost", however old
  assert.equal(statusLabel(task({ status: 'finished', heartbeat: 1 }), now), 'finished');
  assert.equal(statusLabel(task({ status: 'waiting', heartbeat: now }), now), 'needs you');
  assert.equal(activeSummary([running, task({ status: 'waiting', heartbeat: now }), task({ status: 'waiting', heartbeat: now }), lost, task({ status: 'finished' })], now), '1 running, 2 need you');
  assert.equal(activeSummary([task({ status: 'waiting', heartbeat: now })], now), '1 needs you');
  assert.equal(activeSummary([task({ status: 'finished' })], now), '');
});

test('the starting window is told when a task finishes, needs the user or fails, once', () => {
  const before = task({ status: 'running' });
  assert.equal(announcement(before, task({ status: 'finished' })), 'Codico finished a background task: "Add an archive button"');
  assert.equal(announcement(before, task({ status: 'waiting', note: 'approve a command' })), 'A Codico background task needs you: "Add an archive button" (approve a command)');
  assert.match(announcement(before, task({ status: 'failed', note: 'no key' })), /failed: "Add an archive button" \(no key\)/);
  assert.equal(announcement(task({ status: 'finished' }), task({ status: 'finished' })), undefined, 'nothing changed');
  assert.equal(announcement(undefined, task({ status: 'finished' })), undefined, 'a task first seen in that state is not news');
  assert.equal(announcement(task({ status: 'starting' }), task({ status: 'running' })), undefined);
  assert.match(taskPreface({ branch: 'codico/x-1', baseBranch: 'main' }), /separate git worktree[\s\S]*"codico\/x-1" \(started from "main"\)[\s\S]*dependencies[\s\S]*Do not switch branches, and do not push or merge\./);
});

test('a task file is used only if it has the shape Codico writes', () => {
  assert.deepEqual(parseTask(JSON.stringify(task())), task());
  for (const bad of ['{', '[]', 'null', JSON.stringify(task({ id: '../../x' })), JSON.stringify(task({ status: 'weird' })), JSON.stringify(task({ permissions: 'root' })),
    JSON.stringify(task({ branch: 'main' })), JSON.stringify(task({ worktree: '' })), JSON.stringify(task({ createdAt: 'now' }))]) { assert.equal(parseTask(bad), undefined, bad.slice(0, 60)); }
});

test('the registry is shared through files: saved whole, updated in place, gone when removed', async () => {
  const store = new BackgroundTaskStore(path.join(root, 'store' + (++n)));
  assert.deepEqual(await store.all(), []);
  await store.save(task({ id: 'aaaaaaaaaaaaaaaa', createdAt: 1 }));
  await store.save(task({ id: 'bbbbbbbbbbbbbbbb', createdAt: 2 }));
  assert.deepEqual((await store.all()).map(t => t.id), ['bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa'], 'newest first');
  const updated = await store.update('aaaaaaaaaaaaaaaa', { status: 'finished', tokens: 5 });
  assert.deepEqual([updated.status, updated.tokens, updated.prompt], ['finished', 5, 'Add an archive button']);
  assert.ok(updated.updatedAt > 1000);
  // A second store on the same folder (another window) sees it
  assert.equal((await new BackgroundTaskStore(store._dir).get('aaaaaaaaaaaaaaaa')).status, 'finished');
  await store.remove('aaaaaaaaaaaaaaaa');
  assert.equal(await store.update('aaaaaaaaaaaaaaaa', { status: 'running' }), undefined, 'a discarded task is not brought back by a late update');
  assert.deepEqual((await store.all()).map(t => t.id), ['bbbbbbbbbbbbbbbb']);
  // Stray and damaged files are ignored; a file whose name is not its id too
  fs.writeFileSync(path.join(store._dir, 'notes.txt'), 'x'); fs.writeFileSync(path.join(store._dir, 'cccccccccccccccc.json'), '{ broken');
  fs.writeFileSync(path.join(store._dir, 'dddddddddddddddd.json'), JSON.stringify(task({ id: 'eeeeeeeeeeeeeeee' })));
  assert.deepEqual((await store.all()).map(t => t.id), ['bbbbbbbbbbbbbbbb']);
  assert.deepEqual(fs.readdirSync(store._dir).filter(f => f.endsWith('.tmp')), []);
});

test('git: a task works on its own branch in its own folder, from the last commit', async () => {
  const repo = repository();
  assert.equal(await repositoryRoot(path.join(repo, 'src')), repo);
  assert.equal(await repositoryRoot(root), undefined);
  fs.writeFileSync(path.join(repo, 'src/app.js'), 'module.exports = 2; // not committed\n');
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'untracked');
  assert.equal(await uncommittedCount(repo), 2);
  const worktree = path.join(root, 'wt', 'repo', 'task-one');
  const made = await createWorktree(repo, worktree, 'codico/task-one-abc123');
  assert.equal(made.baseBranch, 'main');
  assert.match(made.baseCommit, /^[0-9a-f]{40}$/);
  // The checkout is the last commit: the uncommitted change and the untracked file are not there
  assert.equal(fs.readFileSync(path.join(worktree, 'src/app.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(fs.existsSync(path.join(worktree, 'notes.txt')), false);
  assert.equal(sh(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'codico/task-one-abc123');
  assert.equal(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main', 'the starting window stays on its branch');
  // The same branch twice, or a repository without a commit, is an error that says why
  assert.match((await createWorktree(repo, path.join(root, 'wt', 'repo', 'again'), 'codico/task-one-abc123')).error, /already exists/);
  const empty = path.join(root, 'empty'); fs.mkdirSync(empty); sh(empty, 'init', '-q');
  assert.match((await createWorktree(empty, path.join(root, 'wt', 'empty', 'x'), 'codico/x-1')).error, /no commit yet/);
});

test('git: review shows everything the task did, merge brings it over, discard removes it', async () => {
  const repo = repository();
  const worktree = path.join(root, 'wt', 'r' + n, 'feature');
  const made = await createWorktree(repo, worktree, 'codico/feature-111111');
  // The task edits a file, adds one, and leaves it all uncommitted
  fs.writeFileSync(path.join(worktree, 'src/app.js'), 'module.exports = 42;\n');
  fs.writeFileSync(path.join(worktree, 'src/new.js'), 'exports.added = true;\n');
  const changes = await taskChanges(worktree, made.baseCommit);
  assert.equal(changes.files, 2);
  assert.match(changes.patch, /-module\.exports = 1;\n\+module\.exports = 42;/);
  assert.match(changes.patch, /\+exports\.added = true;/, 'a new file is part of the review');
  assert.match(changes.stat, /2 files changed/);
  // Meanwhile the user commits something else in the starting window
  fs.writeFileSync(path.join(repo, 'README.md'), '# Project\n\nMore.\n'); sh(repo, 'commit', '-qam', 'docs');
  assert.deepEqual(await commitTaskWork(worktree, 'Codico: feature'), { committed: true });
  assert.deepEqual(await commitTaskWork(worktree, 'Codico: feature'), { committed: false }, 'nothing left to commit');
  assert.deepEqual(await mergeTask(repo, 'codico/feature-111111'), { merged: true });
  assert.equal(fs.readFileSync(path.join(repo, 'src/app.js'), 'utf8'), 'module.exports = 42;\n');
  assert.equal(fs.existsSync(path.join(repo, 'src/new.js')), true);
  assert.match(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), /More\./, 'the user\'s own commit is kept');
  assert.deepEqual(await removeWorktree(repo, worktree, 'codico/feature-111111', false), {});
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(sh(repo, 'branch', '--list', 'codico/*').trim(), '');
  assert.doesNotMatch(sh(repo, 'worktree', 'list'), /feature/);
});

test('git: a merge that conflicts is undone, leaving the repository as it was', async () => {
  const repo = repository();
  const worktree = path.join(root, 'wt', 'r' + n, 'clash');
  await createWorktree(repo, worktree, 'codico/clash-222222');
  fs.writeFileSync(path.join(worktree, 'src/app.js'), 'module.exports = "task";\n');
  await commitTaskWork(worktree, 'Codico: clash');
  fs.writeFileSync(path.join(repo, 'src/app.js'), 'module.exports = "user";\n'); sh(repo, 'commit', '-qam', 'mine');
  const head = sh(repo, 'rev-parse', 'HEAD');
  const merged = await mergeTask(repo, 'codico/clash-222222');
  assert.match(merged.error, /conflict with changes made here since it started/);
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(sh(repo, 'status', '--porcelain').trim(), '', 'no half-finished merge is left behind');
  assert.equal(fs.readFileSync(path.join(repo, 'src/app.js'), 'utf8'), 'module.exports = "user";\n');
  // The task's work is still on its branch; keeping the branch when the worktree is removed
  assert.deepEqual(await removeWorktree(repo, worktree, 'codico/clash-222222', true), {});
  assert.match(sh(repo, 'branch', '--list', 'codico/*'), /codico\/clash-222222/);
});

function fakeAgent(script) {
  const agent = { ready: false, backgroundPermissions: 'ask', sent: [], backgroundListener: undefined, usage: { tokens: 1234, requests: [[1, 1, 0, 'main'], [1, 1, 0, 'main']] },
    lastReplyUsage() { return this.usage; },
    async sendMessage(text) { this.sent.push(text); await script(message => this.backgroundListener && this.backgroundListener(message)); } };
  return agent;
}

test('the task\'s window runs the task it was opened for, once, and reports how it goes', async () => {
  const store = new BackgroundTaskStore(path.join(root, 'store' + (++n)));
  windowFolder = path.join(root, 'window' + n); fs.mkdirSync(windowFolder);
  await store.save(task({ id: 'aaaaaaaaaaaaaaaa', worktree: windowFolder, status: 'starting', permissions: 'all', baseBranch: 'main' }));
  await store.save(task({ id: 'bbbbbbbbbbbbbbbb', worktree: path.join(root, 'elsewhere'), status: 'starting' }));
  const seen = [];
  const agent = fakeAgent(async (emit) => {
    emit({ type: 'toolStart', id: 'm', tool: 'run_terminal', label: 'npm test' });
    emit({ type: 'terminalPermissionRequest', id: 'm', permId: 'p', command: 'npm test' });
    await new Promise(r => setTimeout(r, 30)); seen.push((await store.get('aaaaaaaaaaaaaaaa')).status + ':' + (await store.get('aaaaaaaaaaaaaaaa')).note);
    emit({ type: 'toolResult', id: 'm', tool: 'run_terminal', label: 'npm test', success: true });
    await new Promise(r => setTimeout(r, 30)); seen.push((await store.get('aaaaaaaaaaaaaaaa')).status);
  });
  let waited = 0;
  const done = await runTaskOfThisWindow(store, agent, async () => { waited++; if (waited === 3) { agent.ready = true; } });
  assert.equal(waited, 3, 'it waits for the panel before sending');
  assert.equal(agent.backgroundPermissions, 'all');
  assert.equal(agent.sent.length, 1);
  assert.match(agent.sent[0], /^\[Background task\] You are working in a separate git worktree[\s\S]*\n\nAdd an archive button$/);
  assert.deepEqual(seen, ['waiting:approve a command', 'running']);
  assert.deepEqual([done.status, done.tokens, done.requests, done.note], ['finished', 1234, 2, undefined]);
  assert.equal(agent.backgroundListener, undefined);
  // The other task is not this window's; and opening this window again does not run the task a second time
  assert.equal((await store.get('bbbbbbbbbbbbbbbb')).status, 'starting');
  await runTaskOfThisWindow(store, agent, async () => {});
  assert.equal(agent.sent.length, 1);
  assert.equal((await taskOfThisWindow(store, windowFolder)).id, 'aaaaaaaaaaaaaaaa');
  assert.equal(await taskOfThisWindow(store, undefined), undefined);
});

test('a reply that ends with a question, an error, or a panel that never opens is not reported as finished', async () => {
  const run = async (script, ready = true) => {
    const store = new BackgroundTaskStore(path.join(root, 'store' + (++n)));
    windowFolder = path.join(root, 'window' + n); fs.mkdirSync(windowFolder);
    await store.save(task({ worktree: windowFolder, status: 'starting' }));
    const agent = fakeAgent(script); agent.ready = ready;
    return runTaskOfThisWindow(store, agent, async () => {});
  };
  const asked = await run(async emit => emit({ type: 'appendContent', id: 'm', text: '<clarify>\nquestion: Which database?\n</clarify>' }));
  assert.deepEqual([asked.status, asked.note], ['waiting', 'answer its question']);
  const failed = await run(async emit => emit({ type: 'error', message: 'No API key is set for DeepSeek.' }));
  assert.deepEqual([failed.status, failed.note], ['failed', 'No API key is set for DeepSeek.']);
  const threw = await run(async () => { throw new Error('boom'); });
  assert.deepEqual([threw.status, threw.note], ['failed', 'boom']);
  const noPanel = await run(async () => {}, false);
  assert.deepEqual([noPanel.status, noPanel.note], ['failed', 'the Codico panel did not open in the task\'s window']);
  assert.equal(statusFromMessage({ type: 'writePermissionRequest', id: 'm', permId: 'p', filepath: 'a', preview: '', diff: '' }).note, 'approve a file change');
  assert.equal(statusFromMessage({ type: 'appendContent', id: 'm', text: 'x' }), undefined);
});
