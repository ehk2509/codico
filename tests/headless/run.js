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
  const fetchLog = () => new Promise((resolve, reject) => require('node:http').get(`${url}/log`, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => resolve(JSON.parse(b))); }).on('error', reject));
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

  // 7. codico automate, as a CI workflow runs it: three runs sharing a state folder, the job's worktree gone between runs
  {
    const http = require('node:http');
    const ghState = (set) => new Promise((resolve, reject) => { const req = http.request(`${url}/gh-state`, { method: set ? 'POST' : 'GET', headers: { 'content-type': 'application/json' } }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => resolve(JSON.parse(b))); }); req.on('error', reject); req.end(set ? JSON.stringify(set) : undefined); });
    const git = (cwd, ...args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    ws = workspace(); const bare = path.join(work, 'origin-auto.git'); const state = path.join(work, 'automate-state');
    git(work, 'init', '-q', '--bare', '-b', 'main', bare);
    git(ws, 'init', '-q', '-b', 'main'); git(ws, 'config', 'user.email', 't@example.com'); git(ws, 'config', 'user.name', 'T'); git(ws, 'config', 'core.autocrlf', 'false');
    git(ws, 'remote', 'add', 'origin', 'https://github.com/acme/app.git'); git(ws, 'config', `url.${bare}.insteadOf`, 'https://github.com/acme/app.git');
    git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'start'); git(ws, 'push', '-q', 'origin', 'main');
    await ghState({ issues: [{ number: 7, state: 'open', title: 'Write the auto file', body: 'Please write live/auto.txt. [SCENARIO:auto_issue]', user: { login: 'ann' } }], created: [], pulls: {}, checks: {}, logs: {}, tokens: [] });
    const automate = (...extra) => codico(['automate', '--state-dir', state, '--no-ci', '--publish', '--allow-edits', '--github-api', url, ...base(ws), ...extra], { ...env, GITHUB_TOKEN: 'test-gh-token' });
    const onOrigin = (branch) => { try { return git(bare, 'show', `${branch}:live/auto.txt`).trim(); } catch { return null; } };
    const before = (await fetchLog()).length;

    run = await automate();
    let gh = await ghState(); const pr = gh.created[0] || {};
    check('automate: issue to PR', run.code === 0 && pr.draft === true && /^Resolves #7\./.test(pr.body || '') && onOrigin(pr.head) === 'AUTO-V1' && /opened draft pull request #100/.test(run.stderr),
      `exit ${run.code}; draft PR resolving #7: ${pr.draft === true && /^Resolves #7/.test(pr.body || '')}; pushed: ${onOrigin(pr.head)}; ${run.stderr.trim().split('\n').filter(l => l.startsWith('◆')).join(' / ').slice(0, 200)}`);

    // The next run is on a fresh checkout: the job's worktree is gone; CI failed on the pull request meanwhile
    const tasks = fs.readdirSync(path.join(state, 'tasks')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(state, 'tasks', f), 'utf8')));
    fs.rmSync(tasks[0].worktree, { recursive: true, force: true });
    await ghState({ pulls: { 100: { state: 'open', merged: false, head: { sha: 'c0ffee1' } } }, checks: { c0ffee1: [{ name: 'test', status: 'completed', conclusion: 'failure', details_url: 'https://github.com/acme/app/actions/runs/1/job/901' }] },
      logs: { 901: 'npm test\n##[error]expected AUTO-V2 in live/auto.txt [SCENARIO:auto_fix]\nProcess completed with exit code 1.' } });
    run = await automate();
    const fixReq = (await fetchLog()).slice(before).find(e => e.scenario === 'auto_fix') || {};
    check('automate: resumed, fixed', run.code === 0 && fixReq.hasEarlierReply === true && onOrigin(pr.head) === 'AUTO-V2' && (await ghState()).created.length === 1 && fs.existsSync(tasks[0].worktree),
      `exit ${run.code}; resumed with its saved conversation: ${fixReq.hasEarlierReply === true}; worktree made again: ${fs.existsSync(tasks[0].worktree)}; fix pushed to the same PR: ${onOrigin(pr.head)}`);

    await ghState({ pulls: { 100: { state: 'closed', merged: true, head: { sha: 'c0ffee2' } } } });
    run = await automate();
    const saved = JSON.parse(fs.readFileSync(path.join(state, 'automations.json'), 'utf8'));
    gh = await ghState();
    check('automate: merged, done', run.code === 0 && saved.jobs[0].state === 'done' && gh.tokens.length > 0 && gh.tokens.every(t => t === 'Bearer test-gh-token'),
      `exit ${run.code}; job ${saved.jobs[0].state} (${saved.jobs[0].note}); token from GITHUB_TOKEN only: ${gh.tokens.every(t => t === 'Bearer test-gh-token')}`);
  }

  server.close();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} headless checks passed`);
  if (!failed) { fs.rmSync(work, { recursive: true, force: true }); } else { console.log('work dir: ' + work); }
  process.exit(failed ? 1 : 0);
})();
