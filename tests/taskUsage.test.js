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

test('cached prompt tokens are counted separately', () => {
  const { TaskUsage } = require('../out/taskUsage.js');
  const usage = new TaskUsage(0);
  usage.add(10000, 0.001, 8000);
  usage.add(12000, 0.001);
  assert.equal(usage.tokens, 22000);
  assert.equal(usage.cachedTokens, 8000);
});

test('a task is recorded request by request, with who made each and when the conversation was compacted', () => {
  const { TaskUsage, MAX_RECORDED_REQUESTS } = require('../out/taskUsage.js');
  const usage = new TaskUsage(0);
  assert.equal(usage.record(), undefined, 'a task that made no request records nothing');
  usage.add(1200, 0.001, 1000, 1100, 100);
  usage.add(5300, 0.002, 0, 5000, 300, 'subagent');
  usage.markCompaction();
  usage.add(900, undefined, 400, 800, 100);
  assert.equal(usage.requests, 3);
  assert.deepEqual(usage.record(), { requests: [[1100, 100, 1000, 'main'], [5000, 300, 0, 'subagent'], [800, 100, 400, 'main']], compactions: [2], tokens: 7400, cachedTokens: 1400, costUsd: 0.003 });
  // Older callers that give only totals still count as requests
  const plain = new TaskUsage(0); plain.add(10); plain.add(20);
  assert.deepEqual([plain.requests, plain.tokens, plain.record().requests.length], [2, 30, 2]);
  assert.equal('costUsd' in plain.record(), false);
  // A very long task keeps its totals and the first requests, not an unbounded list
  const long = new TaskUsage(0);
  for (let i = 0; i < MAX_RECORDED_REQUESTS + 50; i++) { long.add(10, undefined, 0, 9, 1); }
  assert.deepEqual([long.requests, long.record().requests.length, long.tokens], [MAX_RECORDED_REQUESTS + 50, MAX_RECORDED_REQUESTS, (MAX_RECORDED_REQUESTS + 50) * 10]);
});
