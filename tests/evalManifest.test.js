const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const activePath = path.join(root, 'eval', 'tasks.json');
const v1Path = path.join(root, 'eval', 'tasks-v1.json');
const suite = JSON.parse(fs.readFileSync(activePath, 'utf8'));
const v1 = JSON.parse(fs.readFileSync(v1Path, 'utf8'));

test('coding holdout v2 is frozen, non-trivial, and internally consistent', () => {
  assert.equal(suite.suiteVersion, 'codico-coding-holdout-v2');
  assert.equal(suite.frozen, true);
  assert.ok(Array.isArray(suite.tasks));
  assert.ok(suite.tasks.length >= 25, 'frozen suite must contain at least 25 tasks');
  assert.ok(suite.maxTotalTokens >= 100000 && suite.maxTotalTokens <= 500000);
  assert.ok(suite.maxTaskMinutes >= 5 && suite.maxTaskMinutes <= 15);

  const ids = new Set();
  for (const task of suite.tasks) {
    assert.match(task.id, /^[a-z0-9][a-z0-9-]+$/);
    assert.equal(ids.has(task.id), false, `duplicate task id: ${task.id}`);
    ids.add(task.id);

    assert.match(task.baseCommit, /^[0-9a-f]{40}$/);
    assert.ok(task.prompt.length >= 80, `task prompt is too weak: ${task.id}`);
    assert.ok(task.maxIterations >= 8 && task.maxIterations <= 16);
    assert.match(task.verifierCommit, /^[0-9a-f]{40}$/);

    if (task.verifierPath) {
      const verifier = path.join(root, task.verifierPath);
      assert.equal(fs.existsSync(verifier), true, `missing verifier: ${task.verifierPath}`);
      const verifierText = fs.readFileSync(verifier, 'utf8');
      assert.ok(
        verifierText.includes(task.testNamePattern),
        `verifier pattern not found for ${task.id}: ${task.testNamePattern}`
      );
    } else {
      assert.match(task.verifierFile, /\.test\.js$/);
    }

    assert.equal(
      task.prompt.toLowerCase().includes(task.testNamePattern.toLowerCase()),
      false,
      `task leaks verifier name: ${task.id}`
    );
  }
});

test('burned holdout v1 remains archived and reproducible', () => {
  assert.equal(v1.suiteVersion, 'codico-coding-holdout-v1');
  assert.equal(v1.frozen, true);
  assert.equal(v1.tasks.length, suite.tasks.length);
  const eof = v1.tasks.find(task => task.id === 'stream-unexpected-eof');
  assert.equal(eof.verifierPath, 'eval/verifiers/v1/streamUnexpectedEof.verifier.js');
  assert.equal(fs.existsSync(path.join(root, eof.verifierPath)), true);
});

test('v2 EOF verifier checks behavior rather than a hidden message string', () => {
  const eof = suite.tasks.find(task => task.id === 'stream-unexpected-eof');
  assert.equal(eof.verifierPath, 'eval/verifiers/streamUnexpectedEof.verifier.js');
  const source = fs.readFileSync(path.join(root, eof.verifierPath), 'utf8');
  assert.match(source, /unexpected EOF must produce a stream_error/i);
  assert.match(source, /\[DONE\].*must not be reported as interrupted/is);
  assert.match(source, /finish_reason.*must not be reported as interrupted/is);
  assert.equal(source.includes('stream interrupted: connection closed before'), false);
});

test('holdout tasks cover multiple historical failure families', () => {
  const categories = new Set(suite.tasks.map(task => task.category));
  for (const required of ['streaming', 'agent-loop', 'tool-parser', 'terminal', 'native-tools', 'native-history', 'security']) {
    assert.equal(categories.has(required), true, `missing category: ${required}`);
  }
});
