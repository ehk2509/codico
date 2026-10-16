const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const suite = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'tasks.json'), 'utf8'));
const v6 = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'tasks-v6.json'), 'utf8'));
const v5 = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'tasks-v5.json'), 'utf8'));
const v4 = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'tasks-v4.json'), 'utf8'));
const v3 = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'tasks-v3.json'), 'utf8'));
const v2 = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'tasks-v2.json'), 'utf8'));
const v1 = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'tasks-v1.json'), 'utf8'));

test('coding holdout v7 is frozen, non-trivial, and internally consistent', () => {
  assert.equal(suite.suiteVersion, 'codico-coding-holdout-v7');
  assert.equal(suite.frozen, true);
  assert.ok(Array.isArray(suite.tasks));
  assert.ok(suite.tasks.length >= 30);
  assert.equal(suite.maxTotalTokens, 0);
  assert.equal(suite.maxTaskMinutes, 0);

  const ids = new Set();
  for (const task of suite.tasks) {
    assert.match(task.id, /^[a-z0-9][a-z0-9-]+$/);
    assert.equal(ids.has(task.id), false, `duplicate task id: ${task.id}`);
    ids.add(task.id);
    assert.match(task.baseCommit, /^[0-9a-f]{40}$/);
    assert.ok(task.prompt.length >= 80);
    // v7 has no step limit: a run ends when the agent stops
    assert.equal(task.maxIterations, 0);
    assert.match(task.verifierCommit, /^[0-9a-f]{40}$/);

    if (task.verifierPath) {
      const verifierPath = path.join(root, task.verifierPath);
      assert.equal(fs.existsSync(verifierPath), true);
      assert.ok(fs.readFileSync(verifierPath, 'utf8').includes(task.testNamePattern));
    } else {
      assert.match(task.verifierFile, /\.test\.js$/);
      // Mined tasks: the verifier is the historical fix's own test, run only for the tests the fix made pass
      if (task.fixCommit) {
        assert.equal(task.verifierCommit, task.fixCommit);
        assert.match(task.testNamePattern, /^\^\(\?:.+\)\$$/);
      }
    }

    assert.equal(task.prompt.toLowerCase().includes(task.testNamePattern.toLowerCase()), false);
  }
});

test('burned v1-v6 suites remain archived', () => {
  assert.equal(v1.suiteVersion, 'codico-coding-holdout-v1');
  assert.equal(v2.suiteVersion, 'codico-coding-holdout-v2');
  assert.equal(v3.suiteVersion, 'codico-coding-holdout-v3');
  assert.equal(v4.suiteVersion, 'codico-coding-holdout-v4');
  assert.equal(v5.suiteVersion, 'codico-coding-holdout-v5');
  assert.equal(v5.maxTotalTokens, 400000);
  assert.equal(v5.maxTaskMinutes, 15);
  assert.equal(v6.suiteVersion, 'codico-coding-holdout-v6');
  for (const archived of [v1, v2, v3, v4, v5, v6]) {
    assert.equal(archived.frozen, true);
    assert.equal(archived.tasks.length, v6.tasks.length);
  }
});

test('v7 retains integrated resume-overlap scoring from v5', () => {
  const task = suite.tasks.find(t => t.id === 'stream-resume-overlap');
  // v7's copy also follows internal helpers and generator functions; v6 keeps the original
  assert.equal(task.verifierPath, 'eval/verifiers/streamResumeOverlapIntegrated.v7.verifier.js');
  assert.equal(v6.tasks.find(t => t.id === 'stream-resume-overlap').verifierPath, 'eval/verifiers/streamResumeOverlapIntegrated.verifier.js');
  const source = fs.readFileSync(path.join(root, task.verifierPath), 'utf8');
  assert.match(source, /integratedRecoveryCall/);
  assert.match(source, /used directly or through an exported streamCompletion recovery helper/);
});

test('v7 retains behavior-level fingerprint and EOF verifiers', () => {
  assert.equal(
    suite.tasks.find(t => t.id === 'stream-unexpected-eof').verifierPath,
    'eval/verifiers/streamUnexpectedEof.verifier.js',
  );
  assert.equal(
    suite.tasks.find(t => t.id === 'tools-fingerprint-arguments').verifierPath,
    'eval/verifiers/toolFingerprintArguments.verifier.js',
  );
});

test('holdout covers multiple historical failure families', () => {
  const categories = new Set(suite.tasks.map(task => task.category));
  // v6's native-history tasks could never be scored (their verifiers load modules the fix created): v7 has none
  for (const required of ['streaming', 'agent-loop', 'tool-parser', 'terminal', 'native-tools', 'security', 'context', 'providers', 'chat-panel']) {
    assert.equal(categories.has(required), true, `missing category: ${required}`);
  }
});

test('v7 keeps exactly the v6 tasks that could be scored, unchanged but for the step limit and the interface its prompt names', () => {
  const carried = ['stream-unexpected-eof', 'stream-resume-overlap', 'agent-unfulfilled-action', 'tools-unclosed-fence', 'tools-fingerprint-arguments',
    'tools-write-nested-fences', 'tools-four-backtick-envelope', 'tools-edit-nested-fences', 'tools-stream-closing-line'];
  for (const id of carried) {
    // Unchanged but for the step limit, which v7 removes, and a prompt that may name the function the verifier imports
    const now = suite.tasks.find(t => t.id === id);
    const then = v6.tasks.find(t => t.id === id);
    assert.ok(now.prompt.startsWith(then.prompt), id);
    assert.deepEqual({ ...now, maxIterations: 16, prompt: then.prompt, ...(then.verifierPath ? { verifierPath: then.verifierPath } : {}) }, then, id);
  }
  assert.equal(suite.tasks.filter(t => v6.tasks.some(o => o.id === t.id)).length, carried.length);
});

test('no task can only be passed by guessing a name: what a verifier imports exists at the base or is named in the prompt', (t) => {
  const { unguessableNames } = require('../scripts/eval/suiteCheck.js');
  // Needs the history of the base and verifier commits, which a shallow checkout (CI) does not have
  const found = suite.tasks.map(task => [task.id, unguessableNames(task)]);
  if (found.some(([, names]) => names === null)) { t.skip('repository history not available'); return; }
  for (const [id, names] of found) {
    assert.deepEqual(names, [], id);
  }
});
