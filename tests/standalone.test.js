'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { StandaloneAgent } = require('../dist/standalone.js');
const { NodeWorkspace } = require('../dist/standalone.js');
const { parseCliArgs } = require('../dist/standalone.js');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-native-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'hello.txt'), 'hello world\n');
  return cwd;
}

test('CLI parser is portable and read-only by default', () => {
  assert.equal(parseCliArgs([]).mode, 'chat');
  assert.equal(parseCliArgs(['chat']).permissions, 'read');
  const parsed = parseCliArgs(['agent', 'fix tests', '--cwd', '.', '--model', 'ollama/a', '--allow-commands', '--json']);
  assert.equal(parsed.mode, 'agent');
  assert.equal(parsed.prompt, 'fix tests');
  assert.equal(parsed.model, 'ollama/a');
  assert.equal(parsed.permissions, 'all');
  assert.equal(parsed.json, true);
  assert.throws(() => parseCliArgs(['agent']), /requires a task/);
  assert.throws(() => parseCliArgs(['agent', 'hello', '--max-steps', '-3']), /1 to 100/);
});

test('workspace tools cannot escape root or traverse symlinks', async t => {
  const cwd = fixture(t);
  const w = new NodeWorkspace(cwd);
  assert.equal(w.resolve('hello.txt'), path.join(w.cwd, 'hello.txt'));
  assert.throws(() => w.resolve('../secret.txt'), /escapes the workspace/);
  assert.throws(() => w.resolve('C:\\windows\\system.ini'), /Absolute paths/);
  assert.throws(() => w.resolve('.git/config'), /Protected path/);
  assert.throws(() => w.resolve('.env.local'), /Protected path/);
  const link = path.join(cwd, 'link');
  try {
    fs.symlinkSync(os.tmpdir(), link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => w.resolve('link/outside.txt'), /Symlink paths/);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
  }
});

test('read-only tools work; writes and commands are denied by default', async t => {
  const cwd = fixture(t);
  const w = new NodeWorkspace(cwd);
  const signal = new AbortController().signal;
  assert.match(await w.execute({ type: 'read_file', filepath: 'hello.txt' }, signal), /hello world/);
  assert.match(await w.execute({ type: 'list_directory', dirpath: '.' }, signal), /hello.txt/);
  assert.match(await w.execute({ type: 'find_files', pattern: '*.txt' }, signal), /hello.txt/);
  assert.match(await w.execute({ type: 'search_files', pattern: 'hello', isRegex: false }, signal), /hello.txt:1/);
  assert.match(await w.execute({ type: 'write_file', filepath: 'hello.txt', content: 'changed' }, signal), /Denied/);
  assert.match(await w.execute({ type: 'run_terminal', command: 'echo unsafe' }, signal), /Denied/);
  assert.equal(fs.readFileSync(path.join(cwd, 'hello.txt'), 'utf8'), 'hello world\n');
});

test('explicit approval permits edits; stale and ambiguous edits are rejected', async t => {
  const cwd = fixture(t);
  let count = 0;
  const w = new NodeWorkspace(cwd, 'edits', async kind => { count++; assert.equal(kind, 'write'); return true; });
  const signal = new AbortController().signal;
  assert.match(await w.execute({ type: 'edit_file', filepath: 'hello.txt', oldStr: 'hello', newStr: 'goodbye' }, signal), /Edited/);
  assert.equal(fs.readFileSync(path.join(cwd, 'hello.txt'), 'utf8'), 'goodbye world\n');
  assert.match(await w.execute({ type: 'edit_file', filepath: 'hello.txt', oldStr: 'missing', newStr: 'x' }, signal), /exactly once/);
  assert.match(await w.execute({ type: 'write_file', filepath: 'sub/new.txt', content: 'new' }, signal), /Wrote/);
  assert.equal(fs.readFileSync(path.join(cwd, 'sub/new.txt'), 'utf8'), 'new');
  assert.equal(count, 2);
});

test('native tool calls reuse the repository provider-conversation history protocol', async t => {
  const cwd = fixture(t);
  const events = [];
  let turns = 0;
  const agent = new StandaloneAgent({
    cwd, model: 'mock', onEvent: e => events.push(e),
    stream: async function* () {
      turns++;
      if (turns === 1) yield { type: 'native_tool', call: { id: 'call1', name: 'read_file', arguments: { filepath: 'hello.txt' } } };
      else yield { type: 'content', text: 'File contains hello world.' };
    },
  });
  const answer = await agent.run('Read the hello file');
  assert.equal(answer, 'File contains hello world.');
  assert.equal(turns, 2);
  assert.ok(events.some(e => e.type === 'toolResult' && /hello world/.test(e.text)));
  assert.ok(agent.history.some(message => message.role === 'tool' && message.toolCallId === 'call1'));
});

