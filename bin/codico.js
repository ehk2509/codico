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

Runs one task with the Codico agent, in a VS Code started for it, and prints the result.
With nobody to approve anything, what the task may do is decided by these options;
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

Keys are read from the environment: OPENROUTER_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY,
ANTHROPIC_API_KEY, GOOGLE_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, XAI_API_KEY, CEREBRAS_API_KEY.

Exit codes
  0  the task finished          2  the agent asked a question it needs answered
  1  the run failed             3  finished, but something it wanted to do was not allowed

On Linux without a display, run it under xvfb-run.`;

/** The command line as a task, or a message about what is wrong with it. */
function parseArgs(argv) {
  const options = { cwd: process.cwd(), permissions: 'read', timeout: 1800, json: false };
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
  if (words[0] !== 'run') { throw new Error(words.length ? `Unknown command "${words[0]}". The command is "run".` : 'Nothing to do: give a command, "run".'); }
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
    case 'end': return { stream: 'err', text: `\n${event.status}${event.message ? ': ' + event.message : ''} · ${event.requests} requests, ${Number(event.tokens).toLocaleString('en-US')} tokens${event.denied ? ` · ${event.denied} not allowed` : ''}\n` };
    default: return undefined;
  }
}

async function main(argv) {
  let options;
  try { options = parseArgs(argv); } catch (error) { process.stderr.write(`codico: ${error.message}\n\n${HELP}\n`); return EXIT.usage; }
  if (options.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (!fs.existsSync(options.cwd) || !fs.statSync(options.cwd).isDirectory()) { process.stderr.write(`codico: ${options.cwd} is not a folder\n`); return EXIT.usage; }
  const vscode = resolveVscode(options.vscode);
  if (!vscode) { process.stderr.write('codico: VS Code was not found. Install it, or point to it with --vscode or CODICO_VSCODE.\n'); return EXIT.failed; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-run-'));
  const out = path.join(work, 'events.jsonl'); const taskFile = path.join(work, 'task.json');
  fs.writeFileSync(taskFile, JSON.stringify({ prompt: options.prompt, out, model: options.model, permissions: options.permissions, allowWeb: !!options.allowWeb, allowHooks: !!options.allowHooks, maxSteps: options.maxSteps, ollamaUrl: options.ollamaUrl }), { mode: 0o600 });
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
