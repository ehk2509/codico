const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { streamChatGPT, parseCodexLine, codexArgs, codexFeatures, chatgptCompletion } = require('../out/chatgptClient.js');

const FAKE = path.join(__dirname, 'fixtures', 'fakeCodex.js');
const collect = async (iterable) => { const out = []; for await (const c of iterable) { out.push(c); } return out; };
const tempDirs = [];
test.after(() => { for (const d of tempDirs) { fs.rmSync(d, { recursive: true, force: true }); } });
// Each test gets its own command line, so the feature list is asked again for it
let run = 0;
function fake(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-cx-')); tempDirs.push(dir);
  process.env.FAKE_CODEX_LOG = path.join(dir, 'calls.jsonl');
  if (mode) { process.env.FAKE_CODEX_MODE = mode; } else { delete process.env.FAKE_CODEX_MODE; }
  const calls = () => fs.readFileSync(process.env.FAKE_CODEX_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { cli: { command: process.execPath, baseArgs: [`--title=codico-test-${++run}`, FAKE] }, calls };
}
const valueAfter = (args, flag, startsWith) => args.filter((a, i) => args[i - 1] === flag && (!startsWith || a.startsWith(startsWith)));

test('a reply: reasoning, the answer and the tokens', async () => {
  const { cli, calls } = fake();
  const chunks = await collect(streamChatGPT(cli, [{ role: 'user', content: 'say pong' }], 'gpt-5.5', 'EXTRA RULES', undefined, 'high'));
  assert.deepEqual(chunks.filter(c => c.type === 'content').map(c => c.text), ['PONG']);
  assert.deepEqual(chunks.filter(c => c.type === 'thinking').map(c => c.text), ['**Working it out**\n']);
  assert.deepEqual(chunks.find(c => c.type === 'usage'), { type: 'usage', promptTokens: 1800, completionTokens: 5, totalTokens: 1805, cachedTokens: 1200 });
  assert.equal(chunks.some(c => c.type === 'stream_error'), false);

  const exec = calls().find(c => c.args[0] === 'exec');
  assert.equal(exec.prompt, 'say pong');
  assert.deepEqual(valueAfter(exec.args, '-m'), ['gpt-5.5']);
  assert.deepEqual(valueAfter(exec.args, '-s'), ['read-only']);
  assert.deepEqual(valueAfter(exec.args, '-c', 'model_reasoning_effort'), ['model_reasoning_effort="high"']);
  assert.ok(exec.args.includes('--json') && exec.args.includes('--ephemeral') && exec.args.includes('--ignore-user-config'));
  // Codico's system prompt replaces Codex's own, with the extra instructions after it
  assert.match(exec.instructions, /fenced-code-block formats/);
  assert.match(exec.instructions, /EXTRA RULES$/);
  // Not in the user's project
  assert.notEqual(exec.cwd, process.cwd());
});

test('only the features the installed codex knows are switched off', async () => {
  const { cli, calls } = fake();
  await collect(streamChatGPT(cli, [{ role: 'user', content: 'hi' }], 'gpt-5.5'));
  const exec = calls().find(c => c.args[0] === 'exec');
  // The stand-in knows these five of Codico's list; it refuses any other name
  assert.deepEqual(valueAfter(exec.args, '--disable'), ['shell_tool', 'unified_exec', 'view_image', 'goals', 'apps']);
  assert.deepEqual(await codexFeatures(cli), ['apps', 'goals', 'shell_tool', 'unified_exec', 'view_image', 'undo']);
  // Asked once, not per request
  await collect(streamChatGPT(cli, [{ role: 'user', content: 'again' }], 'gpt-5.5'));
  assert.equal(calls().filter(c => c.args[0] === 'features').length, 1);
});

test('the feature list cannot be read: the request still runs, with nothing switched off by name', async () => {
  const { cli, calls } = fake('no-features');
  const chunks = await collect(streamChatGPT(cli, [{ role: 'user', content: 'hi' }], 'gpt-5.5'));
  assert.deepEqual(chunks.filter(c => c.type === 'content').map(c => c.text), ['PONG']);
  assert.deepEqual(valueAfter(calls().find(c => c.args[0] === 'exec').args, '--disable'), []);
});

test('the instructions file is removed after the run', async () => {
  const { cli, calls } = fake();
  await collect(streamChatGPT(cli, [{ role: 'user', content: 'hi' }], 'gpt-5.5'));
  const exec = calls().find(c => c.args[0] === 'exec');
  const file = JSON.parse(valueAfter(exec.args, '-c', 'model_instructions_file')[0].split(/=(.*)/s)[1]);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(file), false);
});

