const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { TeamService, settled } = require('../out/teamService.js');
const { parseTeamFence, teamToolFromArgs, findWorker, teamPromptSection, workerId } = require('../out/teamTools.js');
const { BackgroundTaskStore } = require('../out/backgroundTaskStore.js');
const { createWorktree } = require('../out/backgroundGit.js');
const { getNativeToolDefinitions, nativeToolCallToToolCall } = require('../out/nativeTools.js');
const { parseToolCalls } = require('../out/toolParser.js');
const { ToolLoopGuard } = require('../out/toolLoopGuard.js');
const crypto = require('node:crypto');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codico-team-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const sh = (cwd, ...args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let n = 0;
/** A repository, a task store and a team service whose windows are only recorded. */
function setup(settings = { maxWorkers: 2, permissions: 'edits' }) {
  const repo = path.join(root, 'repo' + (++n)); fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main'); sh(repo, 'config', 'core.autocrlf', 'false'); sh(repo, 'config', 'user.email', 't@example.com'); sh(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'app.js'), 'module.exports = 1;\n'); sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'first');
  const store = new BackgroundTaskStore(path.join(root, 'store' + n));
  const opened = [];
  let clock = Date.now();
  const service = new TeamService({
    store,
    async createTask(options) {
      const id = crypto.randomBytes(8).toString('hex');
      const worktree = path.join(root, 'wt' + n + '-' + id.slice(0, 6));
      const branch = `codico/w-${id.slice(0, 6)}`;
      const made = await createWorktree(repo, worktree, branch, options.from);
      if ('error' in made) { return made; }
      const task = { id, prompt: options.prompt, repoRoot: repo, worktree, branch, baseCommit: made.baseCommit, permissions: options.permissions, status: 'starting', createdAt: clock, updatedAt: clock,
        role: options.role, name: options.name, team: options.team, ...(options.basedOn ? { basedOn: options.basedOn } : {}) };
      await store.save(task);
      return task;
    },
    launch: async task => { opened.push(task.id); },
    settings: () => settings,
    sleep: async ms => { clock += ms; },
    now: () => clock,
  });
  const answers = { merge: true };
  const call = (extra = {}) => ({ team: 'thread-1', repoRoot: repo, signal: new AbortController().signal,
    approveMerge: async () => answers.merge, review: async text => `REVIEWED ${text.length}`, ...extra });
  /** What the worker's window would do: change files in its worktree and say it finished. */
  const finish = async (task, files, report = 'Done.') => {
    for (const [name, text] of Object.entries(files)) { fs.writeFileSync(path.join(task.worktree, name), text); }
    await store.update(task.id, { status: 'finished', report, heartbeat: clock });
  };
  const run = (tool, extra) => service.run({ type: 'team', ...tool }, call(extra));
  const only = async () => (await service.workers('thread-1'));
  return { repo, store, service, opened, answers, run, finish, only, now: () => clock };
}

test('the fenced form and native arguments give the same call', () => {
  assert.deepEqual(parseTeamFence('action: start\nrole: tester\nworker: abcd1234\ntext:\nWrite tests for\nthe parser.\n'),
    { type: 'team', action: 'start', role: 'tester', worker: 'abcd1234', text: 'Write tests for\nthe parser.' });
  assert.deepEqual(parseTeamFence('action: wait\nworkers: aaaa1111, bbbb2222\ntimeout_seconds: 90'), { type: 'team', action: 'wait', workers: ['aaaa1111', 'bbbb2222'], timeoutSeconds: 90 });
  assert.deepEqual(teamToolFromArgs({ action: 'WAIT', workers: ['aaaa1111'] }), { type: 'team', action: 'wait', workers: ['aaaa1111'] });
  assert.equal(teamToolFromArgs({ action: 'deploy' }), null);
  assert.deepEqual(teamToolFromArgs({ action: 'start', role: 'manager', text: 'x' }), { type: 'team', action: 'start', text: 'x' }, 'an unknown role is dropped: a developer is started');
  assert.deepEqual(nativeToolCallToToolCall({ name: 'team', arguments: { action: 'merge', worker: 'abcd1234' } }), { type: 'team', action: 'merge', worker: 'abcd1234' });
  const fenced = parseToolCalls('Starting.\n```team\naction: start\ntext:\nAdd a health check\n```\n');
  assert.deepEqual(fenced.map(tool => [tool.type, tool.action, tool.text]), [['team', 'start', 'Add a health check']]);
});

test('the team tool is offered only to the orchestrator, and never in read-only turns', () => {
  const names = (...args) => getNativeToolDefinitions(...args).map(tool => tool.name);
  assert.ok(!names().includes('team'));
  assert.ok(names(false, true).includes('team'));
  assert.ok(!names(true, true).includes('team'));
  assert.match(teamPromptSection(3), /At most 3 workers/);
  assert.match(teamPromptSection(2), /Acceptance gate/);
});

test('waiting for workers repeats without being taken for a loop; starting one repeatedly is', () => {
  const guard = new ToolLoopGuard(2);
  const wait = { type: 'team', action: 'wait' };
  for (let i = 0; i < 5; i++) { assert.equal(guard.check(wait).loop, false); }
  const start = { type: 'team', action: 'start', text: 'same' };
  guard.check(start); guard.check(start);
  assert.equal(guard.check(start).loop, true);
});

test('workers are named after their part, refer to by name, and a name used twice gets a number', async () => {
  const t = setup({ maxWorkers: 3, permissions: 'edits' });
  assert.match(await t.run({ action: 'start', name: 'Backend API', text: 'Build the API' }), /Started worker backend-api \([0-9a-f]{8}\) \(developer\)/);
  await t.run({ action: 'start', name: 'backend-api', text: 'More API' });
  const all = await t.only();
  assert.deepEqual(all.map(task => task.name).sort(), ['backend-api', 'backend-api-2']);
  const first = all.find(task => task.name === 'backend-api');
  await t.finish(first, { 'api.js': 'api\n' });
  assert.match(await t.run({ action: 'changes', worker: 'backend-api' }), /api\.js/);
  assert.match(await t.run({ action: 'changes', worker: 'Backend-API-2' }), /has not changed any file/);
  assert.match(await t.run({ action: 'wait', workers: ['backend-api'] }), /Worker backend-api \([0-9a-f]{8}\), developer: finished/);
  assert.deepEqual(parseTeamFence('action: start\nname: Front End!\ntext:\nx'), { type: 'team', action: 'start', name: 'front-end', text: 'x' });
});

test('a worker is found by its id or the start of it, never by an ambiguous or too short name', () => {
  const tasks = [{ id: 'abcd1111aaaa' }, { id: 'abcd2222bbbb' }];
  assert.equal(findWorker(tasks, 'abcd1111'), tasks[0]);
  assert.equal(findWorker(tasks, '#ABCD2222'), tasks[1]);
  assert.equal(findWorker(tasks, 'abcd'), undefined, 'two workers start so');
  assert.equal(findWorker(tasks, 'abc'), undefined);
});

test('start: makes a worker in its own worktree, opens its window, and keeps to the limit', async () => {
  const t = setup({ maxWorkers: 1, permissions: 'edits' });
  const out = await t.run({ action: 'start', role: 'developer', text: 'Add a health check' });
  const [worker] = await t.only();
  assert.match(out, new RegExp(`Started worker ${workerId(worker)} \\(developer\\)`));
  assert.deepEqual(t.opened, [worker.id]);
  assert.equal(worker.team, 'thread-1'); assert.equal(worker.role, 'developer'); assert.equal(worker.permissions, 'edits');
  assert.ok(fs.existsSync(path.join(worker.worktree, 'app.js')));
  // The limit counts workers still running
  await t.store.update(worker.id, { status: 'running', heartbeat: t.now() });
  assert.match(await t.run({ action: 'start', text: 'Another part' }), /ERROR: 1 workers are already running/);
  await t.store.update(worker.id, { status: 'finished' });
  assert.match(await t.run({ action: 'start', text: 'Another part' }), /Started worker/);
  assert.match(await t.run({ action: 'start' }), /ERROR: give the worker its task/);
});

test('start: a worker that starts from the workspace is told about uncommitted changes it will not have', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.repo, 'app.js'), 'module.exports = 2;\n');
  assert.match(await t.run({ action: 'start', text: 'X' }), /uncommitted changes in the workspace are not part of it/);
});

