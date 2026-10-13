const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');

const settings = { commandSandbox: 'off', commandSandboxNetwork: true, commandSandboxWritablePaths: [] };
let folders = [];
const vscodeStub = { workspace: { getConfiguration: () => ({ get: (key, fallback) => key in settings ? settings[key] : fallback }), get workspaceFolders() { return folders.map(f => ({ uri: { scheme: 'file', fsPath: f } })); } } };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain); };
test.after(() => { Module._load = originalLoad; });

const { sandboxPolicy, bubblewrapArgs, seatbeltProfile, sandboxedCommand, sandboxToolFor, gitCommonDir, hitTheSandbox, sandboxExplanation } = require('../out/commandSandbox.js');
const { commandSandbox, sandboxWorks } = require('../out/commandSandboxService.js');
const { runTerminalProcess } = require('../out/terminalProcess.js');

// Outside the system's temporary folder, which the sandbox makes private: a place that stands for "the rest of the machine"
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.homedir(), '.codico-sandbox-test-')));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
const home = path.join(base, 'home'); const workspace = path.join(base, 'workspace'); const outside = path.join(base, 'outside');
for (const dir of [home, workspace, outside, path.join(home, '.ssh'), path.join(home, '.npm')]) { fs.mkdirSync(dir, { recursive: true }); }
fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE-KEY-MATERIAL\n');
fs.writeFileSync(path.join(home, '.netrc'), 'machine example.org password NETRC-SECRET\n');
fs.writeFileSync(path.join(outside, 'data.txt'), 'outside data\n');
fs.writeFileSync(path.join(workspace, 'app.js'), 'console.log(1)\n');
const policyFor = (over = {}) => sandboxPolicy({ workspaceFolders: [workspace], home, tmp: os.tmpdir(), ...over });

test('the rules: the workspace and caches are writable, credential folders are hidden, and only what exists is named', () => {
  const policy = policyFor();
  assert.deepEqual(policy.writable, [workspace, path.join(home, '.npm')]);
  assert.deepEqual(policy.hidden.sort(), [path.join(home, '.netrc'), path.join(home, '.ssh')]);
  assert.equal(policy.network, true);
  assert.ok(policy.temporary.includes(fs.realpathSync.native(os.tmpdir())));
  // A configured path widens what is writable, but can never uncover a credential folder
  const widened = policyFor({ extraWritable: [outside, path.join(home, '.ssh'), path.join(home, '.ssh', 'id_ed25519'), path.join(base, 'does-not-exist')], network: false });
  assert.deepEqual(widened.writable, [workspace, path.join(home, '.npm'), outside]);
  assert.equal(widened.network, false);
  assert.deepEqual([sandboxToolFor('linux'), sandboxToolFor('darwin'), sandboxToolFor('win32')], ['bubblewrap', 'seatbelt', undefined]);
});