test('an API key in the environment is not passed on: the ChatGPT login is used', async () => {
  const { cli, calls } = fake();
  process.env.OPENAI_API_KEY = 'sk-should-not-be-used';
  try { await collect(streamChatGPT(cli, [{ role: 'user', content: 'hi' }], 'gpt-5.5')); } finally { delete process.env.OPENAI_API_KEY; }
  assert.equal(calls().find(c => c.args[0] === 'exec').apiKey, null);
});

test('not signed in: one error that says how to sign in, not the retry notices', async () => {
  const { cli } = fake('signed-out');
  const errors = (await collect(streamChatGPT(cli, [{ role: 'user', content: 'hi' }], 'gpt-5.5'))).filter(c => c.type === 'stream_error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /^ChatGPT: unexpected status 401 Unauthorized/);
  assert.match(errors[0].message, /codex login/);
  assert.doesNotMatch(errors[0].message, /Reconnecting/);
});

test('the command does not exist: a message that says what to install', async () => {
  await assert.rejects(collect(streamChatGPT({ command: path.join(os.tmpdir(), 'no-such-codex-command') }, [{ role: 'user', content: 'hi' }], 'gpt-5.5')),
    /codex command was not found[\s\S]*codico\.codexPath/);
});

test('stopping ends the run', async () => {
  const { cli } = fake('slow');
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 300);
  const chunks = await collect(streamChatGPT(cli, [{ role: 'user', content: 'hi' }], 'gpt-5.5', undefined, controller.signal));
  assert.ok(Date.now() - started < 5000);
  assert.equal(chunks.some(c => c.type === 'stream_error'), false);
});

test('a one-shot request returns the text, and an empty string on failure', async () => {
  const ok = fake();
  assert.equal(await chatgptCompletion(ok.cli, 'summarise', 'gpt-5.5'), 'PONG');
  const exec = ok.calls().find(c => c.args[0] === 'exec');
  assert.equal(exec.instructions, 'You complete one writing task and reply with the result only.');
  assert.equal(await chatgptCompletion({ command: path.join(os.tmpdir(), 'no-such-codex-command') }, 'summarise', 'gpt-5.5'), '');
});

test('lines of the output', () => {
  const state = { sawText: false, lastError: '' };
  assert.deepEqual(parseCodexLine('2026-10-10T09:05:48Z ERROR codex_api: not json', state), []);
  assert.deepEqual(parseCodexLine('{"type":"thread.started","thread_id":"t"}', state), []);
  assert.deepEqual(parseCodexLine('{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}', state), []);
  assert.deepEqual(parseCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":"one"}}', state), [{ type: 'content', text: 'one' }]);
  // A second message of the same turn is a new paragraph
  assert.deepEqual(parseCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":"two"}}', state), [{ type: 'content', text: '\n\ntwo' }]);
  assert.deepEqual(parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":3}}', state),
    [{ type: 'usage', promptTokens: 10, completionTokens: 3, totalTokens: 13 }]);
  // A failure with no message of its own reports the last error seen
  assert.deepEqual(parseCodexLine('{"type":"error","message":"usage limit reached"}', state), []);
  assert.deepEqual(parseCodexLine('{"type":"turn.failed","error":{}}', state), [{ type: 'stream_error', message: 'ChatGPT: usage limit reached' }]);
});

test('the command line', () => {
  const args = codexArgs('gpt-6-sol', 'low', '/tmp/a "b".md', ['shell_tool']);
  assert.equal(args[0], 'exec');
  assert.equal(args[args.length - 1], '-');
  assert.ok(args.includes('model_instructions_file="/tmp/a \\"b\\".md"'));
  assert.deepEqual(valueAfter(args, '--disable'), ['shell_tool']);
});
