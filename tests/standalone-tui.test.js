'use strict';
// The standalone CLI's terminal experience: rendering, input helpers, config and interrupt semantics.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const m = require('../dist/standalone.js');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-tui-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'math.ts'), 'export const one = 1;\nexport const two = 2;\n');
  return cwd;
}

function collect(paint, toolNames = new Set(['read_file'])) {
  let out = '';
  const stream = new m.MarkdownStream(paint, () => 100, text => { out += text; }, toolNames);
  return { stream, text: () => out };
}

test('streamed markdown renders line by line and hides text-format tool calls', () => {
  const { stream, text } = collect(m.painter(false));
  const answer = 'Checking.\n\n```read_file\nfilepath: a.ts\n```\n<tool_call>\n{"name":"x"}\n</tool_call>\n# Title\n- item **bold**\n```js\nconst a = 1;\n```\ndone';
  for (let i = 0; i < answer.length; i += 3) { stream.push(answer.slice(i, i + 3)); }
  stream.end();
  const rendered = text();
  assert.doesNotMatch(rendered, /filepath|tool_call|"name"/);
  assert.match(rendered, /Checking\./);
  assert.match(rendered, /Title/);
  assert.match(rendered, /• item bold/);
  assert.match(rendered, /[│|] const a = 1;/);
  assert.match(rendered, /done\n$/);
});

