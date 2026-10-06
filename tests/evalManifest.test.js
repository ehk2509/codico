const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const suite = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'tasks.json'), 'utf8'));
const v5 = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'tasks-v5.json'), 'utf8'));
const v4 = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'tasks-v4.json'), 'utf8'));
const v3 = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'tasks-v3.json'), 'utf8'));
const v2 = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'tasks-v2.json'), 'utf8'));
const v1 = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'tasks-v1.json'), 'utf8'));

test('coding holdout v6 is frozen, non-trivial, and internally consistent', () => {
  assert.equal(suite.suiteVersion, 'codico-coding-holdout-v6');
  assert.equal(suite.frozen, true);
  assert.ok(Array.isArray(suite.tasks));
  assert.ok(suite.tasks.length >= 25);
  assert.equal(suite.maxTotalTokens, 0);
  assert.equal(suite.maxTaskMinutes, 0);

  const ids = new Set();
  for (const task of suite.tasks) {
    assert.match(task.id, /^[a-z0-9][a-z0-9-]+$/);
    assert.equal(ids.has(task.id), false, `duplicate task id: ${task.id}`);
    ids.add(task.id);
    assert.match(task.baseCommit, /^[0-9a-f]{40}$/);
    assert.ok(task.prompt.length >= 80);
    assert.ok(task.maxIterations >= 8 && task.maxIterations <= 16);
    assert.match(task.verifierCommit, /^[0-9a-f]{40}$/);

    if (task.verifierPath) {
      const verifierPath = path.join(root, task.verifierPath);
      assert.equal(fs.existsSync(verifierPath), true);
      assert.ok(fs.readFileSync(verifierPath, 'utf8').includes(task.testNamePattern));
    } else {
      assert.match(task.verifierFile, /\.test\.js$/);
    }

    assert.equal(task.prompt.toLowerCase().includes(task.testNamePattern.toLowerCase()), false);
  }
});

test('burned v1-v5 suites remain archived', () => {
  assert.equal(v1.suiteVersion, 'codico-coding-holdout-v1');
  assert.equal(v2.suiteVersion, 'codico-coding-holdout-v2');
  assert.equal(v3.suiteVersion, 'codico-coding-holdout-v3');
  assert.equal(v4.suiteVersion, 'codico-coding-holdout-v4');
  assert.equal(v5.suiteVersion, 'codico-coding-holdout-v5');
  assert.equal(v5.maxTotalTokens, 400000);
  assert.equal(v5.maxTaskMinutes, 15);
  for (const archived of [v1, v2, v3, v4, v5]) {
    assert.equal(archived.frozen, true);
    assert.equal(archived.tasks.length, suite.tasks.length);
  }
});

test('v6 retains integrated resume-overlap scoring from v5', () => {
  const task = suite.tasks.find(t => t.id === 'stream-resume-overlap');
  assert.equal(task.verifierPath, 'eval/verifiers/streamResumeOverlapIntegrated.verifier.js');
  const source = fs.readFileSync(path.join(root, task.verifierPath), 'utf8');
  assert.match(source, /callPattern/);
  assert.match(source, /must be called by the agent resume path/);
});

test('v6 retains behavior-level fingerprint and EOF verifiers', () => {
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
  for (const required of ['streaming', 'agent-loop', 'tool-parser', 'terminal', 'native-tools', 'native-history', 'security']) {
    assert.equal(categories.has(required), true, `missing category: ${required}`);
  }
});
