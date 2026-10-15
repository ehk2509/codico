#!/usr/bin/env node
'use strict';
// codico: run one Codico task without the editor in front of you (a script, CI, a schedule).
// It starts VS Code with the extension, hands it the task, prints what the agent does,
// and exits with a code that says how it went.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const EXTENSION_ROOT = path.resolve(__dirname, '..');
const EXIT = { done: 0, failed: 1, needsInput: 2, denied: 3, usage: 64 };

const HELP = `Usage: codico run "<task>" [options]
       codico automate [options]
       codico package check [folder] [--json]
       codico registry verify <index.json> [<package id>…] [--json]

run       Runs one task with the Codico agent, in a VS Code started for it, and prints the result.
package   Checks a marketplace package before it is submitted: its codico-package.json, a security scan,
          and the content hash of what git will serve for the commit. Prints its registry entry.
registry  Verifies a registry's index (its CI runs this): each package's latest version is downloaded at
          its commit and its hash, manifest, publisher's account and scan are checked.
automate  Runs the repository's automations once (or with --watch, on and on): GitHub issues with
          the label and new CI failures on the default branch become jobs, finished jobs become
          draft pull requests, and CI failures or requested changes on those resume their job with
          its conversation. Its state is kept in --state-dir between runs (cache it in CI).
          The GitHub token is read from GITHUB_TOKEN (or GH_TOKEN).

With nobody to approve anything, what a task may do is decided by these options;
whatever they do not allow is declined.

Options
  --cwd <dir>           Folder to work in (default: the current folder)
  --model <id>          Model, as in the codico.model setting (e.g. direct:deepseek/deepseek-flash)
  --allow-edits         The task may create and change files in the folder
  --allow-commands      The task may run terminal commands (implies --allow-edits)
  --allow-web           The task may fetch pages and search the web
  --allow-hooks         Project hooks in .codico/hooks.json may run
  --max-steps <n>       Requests the task may make (default: the codico.maxIterations setting)
  --timeout <seconds>   Stop the run after this long (default: 1800)
  --json                Print one JSON object per line instead of text
  --vscode <path>       The VS Code program to use (default: $CODICO_VSCODE, then "code" on the PATH)
  --ollama-url <url>    Base address of an Ollama server, for ollama/ models
  -h, --help            Show this

Options of automate
  --state-dir <dir>     Where jobs, their conversations and worktrees are kept (default: ~/.codico/automate/<folder>)
  --label <name>        Issues with this label become jobs (default: codico)
  --no-issues           Do not take issues
  --no-ci               Do not react to CI failures on the default branch
  --no-pr-feedback      Do not follow the pull requests it opened
  --publish             Push and open draft pull requests, and push fixes to them, without asking
                        (without it, finished work waits and the run ends with code 2)
  --no-replies          Do not answer review comments in their threads
  --watch <seconds>     Keep running, reading GitHub every so many seconds
  --github-api <url>    GitHub's API, for GitHub Enterprise (default: https://api.github.com)

Keys are read from the environment: OPENROUTER_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY,
ANTHROPIC_API_KEY, GOOGLE_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, XAI_API_KEY, CEREBRAS_API_KEY.

Exit codes
  0  the task finished          2  the agent asked a question it needs answered (automate: a job needs a person)
  1  the run failed             3  finished, but something it wanted to do was not allowed

On Linux without a display, run it under xvfb-run.`;

