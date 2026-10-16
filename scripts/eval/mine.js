/**
 * Finds holdout task candidates in this repository's history, and proves each one valid:
 *
 *   node scripts/eval/mine.js [--out candidates.json] [--jobs 4] [--commits <file of hashes>]
 *
 * A candidate is a commit that changed source files and a unit test file. The tests it added
 * are run at its parent (with only the new test file in place): those that fail there are the
 * task's verifier. Then the commit's source changes are applied (the oracle) and the same tests
 * must pass, twice. A task gets in only if both hold — its verifier fails without the fix and
 * passes with it — so it can be solved, and is not solved already.
 */
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseTap } = require('./quality');
const { applyOracle } = require('./agents');
const { referencedOutModules } = require('./verifierPreflight');

const root = path.resolve(__dirname, '../..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const git = (args, cwd = root) => cp.spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Names of the top-level tests a file declares with a plain string: test('…', …). */
function testNames(source) {
  const names = [];
  const pattern = /^test\(\s*(['"])((?:\\.|(?!\1).)*)\1/gm;
  let match;
  while ((match = pattern.exec(source)) !== null) { names.push(match[2].replace(/\\(.)/g, '$1')); }
  return names;
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A --test-name-pattern matching exactly these tests. */
const namePattern = names => `^(?:${names.map(escapeRegExp).join('|')})$`;

/** The commits that changed src/**.ts and tests/*.test.js, newest first. */
function candidateCommits() {
  const list = git(['log', '--no-merges', '--format=%H', 'origin/main']).stdout.split('\n').filter(Boolean);
  return list.filter(commit => {
    const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit]).stdout.split('\n');
    return files.some(f => /^src\/.*\.ts$/.test(f)) && files.some(f => /^tests\/[^/]+\.test\.js$/.test(f));
  });
}

/** What a candidate is, from git alone: its test files and the tests each one adds. */
function describe(commit) {
  const base = git(['rev-parse', `${commit}^`]).stdout.trim();
  const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit]).stdout.split('\n').filter(Boolean);
  const tests = files.filter(f => /^tests\/[^/]+\.test\.js$/.test(f)).map(file => {
    const after = git(['show', `${commit}:${file}`]);
    if (after.status !== 0) { return null; }
    const before = git(['show', `${base}:${file}`]);
    const known = new Set(before.status === 0 ? testNames(before.stdout) : []);
    // The modules it loads must exist before the fix: a task cannot ask for a module by a name it never gives
    const missing = referencedOutModules(after.stdout).filter(m => git(['cat-file', '-e', `${base}:src/${m.replace(/\.js$/, '.ts')}`]).status !== 0);
    return { file, added: testNames(after.stdout).filter(name => !known.has(name)), missing };
  }).filter(Boolean);
  const stat = git(['diff', '--numstat', base, commit, '--', 'src']).stdout.split('\n').filter(Boolean)
    .reduce((n, line) => n + (Number(line.split('\t')[0]) || 0) + (Number(line.split('\t')[1]) || 0), 0);
  return { commit, base, subject: git(['log', '-1', '--format=%s', commit]).stdout.trim(), files, tests, srcLinesChanged: stat };
}

const modulesCache = path.join(os.tmpdir(), 'codico-mine-modules');

/** node_modules for the lock file at this commit, installed once per distinct lock file. */
function installModules(workspace) {
  const lock = path.join(workspace, 'package-lock.json');
  const key = crypto.createHash('sha256').update(fs.existsSync(lock) ? fs.readFileSync(lock) : '').digest('hex').slice(0, 16);
  const cached = path.join(modulesCache, key, 'node_modules');
  if (!fs.existsSync(cached)) {
    const install = cp.spawnSync(npm, ['ci', '--no-audit', '--no-fund'], { cwd: workspace, encoding: 'utf8', timeout: 10 * 60_000 });
    if (install.status !== 0) { throw new Error(`npm ci failed: ${(install.stderr || '').slice(-500)}`); }
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    cp.spawnSync('cp', ['-a', path.join(workspace, 'node_modules'), cached]);
    return;
  }
  cp.spawnSync('cp', ['-al', cached, path.join(workspace, 'node_modules')]);
}

/** The verifier's tests in the workspace, as TAP results. */
function runVerifier(workspace, verifier, names) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = cp.spawnSync(npm, ['test', '--', '--test-reporter=tap', `--test-name-pattern=${namePattern(names)}`, verifier], { cwd: workspace, env, encoding: 'utf8', timeout: 10 * 60_000 });
  return parseTap(run.stdout);
}