test('wait: returns each worker\'s status, report and changes once all have stopped', async () => {
  const t = setup();
  await t.run({ action: 'start', text: 'Part one' });
  await t.run({ action: 'start', text: 'Part two' });
  const [a, b] = await t.only();
  await t.store.update(a.id, { status: 'running', heartbeat: t.now() });
  await t.store.update(b.id, { status: 'running', heartbeat: t.now() });
  // Both finish while the orchestrator waits
  let polls = 0;
  const realGet = t.store.get.bind(t.store);
  t.store.get = async id => { if (++polls === 3) { await t.finish(a, { 'one.js': 'one\n' }, 'Added one.js'); await t.finish(b, { 'two.js': 'two\n' }, 'Added two.js, tests pass'); } return realGet(id); };
  const out = await t.run({ action: 'wait' });
  assert.match(out, /All of them have stopped/);
  assert.match(out, new RegExp(`Worker ${workerId(a)}, developer: finished[\\s\\S]*one\\.js[\\s\\S]*Report:\\nAdded one\\.js`));
  assert.match(out, /Added two\.js, tests pass/);
});

test('wait: gives up after its time, saying who still runs; a worker that needs the user stops the wait', async () => {
  const t = setup();
  await t.run({ action: 'start', text: 'Slow' });
  const [worker] = await t.only();
  // The heartbeat keeps up with the clock, as a live window's does
  const realGet = t.store.get.bind(t.store);
  t.store.get = async id => { const task = await realGet(id); return task && { ...task, status: 'running', heartbeat: t.now() }; };
  assert.match(await t.run({ action: 'wait', timeoutSeconds: 30 }), /Still running after 30 s: 1 of 1/);
  t.store.get = realGet;
  await t.store.update(worker.id, { status: 'waiting', note: 'approve a command', heartbeat: t.now() });
  assert.match(await t.run({ action: 'wait', workers: [workerId(worker)] }), /waiting for the user in its window \(approve a command\)/);
  await t.store.update(worker.id, { status: 'waiting', note: 'answer its question', heartbeat: t.now() });
  assert.match(await t.run({ action: 'wait' }), /asks a question \(answer it with message\)/);
  assert.match(await t.run({ action: 'wait', workers: ['nobody1'] }), /ERROR: no worker "nobody1"/);
});

