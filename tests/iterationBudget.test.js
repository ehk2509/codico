const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldRunAgentIteration } = require('../out/iterationBudget.js');

test('unlimited agent budget remains unlimited', () => {
  assert.equal(shouldRunAgentIteration(500, 0, false, 4), true);
});

test('normal iteration budget stops exploration at the configured maximum', () => {
  assert.equal(shouldRunAgentIteration(15, 16, false, 4), true);
  assert.equal(shouldRunAgentIteration(16, 16, false, 4), false);
});

test('pending verification receives only the bounded grace budget', () => {
  assert.equal(shouldRunAgentIteration(16, 16, true, 4), true);
  assert.equal(shouldRunAgentIteration(19, 16, true, 4), true);
  assert.equal(shouldRunAgentIteration(20, 16, true, 4), false);
});

test('verification grace ends immediately after acceptance succeeds', () => {
  assert.equal(shouldRunAgentIteration(17, 16, true, 4), true);
  assert.equal(shouldRunAgentIteration(17, 16, false, 4), false);
});

test('negative or fractional grace is normalized safely', () => {
  assert.equal(shouldRunAgentIteration(16, 16, true, -5), false);
  assert.equal(shouldRunAgentIteration(17, 16, true, 2.9), true);
  assert.equal(shouldRunAgentIteration(18, 16, true, 2.9), false);
});