/** The command line as a task, or a message about what is wrong with it. */
function parseArgs(argv) {
  const options = { cwd: process.cwd(), permissions: 'read', timeout: 1800, json: false,
    automate: { label: 'codico', ci: true, prFeedback: true, publish: false, replies: true } };
  const words = [];
  const value = (name, i) => { if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) { throw new Error(`${name} needs a value`); } return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h': case '--help': return { help: true };
      case '--cwd': options.cwd = path.resolve(value(arg, i++)); break;
      case '--model': options.model = value(arg, i++); break;
      case '--allow-edits': if (options.permissions === 'read') { options.permissions = 'edits'; } break;
      case '--allow-commands': options.permissions = 'all'; break;
      case '--allow-web': options.allowWeb = true; break;
      case '--allow-hooks': options.allowHooks = true; break;
      case '--json': options.json = true; break;
      case '--vscode': options.vscode = value(arg, i++); break;
      case '--ollama-url': options.ollamaUrl = value(arg, i++); break;
      case '--state-dir': options.automate.stateDir = path.resolve(value(arg, i++)); break;
      case '--label': options.automate.label = value(arg, i++); break;
      case '--no-issues': options.automate.label = ''; break;
      case '--no-ci': options.automate.ci = false; break;
      case '--no-pr-feedback': options.automate.prFeedback = false; break;
      case '--publish': options.automate.publish = true; break;
      case '--no-replies': options.automate.replies = false; break;
      case '--github-api': options.automate.githubApi = value(arg, i++); break;
      case '--watch': {
        const seconds = Number(value(arg, i++));
        if (!Number.isFinite(seconds) || seconds < 30) { throw new Error('--watch needs a number of seconds, 30 or more'); }
        options.automate.watchSeconds = seconds; break;
      }
      case '--max-steps': case '--timeout': {
        const number = Number(value(arg, i++));
        if (!Number.isFinite(number) || number <= 0) { throw new Error(`${arg} needs a positive number`); }
        options[arg === '--timeout' ? 'timeout' : 'maxSteps'] = number;
        break;
      }
      default:
        if (arg.startsWith('-')) { throw new Error(`Unknown option ${arg}`); }
        words.push(arg);
    }
  }
  if (words[0] === 'automate') {
    if (words.length > 1) { throw new Error('automate takes no task: it finds its work on GitHub.'); }
    options.mode = 'automate';
    options.automate.stateDir = options.automate.stateDir || path.join(os.homedir(), '.codico', 'automate', path.basename(options.cwd));
    if (!argv.includes('--timeout')) { options.timeout = options.automate.watchSeconds ? 365 * 24 * 3600 : 3600; }
    return options;
  }
  if (words[0] !== 'run') { throw new Error(words.length ? `Unknown command "${words[0]}". The commands are "run" and "automate".` : 'Nothing to do: give a command, "run" or "automate".'); }
  options.prompt = words.slice(1).join(' ').trim();
  if (!options.prompt) { throw new Error('Give the task after "run", in quotes.'); }
  return options;
}

/** `code` on the PATH is a launcher script; the run needs the program it launches, which stays attached and reports how it ended. */
function resolveVscode(given) {
  const fromPath = () => {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      for (const name of process.platform === 'win32' ? ['code.cmd', 'code.exe'] : ['code']) {
        const candidate = path.join(dir, name);
        if (dir && fs.existsSync(candidate)) { return candidate; }
      }
    }
    return undefined;
  };
  const start = given || process.env.CODICO_VSCODE || fromPath();
  if (!start) { return undefined; }
  let real = start;
  try { real = fs.realpathSync(start); } catch { return undefined; }
  const dir = path.dirname(real);
  if (path.basename(dir) !== 'bin') { return real; }
  const candidates = process.platform === 'darwin' ? [path.join(dir, '..', '..', '..', 'MacOS', 'Electron')]
    : process.platform === 'win32' ? [path.join(dir, '..', 'Code.exe')]
    : [path.join(dir, '..', 'code'), path.join(dir, '..', 'code-oss'), path.join(dir, '..', 'codium')];
  return candidates.find(candidate => fs.existsSync(candidate)) || real;
}

/** One event of the run as a line for a person. */
function render(event) {
  switch (event.type) {
    case 'text': return { stream: 'out', text: event.text };
    case 'step': return { stream: 'err', text: `\n  ▸ ${event.tool} ${event.label || ''}\n` };
    case 'result': return event.ok ? undefined : { stream: 'err', text: `  ✗ ${event.tool} ${event.label || ''}${event.error ? ': ' + event.error : ''}\n` };
    case 'denied': return { stream: 'err', text: `  ✗ not allowed: ${event.what} (${event.hint})\n` };
    case 'dialog': return event.answer ? undefined : { stream: 'err', text: `  · declined: ${String(event.message).split('\n')[0]}\n` };
    case 'error': return { stream: 'err', text: `\nerror: ${event.message}\n` };
    case 'job': return { stream: 'err', text: `◆ ${event.text}\n` };
    case 'end': return { stream: 'err', text: `\n${event.status}${event.message ? ': ' + event.message : ''} · ${event.requests} requests, ${Number(event.tokens).toLocaleString('en-US')} tokens${event.denied ? ` · ${event.denied} not allowed` : ''}\n` };
    default: return undefined;
  }
}