test('message: goes to the worker\'s inbox, and a finished worker counts as running again until it answers', async () => {
  const t = setup();
  await t.run({ action: 'start', text: 'Part' });
  const [worker] = await t.only();
  await t.finish(worker, { 'a.js': 'a\n' });
  assert.match(await t.run({ action: 'message', worker: workerId(worker), text: 'Also handle the empty case.' }), /Sent to worker/);
  const after = await t.store.get(worker.id);
  assert.deepEqual(after.inbox.map(m => m.text), ['Also handle the empty case.']);
  assert.equal(after.status, 'running');
  assert.equal(settled(after, t.now()), false);
  assert.match(await t.run({ action: 'message', worker: workerId(worker) }), /ERROR: give the message/);
});

test('a tester starts from the developer\'s work, including what the developer left uncommitted', async () => {
  const t = setup();
  await t.run({ action: 'start', text: 'Implement parse()' });
  const [dev] = await t.only();
  assert.match(await t.run({ action: 'start', role: 'tester', worker: workerId(dev), text: 'Test parse()' }), /ERROR: worker .* is still running/);
  await t.finish(dev, { 'parse.js': 'exports.parse = s => s;\n' });
  const out = await t.run({ action: 'start', role: 'tester', worker: workerId(dev), text: 'Test parse()' });
  assert.match(out, new RegExp(`from worker ${workerId(dev)}'s work`));
  const tester = (await t.only()).find(task => task.role === 'tester');
  assert.equal(tester.basedOn, dev.id);
  assert.equal(fs.readFileSync(path.join(tester.worktree, 'parse.js'), 'utf8'), 'exports.parse = s => s;\n');
  // The tester's changes are its own: the developer's work is where it started
  await t.finish(tester, { 'parse.test.js': 'test\n' });
  const changes = await t.run({ action: 'changes', worker: workerId(tester) });
  assert.match(changes, /parse\.test\.js/);
  assert.doesNotMatch(changes, /\+exports\.parse/);
});

