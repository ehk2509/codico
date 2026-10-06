const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateHoldoutResult } = require('../scripts/eval/resultPolicy.js');

function baseRecord(metrics) {
  return {
    setupOk: true,
    agentOk: true,
    verifierOk: true,
    maxTotalTokens: 400000,
    metrics,
  };
}

test('holdout success requires valid verifier, agent completion, and token budget compliance', () => {
  assert.deepEqual(
    evaluateHoldoutResult(baseRecord({ totalTokens: 399999, budgetExceeded: false })),
    { withinTokenBudget: true, success: true },
  );

  assert.deepEqual(
    evaluateHoldoutResult(baseRecord({ totalTokens: 419740, budgetExceeded: true })),
    { withinTokenBudget: false, success: false },
  );

  assert.deepEqual(
    evaluateHoldoutResult(baseRecord({ totalTokens: 400001, budgetExceeded: false })),
    { withinTokenBudget: false, success: false },
  );
});

test('missing metrics can never count as a successful holdout', () => {
  assert.deepEqual(
    evaluateHoldoutResult(baseRecord(null)),
    { withinTokenBudget: false, success: false },
  );
});
