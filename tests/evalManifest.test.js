const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const suitePath = path.join(root, 'eval', 'tasks.json');
const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8'));

test('coding holdout v1 is frozen, non-trivial, and internally consistent', () => {
  assert.equal(suite.suiteVersion, 'codico-coding-holdout-v1');
  assert.equal(suite.frozen, true);
  assert.ok(Array.isArray(suite.tasks));
  assert.ok(suite.tasks.length >= 25, 'frozen suite must contain at least 25 tasks');

  const ids = new Set();
  for (const task of suite.tasks) {
    assert.match(task.id, /^[a-z0-9][a-z0-9-]+$/);
    assert.equal(ids.has(task.id), false, `duplicate task id: ${task.id}`);
    ids.add(task.id);

    assert.match(task.baseCommit, /^[0-9a-f]{40}$/);
    assert.ok(task.prompt.length >= 80, `task prompt is too weak: ${task.id}`);
    assert.ok(task.maxIterations >= 10 && task.maxIterations <= 60);

    const verifier = path.join(root, 'tests', task.verifierFile);
    assert.equal(fs.existsSync(verifier), true, `missing verifier: ${task.verifierFile}`);
    const verifierText = fs.readFileSync(verifier, 'utf8');
    assert.ok(
      verifierText.includes(task.testNamePattern),
      `verifier pattern not found for ${task.id}: ${task.testNamePattern}`
    );

    // The task prompt must not reveal the hidden test name.
    assert.equal(
      task.prompt.toLowerCase().includes(task.testNamePattern.toLowerCase()),
      false,
      `task leaks verifier name: ${task.id}`
    );
  }
});

test('holdout tasks cover multiple historical failure families', () => {
  const categories = new Set(suite.tasks.map(task => task.category));
  for (const required of ['streaming', 'agent-loop', 'tool-parser', 'terminal', 'native-tools', 'native-history', 'security']) {
    assert.equal(categories.has(required), true, `missing category: ${required}`);
  }
});
