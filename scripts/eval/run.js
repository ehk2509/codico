const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { missingVerifierOutModules } = require('./verifierPreflight');

const root = path.resolve(__dirname, '../..');

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function has(name) { return process.argv.includes(name); }

const suiteArg = arg('--suite', 'eval/tasks.json');
const suitePath = path.isAbsolute(suiteArg) ? suiteArg : path.join(root, suiteArg);
const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8'));

function safeName(value) { return String(value).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80); }
function npmCommand() { return process.platform === 'win32' ? 'npm.cmd' : 'npm'; }
function run(command, args, options = {}) {
  const result = cp.spawnSync(command, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error) : '',
  };
}
function tail(text, max = 12000) {
  const s = String(text || '');
  return s.length <= max ? s : s.slice(-max);
}
function median(values) {
  if (!values.length) { return 0; }
  const xs = [...values].sort((a,b) => a-b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function loadVerifier(task) {
  if (task.verifierPath) {
    return {
      source: fs.readFileSync(path.join(root, task.verifierPath), 'utf8'),
      label: task.verifierPath,
    };
  }

  if (!task.verifierCommit) {
    throw new Error(`Task ${task.id} is missing verifierCommit`);
  }

  const historical = run('git', ['show', `${task.verifierCommit}:tests/${task.verifierFile}`]);
  if (historical.status !== 0) {
    throw new Error(`Cannot load historical verifier for ${task.id}: ${historical.stderr}`);
  }

  return {
    source: historical.stdout,
    label: `${task.verifierCommit}:tests/${task.verifierFile}`,
  };
}

function cleanupEvaluationProcesses(instanceDir) {
  if (!instanceDir || process.platform === 'win32') { return; }

  // Every Electron child carries --user-data-dir under this unique directory.
  // Match only that directory; never kill arbitrary VS Code processes.
  run('pkill', ['-TERM', '-f', instanceDir]);
  run('pkill', ['-KILL', '-f', instanceDir]);
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is required. The benchmark never writes this key to results.');
  }

  const model = arg('--model', 'deepseek/deepseek-v4-flash');
  const filterRaw = arg('--filter', '.*');
  const repetitions = Math.max(1, Number(arg('--repetitions', '1')));
  const limit = Math.max(0, Number(arg('--limit', '0')));
  const timeoutMinutes = Math.max(1, Number(arg('--timeout-minutes', String(suite.maxTaskMinutes || 10))));
  const maxTotalTokens = Math.max(1, Number(arg('--max-total-tokens', String(suite.maxTotalTokens || 400000))));
  const filter = new RegExp(filterRaw, 'i');

  let tasks = suite.tasks.filter(task =>
    filter.test(task.id) || filter.test(task.category)
  );
  if (limit > 0) { tasks = tasks.slice(0, limit); }
  if (!tasks.length) { throw new Error(`No tasks match --filter ${filterRaw}`); }

  // Build the current Codico extension before VS Code loads it from
  // extensionDevelopmentPath. Historical task worktrees are compiled separately
  // by their verifier via npm test after the agent finishes.
  const compile = run(npmCommand(), ['run', 'compile'], { inherit: true, timeout: 5 * 60_000 });
  if (compile.status !== 0) { throw new Error('Failed to compile the Codico evaluation extension.'); }

  // The benchmark driver uses the same VS Code test harness as CI, but it is
  // intentionally not a permanent production dependency.
  const harness = run(npmCommand(), ['install', '--no-save', '@vscode/test-electron@2.5.2'], { inherit: true });
  if (harness.status !== 0) { throw new Error('Failed to install @vscode/test-electron benchmark harness.'); }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultDir = path.join(root, 'eval', 'results', `${stamp}-${safeName(model)}`);
  fs.mkdirSync(resultDir, { recursive: true });

  const results = [];
  for (const task of tasks) {
    for (let rep = 1; rep <= repetitions; rep++) {
      const runId = repetitions > 1 ? `${task.id}-r${rep}` : task.id;
      const worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-eval-'));
      const workspace = path.join(worktreeParent, 'workspace');
      const rawAgentOutput = path.join(resultDir, `${safeName(runId)}-agent.json`);

      console.log(`\n=== [${results.length + 1}/${tasks.length * repetitions}] ${runId} ===`);
      console.log(`base: ${task.baseCommit.slice(0, 12)}  category: ${task.category}`);

      let record = {
        suiteVersion: suite.suiteVersion,
        taskId: task.id,
        repetition: rep,
        category: task.category,
        baseCommit: task.baseCommit,
        model,
        success: false,
        setupOk: false,
        agentOk: false,
        verifierOk: false,
        metrics: null,
        maxTotalTokens,
        maxIterations: task.maxIterations || 16,
        changedFiles: [],
        diffStat: '',
        verifier: {},
        invalidVerifier: false,
      };

      let instanceDir = '';
      let verifierSource = '';

      try {
        const add = run('git', ['worktree', 'add', '--detach', workspace, task.baseCommit]);
        if (add.status !== 0) {
          throw new Error(`git worktree add failed. Ensure full history is present (git fetch --unshallow or fetch-depth: 0).\n${add.stderr}`);
        }

        const install = run(npmCommand(), ['ci'], { cwd: workspace, timeout: 5 * 60_000 });
        if (install.status !== 0) {
          throw new Error(`npm ci failed in task workspace:\n${tail(install.stderr)}`);
        }
        const loadedVerifier = loadVerifier(task);
        verifierSource = loadedVerifier.source;
        record.verifierSource = loadedVerifier.label;

        const missingModules = missingVerifierOutModules(verifierSource, workspace);
        if (missingModules.length > 0) {
          record.invalidVerifier = true;
          record.verifier = {
            status: null,
            stderr: `Verifier incompatible with historical base; missing modules: ${missingModules.join(', ')}`,
          };
          throw new Error(record.verifier.stderr);
        }

        record.setupOk = true;
        instanceDir = path.join(worktreeParent, 'vscode-instance');
        fs.mkdirSync(instanceDir, { recursive: true });

        const env = {
          ...process.env,
          CODICO_EVAL_MODE: '1',
          CODICO_EVAL_API_KEY: apiKey,
          CODICO_EVAL_MODEL: model,
          CODICO_EVAL_PROMPT: task.prompt,
          CODICO_EVAL_MAX_ITERATIONS: String(task.maxIterations || 16),
          CODICO_EVAL_MAX_TOTAL_TOKENS: String(maxTotalTokens),
          CODICO_EVAL_OUTPUT: rawAgentOutput,
          CODICO_EVAL_INSTANCE_DIR: instanceDir,
        };
        const agent = run(
          process.execPath,
          [path.join(root, 'eval/vscode/runTask.js'), workspace],
          { env, timeout: timeoutMinutes * 60_000, inherit: true }
        );
        record.agentOk = agent.status === 0;
        record.agentTimedOut = /ETIMEDOUT/i.test(agent.error);
        cleanupEvaluationProcesses(instanceDir);

        if (fs.existsSync(rawAgentOutput)) {
          const agentJson = JSON.parse(fs.readFileSync(rawAgentOutput, 'utf8'));
          record.metrics = agentJson.metrics || null;
          if (!agentJson.ok) { record.agentError = agentJson.error || 'evaluation host reported failure'; }
        } else {
          record.agentError = `evaluation host exited with status ${agent.status} without writing metrics`;
        }

        // Capture the agent's edits BEFORE injecting the hidden verifier.
        const status = run('git', ['status', '--porcelain'], { cwd: workspace });
        record.changedFiles = status.stdout.split(/\r?\n/).filter(Boolean).map(line => line.slice(3));
        const diffStat = run('git', ['diff', '--stat'], { cwd: workspace });
        record.diffStat = diffStat.stdout.trim();
        const patch = run('git', ['diff', '--no-ext-diff'], { cwd: workspace });
        const patchLimit = 200_000;
        const patchText = patch.stdout.length > patchLimit
          ? patch.stdout.slice(0, patchLimit) + '\n... (patch truncated by benchmark)\n'
          : patch.stdout;
        const patchName = `${safeName(runId)}.patch`;
        fs.writeFileSync(path.join(resultDir, patchName), patchText);
        record.patchFile = patchName;
        record.patchTruncated = patch.stdout.length > patchLimit;

        const verifierName = `__codico_eval_${safeName(task.id)}.test.js`;
        const verifierDest = path.join(workspace, 'tests', verifierName);
        fs.mkdirSync(path.dirname(verifierDest), { recursive: true });

        // Inject only after the agent stops. The same verifier was preflighted
        // before model invocation without ever entering the task workspace.
        fs.writeFileSync(verifierDest, verifierSource);

        // The hidden verifier executes only after the agent has stopped.
        const verify = run(
          npmCommand(),
          ['test', '--', `--test-name-pattern=${task.testNamePattern}`, `tests/${verifierName}`],
          { cwd: workspace, timeout: 5 * 60_000 }
        );
        record.verifierOk = verify.status === 0;
        record.verifier = {
          status: verify.status,
          stdout: tail(verify.stdout),
          stderr: tail(verify.stderr),
        };
        record.success = record.setupOk && record.agentOk && record.verifierOk;

        try { fs.unlinkSync(verifierDest); } catch {}
      } catch (error) {
        record.error = error instanceof Error ? error.stack || error.message : String(error);
      } finally {
        cleanupEvaluationProcesses(instanceDir);
        const file = path.join(resultDir, `${safeName(runId)}.json`);
        fs.writeFileSync(file, JSON.stringify(record, null, 2));
        results.push(record);

        run('git', ['worktree', 'remove', '--force', workspace]);
        fs.rmSync(worktreeParent, { recursive: true, force: true });
      }

      console.log(record.success ? 'PASS' : 'FAIL',
        record.metrics ? `steps=${record.metrics.steps} tools=${record.metrics.toolCalls} tokens=${record.metrics.totalTokens}` : '');
    }
  }

  const invalid = results.filter(r => r.invalidVerifier);
  const valid = results.filter(r => !r.invalidVerifier);
  const passed = valid.filter(r => r.success);
  const summary = {
    suiteVersion: suite.suiteVersion,
    frozen: suite.frozen,
    model,
    taskCount: results.length,
    validTaskCount: valid.length,
    invalid: invalid.length,
    passed: passed.length,
    failed: valid.length - passed.length,
    successRate: valid.length ? passed.length / valid.length : 0,
    medianTokensSuccessful: median(passed.map(r => r.metrics?.totalTokens || 0).filter(Boolean)),
    medianStepsSuccessful: median(passed.map(r => r.metrics?.steps || 0).filter(Boolean)),
    medianToolCallsSuccessful: median(passed.map(r => r.metrics?.toolCalls || 0).filter(Boolean)),
    maxTotalTokens,
    timeoutMinutes,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(resultDir, 'summary.json'), JSON.stringify(summary, null, 2));
  const rows = results.map(r =>
    `| ${r.taskId}${repetitions > 1 ? ` r${r.repetition}` : ''} | ${r.category} | ${r.invalidVerifier ? 'INVALID' : (r.success ? 'PASS' : 'FAIL')} | ${r.metrics?.steps ?? '-'} | ${r.metrics?.toolCalls ?? '-'} | ${r.metrics?.totalTokens ?? '-'} | ${r.metrics?.projectedCharsOmitted ?? '-'} | ${r.changedFiles.length} |`
  );
  const markdown = [
    `# Codico coding holdout — ${suite.suiteVersion}`,
    '',
    `Model: **${model}**`,
    `Success: **${passed.length}/${valid.length} valid tasks (${(summary.successRate * 100).toFixed(1)}%)**`,
    `Invalid verifier tasks skipped before model invocation: **${invalid.length}**`,
    `Median successful tokens: **${summary.medianTokensSuccessful || 'n/a'}**`,
    '',
    '| Task | Category | Result | Steps | Tool calls | Tokens | Context chars omitted | Files changed |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
    ...rows,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(resultDir, 'summary.md'), markdown);
  console.log('\n' + markdown);
  console.log(`Results: ${resultDir}`);

  if (invalid.length > 0 || passed.length !== valid.length) { process.exitCode = 1; }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