/** Proves a candidate valid, or says why it is not. */
function validate(candidate) {
  const usable = candidate.tests.filter(t => t.added.length && !t.missing.length);
  if (!usable.length) {
    return { ...candidate, valid: false, reason: candidate.tests.some(t => t.missing.length) ? `its tests load modules the fix creates (${[...new Set(candidate.tests.flatMap(t => t.missing))].join(', ')})` : 'it adds no top-level test' };
  }
  // One test file per task: the one adding the most tests
  const chosen = usable.sort((a, b) => b.added.length - a.added.length)[0];
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-mine-'));
  const workspace = path.join(parent, 'ws');
  try {
    if (git(['worktree', 'add', '--detach', workspace, candidate.base]).status !== 0) { return { ...candidate, valid: false, reason: 'worktree failed' }; }
    installModules(workspace);
    const verifier = `tests/__codico_eval_mined.test.js`;
    fs.writeFileSync(path.join(workspace, verifier), git(['show', `${candidate.commit}:${chosen.file}`]).stdout);
    const before = runVerifier(workspace, verifier, chosen.added);
    if (before.size === 0) { return { ...candidate, chosen, valid: false, reason: 'no test ran before the fix (the base does not build)' }; }
    const failing = chosen.added.filter(name => before.get(name) === false);
    // The file failed to load before the fix (it imports what the fix adds): every new test fails
    // there, and the task's prompt must name what the test imports
    const loadFailure = failing.length === 0 && chosen.added.every(name => !before.has(name)) && [...before.values()].some(ok => !ok);
    const verifierNames = loadFailure ? chosen.added : failing;
    if (!verifierNames.length) { return { ...candidate, chosen, valid: false, reason: 'its new tests already pass before the fix' }; }
    const oracle = applyOracle(root, workspace, candidate.base, candidate.commit);
    if (!oracle.ok) { return { ...candidate, chosen, valid: false, reason: oracle.finalReply }; }
    for (let attempt = 1; attempt <= 2; attempt++) {
      const after = runVerifier(workspace, verifier, verifierNames);
      const broken = verifierNames.filter(name => after.get(name) !== true);
      if (broken.length) { return { ...candidate, chosen, valid: false, reason: `with the fix, ${broken.length} of its tests do not pass (attempt ${attempt})` }; }
    }
    return { ...candidate, chosen, valid: true, loadFailure, verifierFile: path.basename(chosen.file), verifierNames, testNamePattern: namePattern(verifierNames) };
  } catch (error) {
    return { ...candidate, chosen, valid: false, reason: String(error.message || error).slice(0, 300) };
  } finally {
    git(['worktree', 'remove', '--force', workspace]);
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

async function main() {
  const out = path.resolve(arg('--out', path.join(root, 'eval', 'results', 'mined-candidates.json')));
  const jobs = Math.max(1, Number(arg('--jobs', '4')));
  const commitsFile = arg('--commits');
  const commits = commitsFile ? fs.readFileSync(commitsFile, 'utf8').split(/\s+/).filter(Boolean) : candidateCommits();
  console.log(`${commits.length} candidate commits`);
  if (process.env.CODICO_MINE_WORKER) {
    // A worker: validates the commits it was given and prints one JSON line each
    for (const commit of commits) { console.log('RESULT ' + JSON.stringify(validate(describe(commit)))); }
    return;
  }
  // Workers in parallel, each with its own share of the commits
  const shares = Array.from({ length: jobs }, (_, i) => commits.filter((_, j) => j % jobs === i));
  const results = [];
  await Promise.all(shares.filter(s => s.length).map((share, i) => new Promise(resolve => {
    const file = path.join(os.tmpdir(), `codico-mine-share-${process.pid}-${i}.txt`);
    fs.writeFileSync(file, share.join('\n'));
    const child = cp.spawn(process.execPath, [__filename, '--commits', file], { env: { ...process.env, CODICO_MINE_WORKER: '1' } });
    let buffer = '';
    child.stdout.on('data', data => {
      buffer += data;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        if (!line.startsWith('RESULT ')) { continue; }
        const result = JSON.parse(line.slice(7));
        results.push(result);
        console.log(`[${results.length}/${commits.length}] ${result.valid ? 'VALID  ' : 'invalid'} ${result.commit.slice(0, 10)} ${result.subject.slice(0, 70)}${result.valid ? ` (${result.verifierNames.length} tests)` : ` — ${result.reason}`}`);
      }
    });
    child.stderr.on('data', () => {});
    child.on('close', () => { fs.rmSync(file, { force: true }); resolve(); });
  })));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\n${results.filter(r => r.valid).length} valid of ${results.length}. Written to ${out}`);
}

if (require.main === module) { main().catch(error => { console.error(error); process.exit(1); }); }

module.exports = { testNames, namePattern, describe, validate };