test('colors are applied only when enabled and model text cannot inject escape sequences', () => {
  const colored = collect(m.painter(true));
  colored.stream.push('use `npm test` now\n'); colored.stream.end();
  assert.match(colored.text(), /\x1b\[36mnpm test\x1b\[39m/);
  const hostile = collect(m.painter(false));
  hostile.stream.push('safe\x1b]0;pwned\x07 text\x1b[2J\n'); hostile.stream.end();
  assert.equal(hostile.text(), 'safe text\n');
  assert.equal(m.detectColor({ isTTY: true }, { NO_COLOR: '1' }), false);
  assert.equal(m.detectColor({ isTTY: false }, { FORCE_COLOR: '1' }), true);
  assert.equal(m.detectColor({ isTTY: true }, {}), true);
});

test('tool results are summarized for the transcript', () => {
  assert.equal(m.summarizeResult('read_file', '[a.ts, lines 1-40 of 40]\n1: x', true).summary, 'Read 40 lines');
  assert.equal(m.summarizeResult('read_file', '[a.ts, lines 1-160 of 900]\n1: x', true).summary, 'Read 160 lines (1-160 of 900)');
  const failed = m.summarizeResult('run_terminal', 'Exit code: 2\nnpm ERR! missing script', false);
  assert.equal(failed.summary, 'Exited with code 2');
  assert.deepEqual(failed.preview, ['npm ERR! missing script']);
  assert.equal(m.toolLabel('edit_file'), 'Update');
  assert.equal(m.toolArgument({ type: 'run_terminal', command: 'npm test\nnext' }), 'npm test');
  assert.equal(m.toolArgument({ type: 'mcp_call', server: 'gh', tool: 'issues', args: {} }), 'gh/issues');
  assert.match(m.colorDiff('+added\n-removed', m.painter(true)), /\x1b\[32m\+added.*\n.*\x1b\[31m-removed/);
});

test('the transcript renderer streams deltas once and does not repeat the final text', () => {
  let out = '';
  const sink = { write: t => { out += t; }, isTTY: false, columns: 100 };
  const r = new m.TranscriptRenderer(sink, sink, m.painter(false), new Set(['read_file']));
  r.beginTurn();
  r.handle({ type: 'delta', text: 'Hello ' });
  r.handle({ type: 'delta', text: 'world\n' });
  r.handle({ type: 'text', text: 'Hello world' });
  r.handle({ type: 'toolStart', tool: 'read_file', text: 'math.ts' });
  r.handle({ type: 'toolResult', tool: 'read_file', text: '[math.ts, lines 1-2 of 2]', ok: true });
  r.handle({ type: 'text', text: 'Unstreamed reply' });
  r.handle({ type: 'usage', promptTokens: 1500, completionTokens: 20 });
  r.endTurn('done');
  assert.equal(out.match(/Hello world/g).length, 1);
  assert.match(out, /Read\(math\.ts\)/);
  assert.match(out, /Read 2 lines/);
  assert.match(out, /Unstreamed reply/);
  assert.match(out, /Done · .*1 tool · 1\.5k in · 20 out/);
});

test('an interrupted model stream is reported as stopped, never as a finished answer', async t => {
  const cwd = fixture(t);
  const controller = new AbortController();
  async function* stream() {
    yield { type: 'content', text: 'partial' };
    controller.abort(); // the provider then ends quietly, as aborted fetch streams do
  }
  const agent = new m.StandaloneAgent({ cwd, model: 'ollama/x', stream });
  await assert.rejects(agent.run('write an essay', controller.signal), /Agent stopped/);
});

test('agents stream visible text as delta events', async t => {
  const cwd = fixture(t);
  async function* stream() { yield { type: 'content', text: 'one ' }; yield { type: 'content', text: 'two' }; }
  const events = [];
  const agent = new m.StandaloneAgent({ cwd, model: 'ollama/x', stream, onEvent: e => events.push(e) });
  assert.equal(await agent.run('hi'), 'one two');
  assert.deepEqual(events.filter(e => e.type === 'delta').map(e => e.text), ['one ', 'two']);
  assert.ok(events.some(e => e.type === 'text' && e.text === 'one two'));
});

test('@file mentions attach through the guarded workspace only', async t => {
  const cwd = fixture(t);
  fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(cwd, '.codicoignore'), 'private/\n');
  fs.mkdirSync(path.join(cwd, 'private'));
  fs.writeFileSync(path.join(cwd, 'private', 'k.txt'), 'hidden\n');
  const workspace = new m.NodeWorkspace(cwd);
  const signal = new AbortController().signal;
  const result = await m.attachMentions('explain @math.ts:2 and @.env and @private/k.txt and @../x.ts and email a@b.com', workspace, signal);
  assert.deepEqual(result.attached, ['math.ts:2']);
  assert.match(result.prompt, /2: export const two = 2;/);
  assert.doesNotMatch(result.prompt, /SECRET|hidden/);
  assert.deepEqual(result.failed.sort(), ['../x.ts', '.env', 'private/k.txt'].sort());
  const index = new m.FileIndex(workspace);
  assert.deepEqual(index.list().sort(), ['.codicoignore', 'math.ts']);
  const complete = m.completer({ commands: ['/help', '/model', '/mode'], agents: () => ['reviewer'], files: index });
  assert.deepEqual(complete('/mo'), [['/model', '/mode'], '/mo']);
  assert.deepEqual(complete('look at @ma'), [['@math.ts'], '@ma']);
  assert.deepEqual(complete('ask @rev'), [['@reviewer'], '@rev']);
});

test('CLI parses the new subcommands and flags without breaking existing ones', () => {
  assert.equal(m.parseCliArgs(['doctor']).mode, 'doctor');
  assert.equal(m.parseCliArgs(['--version']).mode, 'version');
  assert.equal(m.parseCliArgs(['-c']).resume, 'last');
  const config = m.parseCliArgs(['config', 'set', 'model', 'ollama/qwen3:14b']);
  assert.equal(config.mode, 'config');
  assert.deepEqual(config.args, ['set', 'model', 'ollama/qwen3:14b']);
  assert.equal(m.parseCliArgs(['chat', '--verbose', '--no-color']).verbose, true);
  assert.throws(() => m.parseCliArgs(['doctor', 'extra']), /Unexpected text/);
  assert.equal(m.parseCliArgs(['agent', 'x']).permissions, 'read');
});

test('user config is validated and written atomically; repositories cannot set it', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  m.setUserConfig('model', 'ollama/qwen3:14b', file);
  m.setUserConfig('maxSteps', '40', file);
  assert.deepEqual(m.loadUserConfig(file).config, { model: 'ollama/qwen3:14b', maxSteps: 40 });
  assert.throws(() => m.setUserConfig('maxSteps', '500', file), /1 to 100/);
  assert.throws(() => m.setUserConfig('permissions', 'all', file), /Unknown config key/);
  assert.throws(() => m.setUserConfig('ollamaUrl', 'file:///etc', file), /http/);
  fs.writeFileSync(file, '{"model": 5}');
  assert.match(m.loadUserConfig(file).warning, /model must be/);
});

test('codico --version and config work from the executable', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-bin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(__dirname, '..', 'bin', 'codico.js');
  const env = { ...process.env, CODICO_CONFIG: path.join(dir, 'c.json'), NO_COLOR: '1' };
  const version = cp.spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8', env });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
  const set = cp.spawnSync(process.execPath, [bin, 'config', 'set', 'verbose', 'true'], { encoding: 'utf8', env });
  assert.equal(set.status, 0, set.stderr);
  const get = cp.spawnSync(process.execPath, [bin, 'config', 'get', 'verbose'], { encoding: 'utf8', env });
  assert.equal(get.stdout.trim(), 'true');
});

test('the arrow-key picker moves, jumps by number and cancels with Esc', async () => {
  const { EventEmitter } = require('node:events');
  const keys = new EventEmitter();
  let screen = '';
  const out = { write: t => { screen += t; }, columns: 80 };
  const choices = [{ label: 'Alpha', value: 'a' }, { label: 'Beta', value: 'b', current: true }, { label: 'Gamma', value: 'g' }];
  const moved = m.select(keys, out, m.painter(false), { title: 'Pick', choices });
  keys.emit('keypress', undefined, { name: 'down' });
  keys.emit('keypress', '\r', { name: 'return' });
  assert.equal(await moved, 'g'); // starts on the current choice (Beta), down → Gamma
  assert.match(screen, /\? Pick Gamma\n$/);
  const jumped = m.select(keys, out, m.painter(false), { title: 'Pick', choices });
  keys.emit('keypress', '1', { name: '1' });
  assert.equal(await jumped, 'a');
  const cancelled = m.select(keys, out, m.painter(false), { title: 'Pick', choices });
  keys.emit('keypress', undefined, { name: 'escape' });
  assert.equal(await cancelled, undefined);
  assert.equal(keys.listenerCount('keypress'), 0);
});

test('provider errors become plain explanations with a next step', () => {
  const missing = m.friendlyError('localhost:11434 HTTP 404: {"error":{"message":"model \'qwen2.5-coder:7b\' not found"}}', 'ollama/qwen2.5-coder:7b', 'http://localhost:11434');
  assert.equal(missing.title, 'The model "qwen2.5-coder:7b" isn\'t installed in Ollama.');
  assert.match(missing.hint, /ollama pull qwen2\.5-coder:7b/);
  assert.equal(missing.modelIssue, true);
  assert.equal(m.friendlyError('fetch failed', 'ollama/x', 'http://localhost:11434').modelIssue, true);
  assert.match(m.friendlyError('OPENAI_API_KEY is required for model direct:openai/gpt-5', 'direct:openai/gpt-5', '').title, /OPENAI_API_KEY isn't set/);
  const steps = m.friendlyError('Stopped after 20 model requests. The task may be incomplete.', 'ollama/x', '');
  assert.match(steps.hint, /continue/);
  assert.equal(steps.stepLimit, true);
  assert.equal(steps.modelIssue, undefined);
  assert.equal(m.friendlyError('something odd', 'ollama/x', '').title, 'something odd');
});

test('model pre-flight checks explain what is missing', async () => {
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    assert.match(await m.modelProblem('direct:deepseek/deepseek-flash', ''), /DEEPSEEK_API_KEY isn't set/);
    assert.match(await m.modelProblem('direct:nope', ''), /isn't a valid model ID/);
    assert.match(await m.modelProblem('ollama/x', 'http://127.0.0.1:9'), /No local model server is answering/);
  } finally { if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved; }
});

test('the permission mode chosen for a folder is remembered per folder', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-ws-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.CODICO_CONFIG; });
  process.env.CODICO_CONFIG = path.join(dir, 'config.json');
  const a = fixture(t), b = fixture(t);
  assert.equal(m.workspaceMode(a), undefined);
  m.rememberWorkspaceMode(a, 'edits');
  assert.equal(m.workspaceMode(a), 'edits');
  assert.equal(m.workspaceMode(b), undefined);
  assert.equal(m.parseCliArgs(['chat']).permissionsExplicit, false);
  assert.equal(m.parseCliArgs(['chat', '--allow-edits']).permissionsExplicit, true);
});

