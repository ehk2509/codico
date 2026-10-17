const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { withoutChange, commandIn, outcomeWithoutChange, isTestFile } = require('../out/reproduction.js');

const sh = (cwd, ...args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8' });

test('the scratch worktree is the workspace as it is, with the turn\'s changes undone except to tests', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codico repro '));
  try {
    sh(repo, 'init', '-q', '-b', 'main'); sh(repo, 'config', 'user.email', 't@example.com'); sh(repo, 'config', 'user.name', 'T');
    fs.mkdirSync(path.join(repo, 'src')); fs.mkdirSync(path.join(repo, 'tests')); fs.mkdirSync(path.join(repo, 'node_modules'));
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\nout\n');
    fs.writeFileSync(path.join(repo, 'src/a.js'), 'old\n'); fs.writeFileSync(path.join(repo, 'src/gone.js'), 'x\n'); fs.writeFileSync(path.join(repo, 'tests/a.test.js'), 'old test\n');
    sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'first');
    // Before the turn: an uncommitted edit and a deleted file, kept as they are
    fs.writeFileSync(path.join(repo, 'src/wip.js'), 'work in progress\n'); fs.rmSync(path.join(repo, 'src/gone.js'));
    // The turn: a source change, a new source file, a changed and a new test
    fs.writeFileSync(path.join(repo, 'src/a.js'), 'new\n'); fs.writeFileSync(path.join(repo, 'src/added.js'), 'added\n');
    fs.writeFileSync(path.join(repo, 'tests/a.test.js'), 'new test\n'); fs.writeFileSync(path.join(repo, 'tests/b.test.js'), 'b test\n');
    const changes = [{ path: 'src/a.js', before: 'old\n', after: 'new\n' }, { path: path.join(repo, 'src/added.js'), before: null, after: 'added\n' },
      { path: 'tests/a.test.js', before: 'old test\n', after: 'new test\n' }, { path: 'tests/b.test.js', before: null, after: 'b test\n' }];
    const scratch = withoutChange(repo, changes);
    try {
      const read = (f) => fs.existsSync(path.join(scratch.root, f)) ? fs.readFileSync(path.join(scratch.root, f), 'utf8') : null;
      assert.deepEqual([read('src/a.js'), read('src/added.js'), read('tests/a.test.js'), read('tests/b.test.js'), read('src/wip.js'), read('src/gone.js')],
        ['old\n', null, 'new test\n', 'b test\n', 'work in progress\n', null]);
      assert.ok(fs.lstatSync(path.join(scratch.root, 'node_modules')).isSymbolicLink(), 'dependencies are shared');
      // The workspace itself is untouched
      assert.equal(fs.readFileSync(path.join(repo, 'src/a.js'), 'utf8'), 'new\n');
    } finally { scratch.remove(); }
    assert.equal(fs.existsSync(scratch.dir), false);
    assert.doesNotMatch(sh(repo, 'worktree', 'list'), /codico-repro/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  assert.equal(withoutChange(os.tmpdir(), []), undefined, 'not a git repository');
});

test('commands point into the scratch worktree, and only a test failure counts as the problem shown', () => {
  assert.equal(commandIn('cd /tmp/ws && npm test && cat /tmp/ws-other/x', '/tmp/ws', '/tmp/s'), 'cd /tmp/s && npm test && cat /tmp/s-other/x');
  assert.equal(outcomeWithoutChange('npm test', 1, '# pass 3\n# fail 2\n'), 'failed');
  assert.equal(outcomeWithoutChange('npm test', 0, '# pass 5\n# fail 0\n'), 'passed');
  assert.equal(outcomeWithoutChange('node --test tests/a.test.js', 1, "Error: Cannot find module '../out/a.js'\n# pass 0\n# fail 1\n"), 'unknown', 'no build output in the scratch copy');
  assert.equal(outcomeWithoutChange('npm test', 2, 'sh: 1: jest: not found'), 'unknown');
  assert.equal(outcomeWithoutChange('npm test | tail -3', 0, 'done'), 'unknown');
  assert.deepEqual(['tests/a.test.js', 'src/a.spec.ts', 'pkg/db_test.go', 'test_x.py', 'src/a.ts', 'src/testing.ts'].map(isTestFile), [true, true, true, true, false, false]);
});

test('without the change, a pass is believed only from the tests\' summary', () => {
  assert.equal(outcomeWithoutChange('npm test > full.log; echo "exit $?"', 0, 'exit 1\n'), 'unknown');
  assert.equal(outcomeWithoutChange('npm test', 0, 'all good'), 'unknown');
  assert.equal(outcomeWithoutChange('npm test; echo done', 0, '# pass 5\n# fail 0\ndone'), 'passed');
});
