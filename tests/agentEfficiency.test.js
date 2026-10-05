const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isExplorationTool,
  isMutationTool,
  explorationGuidance,
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
