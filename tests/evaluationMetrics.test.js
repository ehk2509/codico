const test = require('node:test');
const assert = require('node:assert/strict');

const { buildEvaluationRunMetrics } = require('../out/evaluationMetrics.js');

test('evaluation snapshots preserve partial counters and derive totals', () => {
  const metrics = buildEvaluationRunMetrics({
    startedAt: 1000,
    steps: 7,
    toolCalls: 9,
    filesWritten: 1,
    promptTokens: 120,
    completionTokens: 30,
    historyMessages: 11,
    budgetExceeded: false,
    projectedCharsOmitted: 4000,
    trace: [{ step: 7, tool: 'read_file', target: 'src/a.ts' }],
  }, 1600);

  assert.equal(metrics.durationMs, 600);
  assert.equal(metrics.totalTokens, 150);
  assert.equal(metrics.steps, 7);
  assert.equal(metrics.toolCalls, 9);
  assert.deepEqual(metrics.trace, [{ step: 7, tool: 'read_file', target: 'src/a.ts' }]);
});

test('evaluation snapshot trace is copied defensively', () => {
  const trace = [{ step: 1, tool: 'search_files', target: 'needle' }];
  const metrics = buildEvaluationRunMetrics({
    startedAt: 0,
    steps: 1,
    toolCalls: 1,
    filesWritten: 0,
    promptTokens: 0,
    completionTokens: 0,
    historyMessages: 0,
    budgetExceeded: false,
    projectedCharsOmitted: 0,
    trace,
  }, 100);

  trace.push({ step: 2, tool: 'read_file', target: 'src/x.ts' });
  assert.equal(metrics.durationMs, 0);
  assert.equal(metrics.trace.length, 1);
});
