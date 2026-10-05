const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const suite = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'tasks.json'), 'utf8'));
const v2 = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'tasks-v2.json'), 'utf8'));
const v1 = JSON.parse(fs.readFileSync(path.join(root, 'eval', 'tasks-v1.json'), 'utf8'));

test('coding holdout v3 is frozen, non-trivial, and internally consistent', () => {
  assert.equal(suite.suiteVersion, 'codico-coding-holdout-v3');
  assert.equal(suite.frozen, true);
  assert.ok(Array.isArray(suite.tasks));
  assert.ok(suite.tasks.length >= 25);
  assert.ok(suite.maxTotalTokens >= 100000 && suite.maxTotalTokens <= 500000);
  assert.ok(suite.maxTaskMinutes >= 5 && suite.maxTaskMinutes <= 15);

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
      const verifier = path.join(root, task.verifierPath);
      assert.equal(fs.existsSync(verifier), true);
      assert.ok(fs.readFileSync(verifier, 'utf8').includes(task.testNamePattern));
    } else {
      assert.match(task.verifierFile, /\.test\.js$/);
    }

    assert.equal(task.prompt.toLowerCase().includes(task.testNamePattern.toLowerCase()), false);
  }
});

test('burned v1 and v2 suites remain archived', () => {
  assert.equal(v1.suiteVersion, 'codico-coding-holdout-v1');
  assert.equal(v2.suiteVersion, 'codico-coding-holdout-v2');
  assert.equal(v1.frozen, true);
  assert.equal(v2.frozen, true);
  assert.equal(v1.tasks.length, suite.tasks.length);
  assert.equal(v2.tasks.length, suite.tasks.length);
});

test('v3 fixes implementation-specific fingerprint scoring', () => {
  const task = suite.tasks.find(t => t.id === 'tools-fingerprint-arguments');
  assert.equal(task.verifierPath, 'eval/verifiers/toolFingerprintArguments.verifier.js');
  const source = fs.readFileSync(path.join(root, task.verifierPath), 'utf8');
  assert.match(source, /fingerprint\(writeA\)/);
  assert.match(source, /fingerprint\(runLs\)/);
});

test('holdout covers multiple historical failure families', () => {
  const categories = new Set(suite.tasks.map(task => task.category));
  for (const required of ['streaming', 'agent-loop', 'tool-parser', 'terminal', 'native-tools', 'native-history', 'security']) {
    assert.equal(categories.has(required), true, `missing category: ${required}`);
  }
});
