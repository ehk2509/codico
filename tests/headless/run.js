// End-to-end test of the `codico` command: real VS Code, the built extension, a fake model.
//   npm run test:headless     (needs the VS Code that test:live downloads; on Linux without a display: xvfb-run)
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const root = path.resolve(__dirname, '../..');

function findVscode() {
  if (process.env.CODICO_VSCODE) { return process.env.CODICO_VSCODE; }
  const cache = path.join(root, '.vscode-test');
  for (const dir of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    for (const candidate of [path.join(cache, dir, 'code'), path.join(cache, dir, 'Code.exe'), path.join(cache, dir, 'Visual Studio Code.app', 'Contents', 'MacOS', 'Electron')]) {
      if (fs.existsSync(candidate)) { return candidate; }
    }
  }
  return undefined;
}

function codico(args, env) {
  return new Promise(resolve => {
    const child = cp.spawn(process.execPath, [path.join(root, 'bin/codico.js'), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}

(async () => {
  const vscode = findVscode();
  if (!vscode) { console.error('No VS Code to test with: run "npm run test:live" once (it downloads one), or set CODICO_VSCODE.'); process.exit(1); }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-headless-'));
  process.env.LIVE_WORK_DIR = work;
  const { start } = require('../vscode-live/fakeServer.js');
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const workspace = () => { const ws = fs.mkdtempSync(path.join(work, 'ws-')); fs.mkdirSync(path.join(ws, 'live')); fs.mkdirSync(path.join(ws, 'fixtures')); fs.writeFileSync(path.join(ws, 'fixtures/config.txt'), 'host=localhost\nport=80\n'); return ws; };
  const base = (ws) => ['--cwd', ws, '--model', 'ollama/fake-model', '--ollama-url', url, '--timeout', '120'];
  const env = { CODICO_VSCODE: vscode };
  const results = [];
  const check = (name, ok, why) => { results.push({ name, ok, why }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(22)} | ${why}`); };

  // 1. A task that writes a file, with edits allowed: done, the file is there, the reply is printed
  let ws = workspace();
  let run = await codico(['run', '[SCENARIO:readme] please do the task', '--allow-edits', ...base(ws)], env);
  let file = fs.existsSync(path.join(ws, 'live/README.md')) ? fs.readFileSync(path.join(ws, 'live/README.md'), 'utf8') : null;
  check('edit allowed', run.code === 0 && file !== null && /# Demo/.test(file) && /Writing the README\./.test(run.stdout) && /\ndone · \d+ requests, [\d,]+ tokens\n$/.test(run.stderr),
    `exit ${run.code}; file written: ${file !== null}; reply on stdout: ${/Writing the README\./.test(run.stdout)}; summary: ${(run.stderr.trim().split('\n').pop() || '').slice(0, 80)}`);

  // 2. The same task with nothing allowed: the edit is declined, nothing is written, and the exit code says so
  ws = workspace();
  run = await codico(['run', '[SCENARIO:readme] please do the task', ...base(ws)], env);
  check('edit not allowed', run.code === 3 && !fs.existsSync(path.join(ws, 'live/README.md')) && /not allowed: edit live\/README\.md \(run with --allow-edits\)/.test(run.stderr),
    `exit ${run.code}; file written: ${fs.existsSync(path.join(ws, 'live/README.md'))}; told why: ${/run with --allow-edits/.test(run.stderr)}`);

  // 3. A command needs --allow-commands; with only edits allowed it is declined
  ws = workspace();
  run = await codico(['run', '[SCENARIO:bigoutput] please do the task', '--allow-edits', ...base(ws)], env);
  check('command not allowed', run.code === 3 && /not allowed: command seq 1 200000 \(run with --allow-commands\)/.test(run.stderr), `exit ${run.code}; told why: ${/run with --allow-commands/.test(run.stderr)}`);
  run = await codico(['run', '[SCENARIO:bigoutput] please do the task', '--allow-commands', '--json', ...base(ws)], env);
  const events = run.stdout.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } });
  const end = events.filter(Boolean).find(e => e.type === 'end') || {};
  check('command allowed, json', run.code === 0 && events.every(Boolean) && end.status === 'done' && events.some(e => e.type === 'step' && e.tool === 'run_terminal'),
    `exit ${run.code}; every line is JSON: ${events.every(Boolean)}; end: ${JSON.stringify(end)}`);

  // 4. A question from the agent is not an answer: exit 2
  ws = workspace();
  run = await codico(['run', '[SCENARIO:clarify] please do the task', ...base(ws)], env);
  check('question', run.code === 2 && /needs-input/.test(run.stderr), `exit ${run.code}`);

  // 5. Fetching a page is declined unless --allow-web (here the page is local and refused anyway, but the dialog must not hold the run up)
  ws = workspace();
  const started = Date.now();
  run = await codico(['run', '[SCENARIO:fetch_local] please do the task', ...base(ws)], env);
  check('no dialog can hang', run.code !== null && Date.now() - started < 90000, `exit ${run.code} after ${Math.round((Date.now() - started) / 1000)} s`);

  // 6. Mistakes on the command line are said before anything is started
  run = await codico(['run'], env);
  const bad = await codico(['run', 'x', '--cwd', path.join(work, 'nowhere')], env);
  check('usage errors', run.code === 64 && /Give the task after "run"/.test(run.stderr) && bad.code === 64, `exit ${run.code} and ${bad.code}`);

  server.close();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} headless checks passed`);
  if (!failed) { fs.rmSync(work, { recursive: true, force: true }); } else { console.log('work dir: ' + work); }
  process.exit(failed ? 1 : 0);
})();
