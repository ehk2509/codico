const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTaskAcceptanceContract } = require('../out/taskAcceptance.js');

test('task acceptance contract preserves explicit invariants from the original request', () => {
  const contract = buildTaskAcceptanceContract(
    'Fix premature EOF handling. Keep normal completed streams unchanged. Do not report aborts as interruptions.'
  );
  assert.match(contract, /Fix premature EOF handling/);
  assert.match(contract, /Keep normal completed streams unchanged/);
  assert.match(contract, /Do not report aborts as interruptions/);
  assert.match(contract, /preservation \/ negative constraints/i);
});

test('task acceptance contract stays bounded for enormous prompts', () => {
  const contract = buildTaskAcceptanceContract('Fix this. Keep behavior unchanged. ' + 'x'.repeat(10000));
  assert.ok(contract.length < 5000);
});