test('changes and review: the worker\'s patch, to read or to hand to a reviewer', async () => {
  const t = setup();
  await t.run({ action: 'start', text: 'Part' });
  const [worker] = await t.only();
  assert.match(await t.run({ action: 'changes', worker: workerId(worker) }), /has not changed any file/);
  await t.finish(worker, { 'app.js': 'module.exports = 42;\n' });
  assert.match(await t.run({ action: 'changes', worker: workerId(worker) }), /```diff[\s\S]*\+module\.exports = 42;/);
  let asked = '';
  const out = await t.run({ action: 'review', worker: workerId(worker), text: 'error handling' }, { review: async text => { asked = text; return 'No problems. It can be merged.'; } });
  assert.match(out, /Review of worker .*:\n\nNo problems/);
  assert.match(asked, /Look most at: error handling/);
  assert.match(asked, /\+module\.exports = 42;/);
});

test('merge: only after the user approves; a conflict leaves the workspace as it was', async () => {
  const t = setup();
  await t.run({ action: 'start', text: 'Change app' });
  await t.run({ action: 'start', text: 'Change app too' });
  const [a, b] = await t.only();
  await t.finish(a, { 'app.js': 'module.exports = "a";\n', 'a.js': 'a\n' });
  await t.finish(b, { 'app.js': 'module.exports = "b";\n' });

  t.answers.merge = false;
  assert.match(await t.run({ action: 'merge', worker: workerId(a) }), /declined the merge/);
  assert.ok(!fs.existsSync(path.join(t.repo, 'a.js')));

  t.answers.merge = true;
  const merged = await t.run({ action: 'merge', worker: workerId(a) });
  assert.match(merged, /Merged worker .* \(2 files\)[\s\S]*Acceptance gate: run the build and the tests/);
  assert.equal(fs.readFileSync(path.join(t.repo, 'app.js'), 'utf8'), 'module.exports = "a";\n');
  assert.equal((await t.store.get(a.id)).merged, true);
  assert.match(await t.run({ action: 'merge', worker: workerId(a) }), /merged already/);

  const conflict = await t.run({ action: 'merge', worker: workerId(b) });
  assert.match(conflict, /Not merged: .*conflict.*The merge was undone/);
  assert.equal(fs.readFileSync(path.join(t.repo, 'app.js'), 'utf8'), 'module.exports = "a";\n');
  assert.equal(sh(t.repo, 'status', '--porcelain').trim(), '');
});

test('merge: refused while the worker runs, and for a worker of another team', async () => {
  const t = setup();
  await t.run({ action: 'start', text: 'Part' });
  const [worker] = await t.only();
  await t.store.update(worker.id, { status: 'running', heartbeat: t.now() });
  assert.match(await t.run({ action: 'merge', worker: workerId(worker) }), /still running/);
  assert.match(await t.run({ action: 'merge', worker: workerId(worker) }, { team: 'thread-2' }), /no worker .*This team has no worker yet/);
});