test('text-fenced tool calls work without native calling', async t => {
  const cwd = fixture(t);
  let turn = 0;
  const agent = new StandaloneAgent({
    cwd, model: 'mock',
    stream: async function* () {
      if (++turn === 1) yield { type: 'content', text: '```read_file\nfilepath: hello.txt\n```' };
      else yield { type: 'content', text: 'The file says hello.' };
    },
  });
  assert.equal(await agent.run('read'), 'The file says hello.');
  assert.equal(turn, 2);
});

test('CLI --help works without VS Code installed', () => {
  const executable = path.join(__dirname, '..', 'bin', 'codico.js');
  const r = cp.spawnSync(process.execPath, [executable, 'chat', '--help'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Windows, macOS, Linux/);
});


test('Qwen XML tool calls share the existing Codico parser', async t => {
  const cwd = fixture(t);
  let turn = 0;
  const agent = new StandaloneAgent({
    cwd, model: 'mock',
    stream: async function* () {
      if (++turn === 1) yield { type: 'content', text: '<tool_call><function=read_file><parameter=filepath>hello.txt</parameter></function></tool_call>' };
      else yield { type: 'content', text: 'Read hello.txt successfully.' };
    },
  });
  assert.equal(await agent.run('read'), 'Read hello.txt successfully.');
  assert.equal(turn, 2);
});


test('unsupported text-format tool calls are returned as errors to the model', async t => {
  const cwd = fixture(t);
  let turn = 0;
  const agent = new StandaloneAgent({
    cwd, model: 'mock',
    stream: async function* (history) {
      if (++turn === 1) {
        yield { type: 'content', text: '```web_search\nquery: cat\n```' };
      } else {
        assert.match(history[history.length - 1].content, /web_search.*unavailable/);
        yield { type: 'content', text: 'Web searching is unavailable in the CLI.' };
      }
    },
  });
  assert.match(await agent.run('search'), /unavailable/);
  assert.equal(turn, 2);
});

test('exhausting the model step budget fails rather than claiming completion', async t => {
  const cwd = fixture(t);
  const agent = new StandaloneAgent({
    cwd, model: 'mock', maxSteps: 1,
    stream: async function* () {
      yield { type: 'native_tool', call: { id: 'call1', name: 'read_file', arguments: { filepath: 'hello.txt' } } };
    },
  });
  await assert.rejects(agent.run('read then finish'), /Stopped after 1 model requests/);
});

test('truncated model streams cannot claim an agent task completed', async t => {
  const cwd = fixture(t);
  const agent = new StandaloneAgent({
    cwd, model: 'mock',
    stream: async function* () {
      yield { type: 'content', text: 'I am about to complete' };
      yield { type: 'finish', reason: 'length' };
    },
  });
  await assert.rejects(agent.run('fix the bug'), /ended prematurely/);
});

test('failed shell commands are reported as unsuccessful tool events', async t => {
  const cwd = fixture(t);
  const events = [];
  let turn = 0;
  const agent = new StandaloneAgent({
    cwd, model: 'mock', permissions: 'all', approve: async () => true,
    onEvent: e => events.push(e),
    stream: async function* () {
      if (++turn === 1) {
        yield { type: 'native_tool', call: {
          id: 'cmd1', name: 'run_terminal',
          arguments: { command: `"${process.execPath}" -e "process.exit(7)"` }
        } };
      } else { yield { type: 'content', text: 'The command failed.' }; }
    },
  });
  assert.match(await agent.run('run failing command'), /failed/);
  assert.ok(events.some(e => e.type === 'toolResult' && e.tool === 'run_terminal' && e.ok === false && /Exit code: 7/.test(e.text)));
});

test('approved writes are atomic and preserve executable bits on POSIX', async t => {
  const cwd = fixture(t);
  const target = path.join(cwd, 'program');
  fs.writeFileSync(target, 'old');
  if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
  const w = new NodeWorkspace(cwd, 'edits', async () => true);
  const signal = new AbortController().signal;
  assert.match(await w.execute({ type: 'write_file', filepath: 'program', content: 'new' }, signal), /Wrote/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(cwd).filter(x => x.startsWith('.codico-write-')), []);
  assert.match(await w.execute({ type: 'write_file', filepath: 'program', content: 'x'.repeat(2 * 1024 * 1024 + 1) }, signal), /2 MB/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
});
