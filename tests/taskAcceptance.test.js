const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTaskAcceptanceContract } = require('../out/taskAcceptance.js');

test('task acceptance contract preserves outcomes and implementation discipline', () => {
  const contract = buildTaskAcceptanceContract(
    'Improve repeated-tool loop detection so fingerprints include tool arguments. Keep normal calls unchanged. Do not collapse different paths.'
  );

  assert.match(contract, /fingerprints include tool arguments/);
  assert.match(contract, /Keep normal calls unchanged/);
  assert.match(contract, /Do not collapse different paths/);
  assert.match(contract, /Acceptance checklist derived from the request/);
  assert.match(contract, /abstraction or API boundary that owns the behavior/i);
  assert.match(contract, /do not optimize for guessed hidden tests/i);
});

test('task acceptance contract stays bounded for enormous prompts', () => {
  assert.ok(buildTaskAcceptanceContract('Fix this. Keep behavior unchanged. ' + 'x'.repeat(10000)).length < 6500);
});
