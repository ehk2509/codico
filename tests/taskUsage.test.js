const test = require('node:test');
const assert = require('node:assert/strict');
const { TaskUsage } = require('../out/taskUsage.js');

test('task usage sums tokens and provider-reported cost', () => {
  const usage = new TaskUsage(0);
  usage.add(1000);
  assert.equal(usage.costUsd, undefined, 'no cost until a provider reports one');
  usage.add(500, 0.002);
  usage.add(250, 0.001);
  usage.add(10, Number.NaN);
  assert.equal(usage.tokens, 1760);
  assert.ok(Math.abs(usage.costUsd - 0.003) < 1e-12);
  assert.equal(usage.budgetExceeded, false, 'budget 0 never pauses');
});

test('token budget pauses once per budget step', () => {
  const usage = new TaskUsage(10000);
  usage.add(9999);
  assert.equal(usage.budgetExceeded, false);
  usage.add(1, 0.5);
  assert.equal(usage.budgetExceeded, true);
  assert.match(usage.budgetPrompt(), /10,000 tokens \(about \$0\.500\), over your 10,000-token budget/);

  usage.extendBudget();
  assert.equal(usage.budgetExceeded, false, 'continuing grants another budget');
  usage.add(25000); // jumps past several thresholds at once
  assert.equal(usage.budgetExceeded, true);
  usage.extendBudget();
  assert.equal(usage.budgetExceeded, false);
  usage.add(5000);
  assert.equal(usage.budgetExceeded, true, 'next pause at 40,000');
});
