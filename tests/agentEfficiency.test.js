const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isExplorationTool,
  isMutationTool,
  explorationGuidance,
  explorationDecision,
  explorationTarget,
  isExploratoryTerminalCommand,
} = require('../out/agentEfficiency.js');

test('focused exploration guard distinguishes reads from mutations', () => {
  assert.equal(isExplorationTool({ type: 'read_file', filepath: 'src/a.ts' }), true);
  assert.equal(isExplorationTool({ type: 'search_files', pattern: 'foo', isRegex: false }), true);
  assert.equal(isExplorationTool({ type: 'run_terminal', command: 'npm test' }), false);
  assert.equal(isMutationTool({ type: 'edit_file', filepath: 'a', oldStr: 'x', newStr: 'y' }), true);
});

test('exploration guidance is bounded and repeats only periodically', () => {
  assert.equal(explorationGuidance(5), null);
  assert.match(explorationGuidance(6), /smallest edit now/i);
  assert.equal(explorationGuidance(7), null);
  assert.equal(explorationGuidance(8), null);
  assert.match(explorationGuidance(9), /read-only exploration calls/i);
});


test('focused exploration guard blocks redundant revisits and runaway search streaks', () => {
  assert.equal(explorationTarget({ type: 'read_file', filepath: 'src/a.ts', startLine: 1, endLine: 100 }), 'read_file:src/a.ts');
  assert.equal(explorationTarget({ type: 'read_file', filepath: 'src/a.ts', startLine: 200, endLine: 300 }), 'read_file:src/a.ts');

  assert.equal(explorationDecision(5, 1).block, undefined);
  assert.match(explorationDecision(6, 1).guidance, /smallest edit now/i);
  assert.match(explorationDecision(8, 3).block, /already inspected this target repeatedly/i);
  assert.match(explorationDecision(12, 1).block, /exploration budget exhausted/i);
});


test('global exploration exhaustion locks discovery and blocks terminal read backdoors', () => {
  const decision = explorationDecision(12, 1);
  assert.equal(decision.lock, true);
  assert.match(decision.block, /discovery tools are now disabled/i);
  assert.equal(isExploratoryTerminalCommand("grep -rn 'StreamChunk' src/"), true);
  assert.equal(isExploratoryTerminalCommand('git grep StreamChunk -- src'), true);
  assert.equal(isExploratoryTerminalCommand('cat src/openRouterClient.ts'), true);
  assert.equal(isExploratoryTerminalCommand('npm test'), false);
  assert.equal(isExploratoryTerminalCommand('npm run compile'), false);
});
