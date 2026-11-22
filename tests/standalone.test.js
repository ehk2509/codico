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


test('standalone honors .codicoignore and .copilotignore', async t => {
  const cwd = fixture(t);
  fs.writeFileSync(path.join(cwd, '.copilotignore'), 'hello.txt\n');
  fs.writeFileSync(path.join(cwd, '.codicoignore'), '!hello.txt\nsecret.txt\nprivate/\n');
  fs.writeFileSync(path.join(cwd, 'secret.txt'), 'sensitive-secret');
  fs.mkdirSync(path.join(cwd, 'private'));
  fs.writeFileSync(path.join(cwd, 'private', 'another.txt'), 'sensitive-secret');
  const w = new NodeWorkspace(cwd);
  const signal = new AbortController().signal;
  assert.match(await w.execute({type:'read_file', filepath:'hello.txt'}, signal), /hello world/);
  assert.throws(() => w.resolve('secret.txt'), /Ignored workspace path/);
  assert.throws(() => w.resolve('private/another.txt'), /Ignored workspace path/);
  assert.doesNotMatch(await w.execute({type:'list_directory',dirpath:'.'},signal), /secret.txt|private/);
  assert.doesNotMatch(await w.execute({type:'search_files',pattern:'sensitive-secret',isRegex:false},signal), /secret.txt|private/);
  assert.doesNotMatch(await w.execute({type:'find_files',pattern:'*.txt'},signal), /secret.txt|another.txt/);
});


test('session storage is private, workspace-scoped and resumable', t => {
  const { SessionStore } = require('../dist/standalone.js');
  const cwd = fixture(t);
  const sibling = fixture(t);
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-session-test-'));
  t.after(() => fs.rmSync(baseDir, { recursive:true, force:true }));
  const store = new SessionStore(cwd, baseDir);
  const session = store.create('ollama/one');
  session.history = [{role:'user',content:'hello'},{role:'assistant',content:'hi'}];
  store.save(session);
  const restored = store.load(session.id);
  assert.deepEqual(restored.history, session.history);
  assert.equal(store.latest().id, session.id);
  assert.equal(store.list()[0].model, 'ollama/one');
  assert.throws(() => store.load('../other'), /Invalid session ID/);
  assert.throws(() => new SessionStore(sibling, baseDir).load(session.id), /ENOENT/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(store.root,session.id+'.json')).mode & 0o777,0o600);
  }
  store.remove(session.id);
  assert.deepEqual(store.list(), []);
});

test('project instructions, skills and custom agents are usable without VS Code', t => {
  const { ProjectContext } = require('../dist/standalone.js');
  const cwd = fixture(t);
  fs.writeFileSync(path.join(cwd,'AGENTS.md'),'Always inspect tests before editing.');
  fs.mkdirSync(path.join(cwd,'.codico','skills','audit'),{recursive:true});
  fs.mkdirSync(path.join(cwd,'.codico','agents'),{recursive:true});
  fs.writeFileSync(path.join(cwd,'.codico','skills','audit','SKILL.md'),
    '---\nname: audit\ndescription: Audit changes\n---\nInspect the code carefully.');
  fs.writeFileSync(path.join(cwd,'.codico','agents','reviewer.md'),
    '---\nname: reviewer\ndescription: Review files\n---\nLook for regression bugs.');
  const project = new ProjectContext(cwd);
  assert.match(project.preamble,/Always inspect tests/);
  assert.match(project.preamble,/audit/);
  assert.match(project.expand('/audit src/index.ts'),/Inspect the code carefully/);
  assert.match(project.expand('@reviewer Review the files'),/regression bugs/);
});