test('the wrapper commands say what the rules say, and the command is one argument that no shell re-reads', () => {
  const policy = policyFor({ network: false });
  const hostile = 'echo "a b"; rm -rf ~ # $(id) `id`';
  const args = bubblewrapArgs(policy, '/bin/sh', hostile);
  assert.deepEqual(args.slice(0, 9), ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--die-with-parent']);
  assert.deepEqual(args.slice(-4), ['--', '/bin/sh', '-c', hostile]);
  const text = args.join(' ');
  assert.ok(text.includes(`--bind ${workspace} ${workspace}`) && text.includes(`--tmpfs ${path.join(home, '.ssh')}`) && text.includes(`--ro-bind /dev/null ${path.join(home, '.netrc')}`) && text.includes('--unshare-net'));
  // Hiding comes after the writable folders, so that neither can undo the other
  assert.ok(args.indexOf(path.join(home, '.ssh')) > args.lastIndexOf('--bind'));
  assert.ok(!bubblewrapArgs(policyFor(), '/bin/sh', 'true').includes('--unshare-net'));
  const profile = seatbeltProfile(policy);
  assert.match(profile, /^\(version 1\)\n\(allow default\)\n\(deny file-write\* \(subpath "\/"\)\)\n\(allow file-write\* /);
  assert.ok(profile.includes(`(subpath "${workspace}")`) && profile.includes(`(deny file-read* file-write* `) && profile.includes(`(subpath "${path.join(home, '.ssh')}")`) && profile.endsWith('(deny network*)'));
  assert.ok(seatbeltProfile({ ...policy, writable: ['/a "quoted" \\ path'] }).includes('(subpath "/a \\"quoted\\" \\\\ path")'));
  assert.deepEqual(sandboxedCommand('seatbelt', policy, '/bin/sh', hostile).args.slice(-3), ['/bin/sh', '-c', hostile]);
});

test('a failure caused by the sandbox is explained to the agent, an ordinary failure is not', () => {
  for (const output of ['touch: cannot touch \'/etc/x\': Read-only file system', 'EROFS: read-only file system, open \'/home/u/x\'', 'cat: /home/u/.ssh/id_rsa: Permission denied', 'curl: (6) Could not resolve host: example.org']) { assert.equal(hitTheSandbox(output), true, output); }
  assert.equal(hitTheSandbox('1 failing\nAssertionError: expected 2 to equal 3'), false);
  assert.match(sandboxExplanation(policyFor({ network: false })), /write only inside the workspace, package caches and temporary folders; it cannot read credential folders such as ~\/\.ssh; and it has no network access\. If the failure above comes from that, do not try to get around it/);
  assert.doesNotMatch(sandboxExplanation(policyFor()), /no network access/);
});

const tool = sandboxToolFor(process.platform);
let works = false;
test('whether this machine can sandbox is found by trying', async () => { works = await sandboxWorks(); assert.equal(typeof works, 'boolean'); if (!tool) { assert.equal(works, false); } });

async function run(command, policy = policyFor(), signal = new AbortController().signal) {
  return runTerminalProcess({ command, cwd: workspace, timeoutMs: 20_000, signal, sandbox: (shell, cmd) => sandboxedCommand(tool, policy, shell, cmd) });
}
const sandboxed = (name, fn) => test(name, async (t) => { if (!works) { t.skip('no working sandbox on this machine'); return; } await fn(t); });

sandboxed('inside the sandbox: the workspace can be changed, the rest of the machine cannot', async () => {
  const result = await run(`echo changed > app.js && echo new > created.txt && cat ${outside}/data.txt && (echo hacked > ${outside}/data.txt; echo "write outside exit=$?"; echo x > ${outside}/planted.txt; echo "create outside exit=$?"; rm ${outside}/data.txt; echo "delete outside exit=$?")`);
  assert.match(result.output, /outside data/, 'reading elsewhere still works: tools, compilers and libraries live there');
  assert.match(result.output, /write outside exit=[1-9][\s\S]*create outside exit=[1-9][\s\S]*delete outside exit=[1-9]/);
  assert.equal(fs.readFileSync(path.join(workspace, 'app.js'), 'utf8'), 'changed\n');
  assert.equal(fs.readFileSync(path.join(workspace, 'created.txt'), 'utf8'), 'new\n');
  assert.equal(fs.readFileSync(path.join(outside, 'data.txt'), 'utf8'), 'outside data\n');
  assert.equal(fs.existsSync(path.join(outside, 'planted.txt')), false);
  assert.equal(hitTheSandbox(result.output), true);
});

sandboxed('credentials cannot be read, even by a command that tries several ways', async () => {
  const result = await run(`cat ${home}/.ssh/id_ed25519; ls -la ${home}/.ssh; cat ${home}/.netrc; cp ${home}/.ssh/id_ed25519 ./stolen.txt; tar cf ./stolen.tar ${home}/.ssh 2>/dev/null; echo done`);
  assert.doesNotMatch(result.output, /PRIVATE-KEY-MATERIAL|NETRC-SECRET/);
  assert.equal(fs.existsSync(path.join(workspace, 'stolen.txt')) && /PRIVATE/.test(fs.readFileSync(path.join(workspace, 'stolen.txt'), 'utf8')), false);
  if (fs.existsSync(path.join(workspace, 'stolen.tar'))) { assert.doesNotMatch(fs.readFileSync(path.join(workspace, 'stolen.tar'), 'latin1'), /PRIVATE-KEY-MATERIAL/); }
  // The files themselves are untouched
  assert.equal(fs.readFileSync(path.join(home, '.ssh', 'id_ed25519'), 'utf8'), 'PRIVATE-KEY-MATERIAL\n');
});

sandboxed('temporary files work, package caches are writable, and an extra folder is writable only when listed', async () => {
  const result = await run(`f=$(mktemp) && echo scratch > "$f" && cat "$f" && echo cached > ${home}/.npm/entry && echo "cache exit=$?"`);
  assert.match(result.output, /scratch\ncache exit=0/);
  assert.equal(fs.readFileSync(path.join(home, '.npm', 'entry'), 'utf8'), 'cached\n');
  assert.notEqual((await run(`echo x > ${outside}/allowed.txt`)).exitCode, 0);
  assert.equal((await run(`echo x > ${outside}/allowed.txt`, policyFor({ extraWritable: [outside] }))).exitCode, 0);
  assert.equal(fs.readFileSync(path.join(outside, 'allowed.txt'), 'utf8'), 'x\n');
});

sandboxed('a git worktree can commit: its history lives in the repository it belongs to', async () => {
  const repo = path.join(base, 'repo'); const tree = path.join(base, 'tree'); fs.mkdirSync(repo);
  const sh = (cwd, ...args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  sh(repo, 'init', '-q', '-b', 'main'); sh(repo, 'config', 'user.email', 't@e.com'); sh(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'first');
  sh(repo, 'worktree', 'add', '-q', '-b', 'codico/task-1', tree, 'HEAD');
  assert.equal(gitCommonDir(tree), path.join(repo, '.git'));
  assert.equal(gitCommonDir(repo), undefined, 'an ordinary checkout keeps its history inside itself');
  const policy = sandboxPolicy({ workspaceFolders: [tree], home, tmp: os.tmpdir() });
  const result = await runTerminalProcess({ command: 'echo b > b.txt && git add -A && git commit -q -m second && git log --oneline | wc -l', cwd: tree, timeoutMs: 20_000, signal: new AbortController().signal, sandbox: (shell, cmd) => sandboxedCommand(tool, policy, shell, cmd) });
  assert.match(result.output.trim(), /2$/, result.output);
  // The repository's own files are still out of reach
  assert.notEqual((await runTerminalProcess({ command: `echo x > ${repo}/a.txt`, cwd: tree, timeoutMs: 20_000, signal: new AbortController().signal, sandbox: (shell, cmd) => sandboxedCommand(tool, policy, shell, cmd) })).exitCode, 0);
});

sandboxed('Stop reaches everything the command started', async () => {
  const stop = new AbortController();
  const marker = path.join(workspace, 'alive.txt');
  const running = run('(while true; do date +%s%N > alive.txt; sleep 0.1; done) & echo started; wait', policyFor(), stop.signal);
  for (let i = 0; i < 100 && !fs.existsSync(marker); i++) { await new Promise(r => setTimeout(r, 50)); }
  stop.abort();
  const result = await running;
  assert.equal(result.stopped, true);
  await new Promise(r => setTimeout(r, 600));
  const first = fs.readFileSync(marker, 'utf8');
  await new Promise(r => setTimeout(r, 500));
  assert.equal(fs.readFileSync(marker, 'utf8'), first, 'the background loop is no longer writing');
});

test('without network the command has no interface to the outside (Linux)', async (t) => {
  if (!works || tool !== 'bubblewrap') { t.skip('needs bubblewrap'); return; }
  // The interfaces the command's own network has (its /proc is its own): only the loopback
  const interfaces = async (policy) => (await run("tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | sort | tr '\\n' ' '", policy)).output.trim();
  assert.equal(await interfaces(policyFor({ network: false })), 'lo');
  assert.notEqual(await interfaces(policyFor()), 'lo', 'with network allowed the machine\'s interfaces are there');
});

test('the setting decides: off runs commands as before, auto uses the sandbox where it works, required refuses where it does not', async () => {
  folders = [workspace];
  settings.commandSandbox = 'off';
  const off = await commandSandbox();
  assert.equal(off.wrap, undefined); assert.equal(off.refusal, undefined); assert.equal(off.explain('Read-only file system', 1), '');
  settings.commandSandbox = 'auto';
  const auto = await commandSandbox();
  assert.equal(typeof auto.wrap === 'function', works);
  assert.equal(auto.refusal, undefined);
  settings.commandSandbox = 'required';
  const required = await commandSandbox();
  if (works) {
    assert.equal(required.refusal, undefined);
    assert.match(required.explain('touch: Read-only file system', 1), /^\n\[Sandbox\] This command ran in Codico's sandbox/);
    assert.equal(required.explain('touch: Read-only file system', 0), '', 'a command that succeeded needs no explanation');
    assert.equal(required.explain('1 test failed', 1), '');
  } else {
    assert.match(required.refusal, /^Not run: commands must be sandboxed \(the codico\.commandSandbox setting is "required"\) and /);
    assert.equal(required.wrap, undefined);
  }
  settings.commandSandbox = 'off';
});