/** `codico package check` and `codico registry verify`: no editor needed. */
async function packageTools(argv) {
  const json = argv.includes('--json');
  const words = argv.filter(a => a !== '--json');
  let tools;
  try { tools = require(path.join(EXTENSION_ROOT, 'dist', 'package-tools.js')); } catch { process.stderr.write('codico: the package tools are missing (dist/package-tools.js); run "npm run compile".\n'); return EXIT.failed; }
  const mark = { danger: '⛔', warning: '⚠', info: '·' };
  if (words[0] === 'package' && words[1] === 'check') {
    const dir = path.resolve(words[2] || '.');
    const result = tools.checkPackage(dir);
    if (json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); }
    else {
      for (const p of result.problems) { process.stderr.write(`✗ ${p}\n`); }
      for (const w of result.warnings) { process.stderr.write(`⚠ ${w}\n`); }
      if (result.scan) {
        process.stderr.write(`\nScan: ${{ high: 'HIGH RISK', medium: 'things to check', low: 'nothing found' }[result.scan.risk]}\n`);
        for (const f of result.scan.findings) { process.stderr.write(`  ${mark[f.severity]} ${f.file}${f.line ? ':' + f.line : ''} — ${f.text}\n`); }
      }
      if (result.entry) { process.stderr.write('\nRegistry entry (add it to index.json in a pull request to the registry):\n'); process.stdout.write(JSON.stringify(result.entry, null, 2) + '\n'); }
    }
    return result.problems.length ? EXIT.failed : result.scan && result.scan.risk === 'high' ? EXIT.denied : 0;
  }
  if (words[0] === 'registry' && words[1] === 'verify' && words[2]) {
    const download = (url) => new Promise((resolve, reject) => {
      const get = (u, hops) => require(u.startsWith('https:') ? 'node:https' : 'node:http').get(u, { headers: { 'User-Agent': 'Codico' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) { res.resume(); get(new URL(res.headers.location, u).toString(), hops - 1); return; }
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
      get(url, 4);
    });
    const archive = process.env.CODICO_ARCHIVE_URL ? (repo, commit) => `${process.env.CODICO_ARCHIVE_URL}/${repo}/${commit}.tar.gz` : undefined;
    const { results, problems } = await tools.verifyRegistry(fs.readFileSync(words[2], 'utf8'), download, words.slice(3), archive);
    if (json) { process.stdout.write(JSON.stringify({ results, problems }, null, 2) + '\n'); }
    else {
      for (const p of problems) { process.stderr.write(`✗ ${p}\n`); }
      for (const r of results) {
        process.stderr.write(`${r.ok ? '✓' : '✗'} ${r.id} ${r.version}${r.risk ? ` (scan: ${r.risk})` : ''}\n`);
        for (const p of r.problems) { process.stderr.write(`    ✗ ${p}\n`); }
        for (const f of (r.findings || []).filter(f => f.severity !== 'info')) { process.stderr.write(`    ${mark[f.severity]} ${f.file}${f.line ? ':' + f.line : ''} — ${f.text}\n`); }
      }
    }
    return problems.length || results.some(r => !r.ok) ? EXIT.failed : results.some(r => r.risk === 'high') ? EXIT.denied : 0;
  }
  process.stderr.write(`codico: ${HELP.split('\n').slice(0, 5).join('\n')}\n`);
  return EXIT.usage;
}

async function main(argv) {
  if (argv[0] === 'package' || argv[0] === 'registry') { return packageTools(argv); }
  let options;
  try { options = parseArgs(argv); } catch (error) { process.stderr.write(`codico: ${error.message}\n\n${HELP}\n`); return EXIT.usage; }
  if (options.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (!fs.existsSync(options.cwd) || !fs.statSync(options.cwd).isDirectory()) { process.stderr.write(`codico: ${options.cwd} is not a folder\n`); return EXIT.usage; }
  const vscode = resolveVscode(options.vscode);
  if (!vscode) { process.stderr.write('codico: VS Code was not found. Install it, or point to it with --vscode or CODICO_VSCODE.\n'); return EXIT.failed; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-run-'));
  const out = path.join(work, 'events.jsonl'); const taskFile = path.join(work, 'task.json');
  fs.writeFileSync(taskFile, JSON.stringify({ mode: options.mode || 'run', prompt: options.prompt || '', out, model: options.model, permissions: options.permissions, allowWeb: !!options.allowWeb, allowHooks: !!options.allowHooks, maxSteps: options.maxSteps, ollamaUrl: options.ollamaUrl,
    ...(options.mode === 'automate' ? { automate: options.automate } : {}) }), { mode: 0o600 });
  const env = { ...process.env, CODICO_HEADLESS: '1', CODICO_HEADLESS_TASK: taskFile };
  delete env.ELECTRON_RUN_AS_NODE;

  /** One start of the editor for the task; resolves when it has exited. */
  const launch = async (extraArgs) => {
    fs.writeFileSync(out, '');
    const args = [options.cwd, `--extensionDevelopmentPath=${EXTENSION_ROOT}`, `--extensionTestsPath=${path.join(__dirname, 'headless-runner.js')}`,
      '--user-data-dir', path.join(work, 'user-data'), '--extensions-dir', path.join(work, 'extensions'),
      '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-gpu',
      ...extraArgs, ...(process.env.CODICO_VSCODE_ARGS ? process.env.CODICO_VSCODE_ARGS.split(' ').filter(Boolean) : [])];
    const child = cp.spawn(vscode, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrTail = '';
    child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-4000); });

    // The extension appends one JSON object per line; read what is new
    let read = 0; let rest = ''; let end; let events = 0;
    const drain = () => {
      let text = '';
      try { const all = fs.readFileSync(out); text = all.subarray(read).toString('utf8'); read = all.length; } catch { return; }
      const lines = (rest + text).split('\n'); rest = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) { continue; }
        let event; try { event = JSON.parse(line); } catch { continue; }
        events++;
        if (event.type === 'end') { end = event; }
        if (options.json) { process.stdout.write(line + '\n'); continue; }
        const shown = render(event);
        if (shown) { (shown.stream === 'out' ? process.stdout : process.stderr).write(shown.text); }
      }
    };
    const poll = setInterval(drain, 150);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000); }, options.timeout * 1000);
    // Once the task has ended the editor is no longer needed: give it a moment to close, then close it
    const closer = setInterval(() => { if (end) { clearInterval(closer); setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, 4000); } }, 200);
    const stop = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const exited = await new Promise(resolve => { child.on('exit', code => resolve(code)); child.on('error', error => { stderrTail += String(error.message); resolve(-1); }); });
    clearInterval(poll); clearInterval(closer); clearTimeout(timer);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    drain();
    return { end, events, exited, stderrTail, timedOut };
  };

  let run = await launch([]);
  // A VS Code unpacked from an archive (CI caches, portable installs) cannot use Chromium's own process sandbox, and
  // stops before it starts. That sandbox isolates the editor's windows from each other, not the agent's commands.
  if (!run.end && run.events === 0 && process.platform === 'linux' && /setuid_sandbox_host|SUID sandbox helper|chrome-sandbox/.test(run.stderrTail)) {
    process.stderr.write('codico: this VS Code cannot start with Chromium\'s process sandbox (its chrome-sandbox helper is not set up); starting it with --no-sandbox.\n');
    run = await launch(['--no-sandbox']);
  }
  const { end, exited, stderrTail, timedOut } = run;
  if (!options.json && end) { process.stdout.write('\n'); }
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* left for the system to clean */ }

  if (end) { return { done: EXIT.done, failed: EXIT.failed, 'needs-input': EXIT.needsInput, denied: EXIT.denied }[end.status] ?? EXIT.failed; }
  if (timedOut) { process.stderr.write(`codico: stopped after ${options.timeout} seconds without finishing\n`); return EXIT.failed; }
  const noDisplay = /cannot open display|Missing X server|no DISPLAY|ozone_platform|platform failed to initialize/i.test(stderrTail);
  process.stderr.write(`codico: VS Code ended (code ${exited}) before the task did.${noDisplay ? ' There is no display: on Linux, run under xvfb-run.' : ''}\n${stderrTail ? stderrTail.trim().split('\n').slice(-6).join('\n') + '\n' : ''}`);
  return EXIT.failed;
}

module.exports = { parseArgs, resolveVscode, render, EXIT, HELP };
if (require.main === module) { main(process.argv.slice(2)).then(code => process.exit(code), error => { process.stderr.write(`codico: ${error && error.stack || error}\n`); process.exit(EXIT.failed); }); }
