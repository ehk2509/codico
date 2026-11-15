const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// A stand-in for VS Code that accepts whatever the headless module asks of it
const quiet = () => undefined;
const vscodeStub = new Proxy({
  ExtensionMode: { Test: 3, Production: 1 },
  ConfigurationTarget: { Global: 1 },
  commands: { executeCommand: async () => undefined },
  window: { showWarningMessage: quiet, showInformationMessage: quiet, showErrorMessage: quiet, showInputBox: quiet, showQuickPick: quiet },
  workspace: { getConfiguration: () => ({ update: async () => undefined, get: (_key, fallback) => fallback }) },
}, { get: (target, key) => (key in target ? target[key] : new Proxy(function () { /* any other part of the API */ }, { get: () => quiet, apply: quiet })) });
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain); };
test.after(() => { Module._load = originalLoad; });

const { runHeadless, HEADLESS_TASK_ENV, EXIT } = require('../out/headless.js');

/** Runs a task through runHeadless with a scripted agent; returns what the agent was asked and what was written. */
async function run(task, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-headless-test-'));
  const out = path.join(dir, 'events.jsonl');
  const taskFile = path.join(dir, 'task.json');
  fs.writeFileSync(taskFile, JSON.stringify({ permissions: 'read', ...task, out }));
  process.env[HEADLESS_TASK_ENV] = taskFile;
  const calls = [];
  const agent = {
    ready: true,
    backgroundPermissions: 'ask',
    backgroundListener: undefined,
    sendMessage: async (text) => { calls.push({ method: 'sendMessage', text, permissions: agent.backgroundPermissions }); await script(agent); },
    runPlan: async (goal) => { calls.push({ method: 'runPlan', text: goal, permissions: agent.backgroundPermissions }); await script(agent); },
    denyPrompts() {},
    lastReplyUsage: () => ({ tokens: 10, requests: [1] }),
  };
  try {
    const code = await runHeadless({ secrets: { store: async () => undefined } }, agent);
    const events = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { code, calls, events, text: events.filter(e => e.type === 'text').map(e => e.text).join('') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env[HEADLESS_TASK_ENV];
  }
}
const say = (agent, ...pieces) => pieces.forEach(text => agent.backgroundListener({ type: 'appendContent', id: 'm1', text }));

test('a normal task is sent as a message, with the permissions the command line gave', async () => {
  const done = await run({ prompt: 'Fix the bug', permissions: 'edits' }, async agent => say(agent, 'Fixed.'));
  assert.deepEqual(done.calls, [{ method: 'sendMessage', text: 'Fix the bug', permissions: 'edits' }]);
  assert.equal(done.code, EXIT.done);
  assert.equal(done.text, 'Fixed.');
});

test('--plan runs Plan mode, and nothing is approved while planning even when edits were allowed', async () => {
  const done = await run({ prompt: 'Add a clearCart function', plan: true, permissions: 'all' }, async agent => say(agent, '1. Read src/cart.js\n2. Add it'));
  assert.deepEqual(done.calls, [{ method: 'runPlan', text: 'Add a clearCart function', permissions: 'ask' }]);
  assert.equal(done.code, EXIT.done);
});

test('a prompt that starts with /plan is a plan, the way it is in the panel', async () => {
  const done = await run({ prompt: '/plan  fix the failing tests\nin src/cart.js', permissions: 'edits' }, async () => undefined);
  assert.deepEqual(done.calls, [{ method: 'runPlan', text: 'fix the failing tests\nin src/cart.js', permissions: 'ask' }]);
  // Only at the start, and only as a command: other prompts are ordinary messages
  const ordinary = await run({ prompt: 'please /plan nothing', permissions: 'edits' }, async () => undefined);
  assert.equal(ordinary.calls[0].method, 'sendMessage');
  const bare = await run({ prompt: '/planning notes', permissions: 'edits' }, async () => undefined);
  assert.equal(bare.calls[0].method, 'sendMessage');
});

test('the printed reply has the model\'s tool fences taken out, however the stream was cut', async () => {
  const done = await run({ prompt: 'Fix it', permissions: 'edits' }, async agent => {
    say(agent, 'Fixed both bugs.\n\n', '```accept', 'ance', '\n\n', '```accept', 'ance', '```accept', 'ance', '\n\nThe tests pass.');
    // A second reply starts: what was held back is not lost, and nothing carries over
    agent.backgroundListener({ type: 'startMessage', id: 'm2' });
    say(agent, 'Use `npm test` to check.');
  });
  assert.equal(done.text, 'Fixed both bugs.\n\nThe tests pass.Use `npm test` to check.');
  assert.doesNotMatch(done.text, /acceptance/);
});
