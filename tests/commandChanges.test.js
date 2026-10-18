const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { treeState, changesBetween, COMMAND_CHANGED_FILES } = require('../out/commandChanges.js');
const { ExplorationController } = require('../out/explorationController.js');

const sh = (cwd, ...args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8' });

test('files a shell command changed are found, with their text before it', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codico changes '));
  try {
    sh(repo, 'init', '-q', '-b', 'main'); sh(repo, 'config', 'user.email', 't@example.com'); sh(repo, 'config', 'user.name', 'T');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/team.ts'), 'committed\n'); fs.writeFileSync(path.join(repo, 'src/other.ts'), 'other\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'out\n');
    sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'first');
    fs.writeFileSync(path.join(repo, 'src/wip.ts'), 'wip 1\n'); // changed before the command
    const before = treeState(repo);
    // What a script run in the terminal does (seen in the holdout: python3 - <<'E' … open(p).write(s))
    fs.writeFileSync(path.join(repo, 'src/team.ts'), 'by the script\n');
    fs.writeFileSync(path.join(repo, 'src/wip.ts'), 'wip 2\n');
    fs.writeFileSync(path.join(repo, 'src/new.ts'), 'new\n');
    fs.mkdirSync(path.join(repo, 'out')); fs.writeFileSync(path.join(repo, 'out/team.js'), 'build output');
    const changes = changesBetween(before, treeState(repo), () => undefined).sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(changes, [
      { path: 'src/new.ts', before: null, after: 'new\n' },
      { path: 'src/team.ts', before: 'committed\n', after: 'by the script\n' },
      { path: 'src/wip.ts', before: 'wip 1\n', after: 'wip 2\n' },
    ], 'ignored build output and untouched files are not changes');
    // Nothing changed: nothing found; a file Codico already recorded keeps its recorded text as "before"
    const now = treeState(repo);
    assert.deepEqual(changesBetween(now, treeState(repo), () => undefined), []);
    fs.writeFileSync(path.join(repo, 'src/other.ts'), 'other 2\n');
    assert.deepEqual(changesBetween(now, treeState(repo), file => file === 'src/other.ts' ? 'recorded\n' : undefined), [{ path: 'src/other.ts', before: 'recorded\n', after: 'other 2\n' }]);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  assert.equal(treeState(os.tmpdir()), undefined, 'not a git repository');
});

test('a command that changed files is a code change: it must be verified like an edit', () => {
  const c = new ExplorationController('Name the workers after their part');
  c.beginIteration();
  c.after({ type: 'run_terminal', command: "python3 - <<'E'\nopen('src/team.ts','w').write(s)\nE" }, `[run_terminal: python3]\nExit: 0\n\n${COMMAND_CHANGED_FILES} src/team.ts. Codico records and checks them like an edit.`);
  assert.equal(c.verificationPending, true);
  assert.match(c.completionGuidance(), /have not completed the task acceptance check/);
  c.after({ type: 'run_terminal', command: 'node --test tests/team.test.js' }, '[run_terminal: node --test tests/team.test.js]\nExit: 0\n# pass 4\n# fail 0');
  assert.equal(c.verificationPending, false);
});