test('--auto allows edits and commands without per-action approval flags', () => {
  const auto = m.parseCliArgs(['--auto']);
  assert.equal(auto.auto, true);
  assert.equal(auto.permissions, 'all');
  assert.equal(auto.permissionsExplicit, true);
  assert.equal(m.parseCliArgs(['agent', 'fix it', '--auto']).auto, true);
  assert.equal(m.parseCliArgs(['chat']).auto, false);
});

test('the model is told which shell runs its commands', () => {
  const win = m.environmentSection('C:\work', 'win32', {});
  assert.match(win, /Windows/);
  assert.match(win, /cmd\.exe/);
  assert.match(win, /dir \(not ls\)/);
  const linux = m.environmentSection('/work', 'linux', { SHELL: '/bin/bash' });
  assert.match(linux, /Linux/);
  assert.match(linux, /\/bin\/bash/);
});

test('--ask and --plan start in the read-only modes', () => {
  const ask = m.parseCliArgs(['--ask']);
  assert.equal(ask.permissions, 'read');
  assert.equal(ask.plan, false);
  assert.equal(ask.permissionsExplicit, true);
  const plan = m.parseCliArgs(['--plan']);
  assert.equal(plan.permissions, 'read');
  assert.equal(plan.plan, true);
  assert.equal(m.parseCliArgs(['agent', 'refactor x', '--plan']).plan, true);
});

test('inline code is styled before wrapping, so a code span is never split into stray backticks', () => {
  let out = '';
  const stream = new m.MarkdownStream(m.painter(true), () => 60, t => { out += t; }, new Set());
  stream.push('1. Create index.html with `<html lang="en">`, a head containing `<meta charset="utf-8">` and `<title>Todo</title>` blocks.\n');
  stream.end();
  assert.ok(out.split('\n').length > 2, 'the item wraps');
  assert.doesNotMatch(m.stripAnsi(out), /`/);
  assert.match(m.stripAnsi(out), /<meta charset="utf-8">/);
});

test('picker rows never exceed the terminal width', async () => {
  const { EventEmitter } = require('node:events');
  const keys = new EventEmitter();
  let screen = '';
  const out = { write: t => { screen += t; }, columns: 40 };
  const pending = m.select(keys, out, m.painter(true), { title: 'A rather long title for a narrow terminal window', choices: [
    { label: 'Auto — agent that edits and runs commands without asking', value: 1, hint: 'no approvals' }] });
  const first = screen;
  keys.emit('keypress', undefined, { name: 'escape' });
  await pending;
  for (const line of first.split('\n')) { assert.ok(m.stripAnsi(line).length <= 39, line); }
});
