const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { streamClaudeCode, claudeCodePrompt, parseClaudeCodeLine, claudeCodeCompletion } = require('../out/claudeCodeClient.js');

const FAKE = path.join(__dirname, 'fixtures', 'fakeClaude.js');
const cli = { command: process.execPath, baseArgs: [FAKE] };
const collect = async (iterable) => { const out = []; for await (const c of iterable) { out.push(c); } return out; };
const tempDirs = [];
test.after(() => { for (const d of tempDirs) { fs.rmSync(d, { recursive: true, force: true }); } });
function withLog(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-cc-')); tempDirs.push(dir);
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'calls.jsonl');
  if (mode) { process.env.FAKE_CLAUDE_MODE = mode; } else { delete process.env.FAKE_CLAUDE_MODE; }
  return () => fs.readFileSync(process.env.FAKE_CLAUDE_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

test('the first message is the prompt; later turns are sent as a transcript to continue', () => {
  assert.equal(claudeCodePrompt([{ role: 'user', content: 'fix the bug' }]), 'fix the bug');
  const prompt = claudeCodePrompt([
    { role: 'user', content: 'read the notes' },
    { role: 'assistant', content: '```read_file\nfilepath: notes.txt\n```' },
    { role: 'user', content: '[Tool Results]\n\nNOTES' },
  ]);
  assert.match(prompt, /Write the next assistant turn only/);
  assert.match(prompt, /<conversation>\n<user>\nread the notes\n<\/user>\n<assistant>\n```read_file[\s\S]*<\/assistant>\n<user>\n\[Tool Results\]\n\nNOTES\n<\/user>\n<\/conversation>$/);
});

test('output lines of the real CLI are parsed: text, thinking, usage with cache reads, no cost', () => {
  const state = { sawText: false };
  // Lines captured from claude 2.1.295
  assert.deepEqual(parseClaudeCodeLine('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PONG"}}}', state), [{ type: 'content', text: 'PONG' }]);
  assert.deepEqual(parseClaudeCodeLine('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hm"}}}', state), [{ type: 'thinking', text: 'hm' }]);
  assert.deepEqual(parseClaudeCodeLine('{"type":"system","subtype":"init","session_id":"x"}', state), []);
  assert.deepEqual(parseClaudeCodeLine('{"type":"rate_limit_event","rate_limit_info":{}}', state), []);
  const result = parseClaudeCodeLine('{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","result":"PONG","total_cost_usd":0.00025,"usage":{"input_tokens":2,"cache_creation_input_tokens":613,"cache_read_input_tokens":1200,"output_tokens":5}}', state);
  assert.deepEqual(result, [{ type: 'usage', promptTokens: 1815, completionTokens: 5, totalTokens: 1820, cachedTokens: 1200 }]);
  // Without streamed text the final result is the reply
  assert.deepEqual(parseClaudeCodeLine('{"type":"result","subtype":"success","result":"hello"}', { sawText: false }), [{ type: 'content', text: 'hello' }]);
});

test('a request runs the CLI as a model only: no tools, its own system prompt, a neutral folder', async () => {
  const calls = withLog();
  const history = [{ role: 'user', content: 'say pong' }];
  const chunks = await collect(streamClaudeCode(cli, history, 'sonnet', 'Repo rule: be brief.', undefined, 'low', 'SYSTEM PROMPT'));
  assert.equal(chunks.filter(c => c.type === 'content').map(c => c.text).join(''), 'PONG');
  assert.deepEqual(chunks.find(c => c.type === 'thinking'), { type: 'thinking', text: 'Working it out.' });
  assert.equal(chunks.find(c => c.type === 'usage').cachedTokens, 1200);
  const [call] = calls();
  const arg = (name) => call.args[call.args.indexOf(name) + 1];
  assert.ok(call.args.includes('-p') && call.args.includes('--no-session-persistence') && call.args.includes('--strict-mcp-config'));
  assert.equal(arg('--tools'), '', "Claude Code's own tools are off");
  assert.equal(arg('--model'), 'sonnet');
  assert.equal(arg('--effort'), 'low');
  assert.equal(arg('--system-prompt'), 'SYSTEM PROMPT\n\nRepo rule: be brief.');
  assert.equal(call.prompt, 'say pong');
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(os.tmpdir()), "not the user's project folder");
});

test('a system prompt too long for a command line moves its extra part into the prompt', async () => {
  const calls = withLog();
  const prefix = 'Repo instruction. '.repeat(1500); // 27,000 characters
  await collect(streamClaudeCode(cli, [{ role: 'user', content: 'hi' }], 'sonnet', prefix, undefined, 'medium', 'BASE'));
  const [call] = calls();
  assert.equal(call.args[call.args.indexOf('--system-prompt') + 1], 'BASE');
  assert.match(call.prompt, /^<instructions>\n\n\nRepo instruction\. [\s\S]*<\/instructions>\n\nhi$/);
});

test('failures are reported in plain words: signed out, API error, command not found', async () => {
  withLog('signed-out');
  const signedOut = await collect(streamClaudeCode(cli, [{ role: 'user', content: 'hi' }], 'sonnet'));
  assert.match(signedOut.find(c => c.type === 'stream_error').message, /Invalid API key[\s\S]*run "claude" in a terminal and log in/);
  withLog('api-error');
  const apiError = await collect(streamClaudeCode(cli, [{ role: 'user', content: 'hi' }], 'sonnet'));
  assert.match(apiError.find(c => c.type === 'stream_error').message, /Claude Code: API Error: overloaded/);
  await assert.rejects(collect(streamClaudeCode({ command: 'codico-no-such-claude' }, [{ role: 'user', content: 'hi' }], 'sonnet')), /was not found[\s\S]*codico\.claudeCodePath/);
});

test('Stop ends a running request', async () => {
  withLog('slow');
  const stop = new AbortController();
  const started = Date.now();
  setTimeout(() => stop.abort(), 200);
  const chunks = await collect(streamClaudeCode(cli, [{ role: 'user', content: 'hi' }], 'sonnet', undefined, stop.signal));
  assert.deepEqual(chunks, []);
  assert.ok(Date.now() - started < 3000);
});

test('one-shot requests (summaries) return the reply text', async () => {
  withLog();
  assert.equal(await claudeCodeCompletion(cli, 'Summarise this.', 'haiku'), 'PONG');
});