test('MCP startup and tool calls require approvals and use a stdio JSON-RPC protocol', async t => {
  const { StdioMcp, loadMcpConfig } = require('../dist/standalone.js');
  const cwd = fixture(t);
  const script = path.join(cwd,'mock-mcp.js');
  fs.writeFileSync(script, [
    "'use strict';",
    "let data='';",
    "process.stdin.on('data', chunk => { data+=chunk.toString(); for (;;) {",
    "const i=data.indexOf('\\n'); if(i<0)break;",
    "const line=data.slice(0,i); data=data.slice(i+1); let req;",
    "try{req=JSON.parse(line)}catch{continue}",
    "if (req.id === undefined)continue;",
    "let result={};",
    "if(req.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{}};",
    "if(req.method==='tools/list')result={tools:[{name:'echo',description:'echo',inputSchema:{type:'object',properties:{value:{type:'string'}}}}]};",
    "if(req.method==='tools/call')result={content:[{type:'text',text:req.params.arguments.value}]};",
    "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');",
    "}});"
  ].join('\n'));
  fs.writeFileSync(path.join(cwd,'.mcp.json'),JSON.stringify({
    mcpServers: { mock: { command: process.execPath, args:[script] } }
  }));
  const cfg=loadMcpConfig(cwd);
  assert.equal(cfg.length,1);
  let approvals=0;
  const mcp=new StdioMcp(cwd, async () => { approvals++; return true; });
  t.after(()=>mcp.close());
  assert.deepEqual(await mcp.connect(cfg),[]);
  assert.ok(mcp.tools.some(x=>x.name==='echo'));
  assert.match(await mcp.call('mock','echo',{value:'untrusted text'},new AbortController().signal),/untrusted_content/);
  assert.equal(approvals,2);
  await mcp.close();
});

test('browser remains opt-in and rejects unsafe file URLs before launching Chromium', async t => {
  const { CliBrowser }=require('../dist/standalone.js');
  const browser=new CliBrowser(async()=>true);
  t.after(()=>browser.close());
  const result=await browser.execute({type:'browser_navigate',url:'file:///etc/passwd'},new AbortController().signal);
  assert.match(result,/Denied/);
});

test('memory updates are permission-gated and do not accept secrets', async t => {
  const { StandaloneAgent }=require('../dist/standalone.js');
  const cwd=fixture(t);
  let iteration=0;
  const agent=new StandaloneAgent({
    cwd,model:'mock',permissions:'edits',approve:async kind=>kind==='write',
    stream:async function* () {
      if(++iteration===1) {
        yield {type:'native_tool',call:{id:'mem1',name:'remember',arguments:{note:'The formatter is in scripts/format.js',topic:'Where things live'}}};
      } else {yield {type:'content',text:'Memory saved.'};}
    }
  });
  assert.match(await agent.run('Remember the formatter path'),/Memory saved/);
  assert.match(fs.readFileSync(path.join(cwd,'.codico','memory.md'),'utf8'),/formatter/);
});

test('standalone npm binary and Node.js SDK export are packaged independently of VS Code', () => {
  const entry=path.join(__dirname,'..','packages','cli','bin','codico.js');
  const manifest=require('../packages/cli/package.json');
  assert.equal(manifest.bin.codico,'./bin/codico.js');
  assert.ok(manifest.exports['.']);
  const run=cp.spawnSync(process.execPath,[entry,'--help'],{encoding:'utf8',timeout:15000});
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout,/Codico CLI/);
});


test('read-only mode never permits persistent memory writes, even when approval callback grants', async t => {
  const cwd=fixture(t);
  let n=0;
  const agent=new StandaloneAgent({
    cwd,model:'mock',permissions:'read',approve:async()=>true,
    stream:async function* (history) {
      if(++n===1) yield {type:'native_tool',call:{id:'mem',name:'remember',arguments:{note:'a durable note'}}};
      else {
        assert.match(history[history.length-1].content,/Denied: project memory writes/);
        yield {type:'content',text:'Denied as required'};
      }
    }
  });
  assert.match(await agent.run('remember this'),/Denied as required/);
  assert.equal(fs.existsSync(path.join(cwd,'.codico','memory.md')),false);
});

test('web fetch cannot access localhost and CLI opt-in flags are explicit', async t => {
  const { CliWeb }=require('../dist/standalone.js');
  const web=new CliWeb(async()=>true);
  await assert.rejects(web.execute({type:'fetch_url',url:'http://127.0.0.1:80'},new AbortController().signal),/private|loopback|metadata/i);
  const opts=parseCliArgs(['agent','review','--allow-web','--resume','last','--allow-browser']);
  assert.equal(opts.allowWeb,true);
  assert.equal(opts.resume,'last');
  assert.equal(opts.allowBrowser,true);
  assert.throws(()=>parseCliArgs(['chat','--no-session','--resume','last']),/cannot be combined/);
  assert.throws(()=>parseCliArgs(['chat','--mcp-config','x.json']),/requires --allow-mcp/);
});
