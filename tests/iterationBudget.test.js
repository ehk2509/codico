const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldRunAgentIteration } = require('../out/iterationBudget.js');

test('unlimited agent budget remains unlimited', () => {
  assert.equal(shouldRunAgentIteration(500, 0, false, 4), true);
});

test('normal iteration budget remains a soft stop only when no correctness work is pending', () => {
  assert.equal(shouldRunAgentIteration(15, 16, false, 4), true);
  assert.equal(shouldRunAgentIteration(16, 16, false, 4), false);
});

test('pending verification is never terminated by the normal iteration budget', () => {
  assert.equal(shouldRunAgentIteration(16, 16, true, 4), true);
  assert.equal(shouldRunAgentIteration(40, 16, true, 4), true);
  assert.equal(shouldRunAgentIteration(400, 16, true, 4), true);
});

test('pending required mutation is never terminated by the normal iteration budget', () => {
  assert.equal(shouldRunAgentIteration(16, 16, false, 4, true, 3), true);
  assert.equal(shouldRunAgentIteration(40, 16, false, 4, true, 3), true);
  assert.equal(shouldRunAgentIteration(400, 16, false, 4, true, 3), true);
});

test('once correctness obligations clear the normal budget can end the autonomous loop', () => {
  assert.equal(shouldRunAgentIteration(17, 16, true, 4), true);
  assert.equal(shouldRunAgentIteration(17, 16, false, 4, false, 3), false);
});

test('legacy grace arguments cannot create a hidden completion ceiling', () => {
  assert.equal(shouldRunAgentIteration(100, 16, true, -5, false, -2, 90), true);
  assert.equal(shouldRunAgentIteration(100, 16, false, -5, true, -2, 0), true);
});
