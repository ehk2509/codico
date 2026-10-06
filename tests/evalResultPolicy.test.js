const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateHoldoutResult } = require('../scripts/eval/resultPolicy.js');

function baseRecord(metrics, maxTotalTokens = 0) {
  return {
    setupOk: true,
    agentOk: true,
    verifierOk: true,
    maxTotalTokens,
    metrics,
  };
}

test('unlimited holdouts do not fail because of cumulative token count', () => {
  assert.deepEqual(
    evaluateHoldoutResult(baseRecord({ totalTokens: 999999, budgetExceeded: false })),
    { withinTokenBudget: true, success: true },
  );

  // A stale budgetExceeded flag cannot make an explicitly unlimited run fail.
  assert.deepEqual(
    evaluateHoldoutResult(baseRecord({ totalTokens: 999999, budgetExceeded: true })),
    { withinTokenBudget: true, success: true },
  );
});

test('explicit non-zero token ceilings are still enforceable for local experiments', () => {
  assert.deepEqual(
    evaluateHoldoutResult(baseRecord({ totalTokens: 399999, budgetExceeded: false }, 400000)),
    { withinTokenBudget: true, success: true },
  );
  assert.deepEqual(
    evaluateHoldoutResult(baseRecord({ totalTokens: 400001, budgetExceeded: false }, 400000)),
    { withinTokenBudget: false, success: false },
  );
});

test('missing metrics can never count as a successful holdout', () => {
  assert.deepEqual(
    evaluateHoldoutResult(baseRecord(null)),
    { withinTokenBudget: false, success: false },
  );
});
