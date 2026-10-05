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

test('focused exploration policy distinguishes reads from mutations', () => {
  assert.equal(isExplorationTool({ type: 'read_file', filepath: 'src/a.ts' }), true);
  assert.equal(isExplorationTool({ type: 'search_files', pattern: 'foo', isRegex: false }), true);
  assert.equal(isExplorationTool({ type: 'run_terminal', command: 'npm test' }), false);
  assert.equal(isMutationTool({ type: 'edit_file', filepath: 'a', oldStr: 'x', newStr: 'y' }), true);
});

test('exploration guidance is advisory, bounded, and periodic', () => {
  assert.equal(explorationGuidance(5), null);
  assert.match(explorationGuidance(6), /evidence-backed edit/i);
  assert.equal(explorationGuidance(7), null);
  assert.equal(explorationGuidance(9), null);
  assert.match(explorationGuidance(10), /read-only exploration calls/i);
  assert.equal(explorationGuidance(11), null);
});

test('repeated targets produce guidance without withdrawing capabilities', () => {
  assert.equal(explorationTarget({ type: 'read_file', filepath: 'src/a.ts', startLine: 1, endLine: 100 }), 'read_file:src/a.ts');
  assert.equal(explorationTarget({ type: 'read_file', filepath: 'src/a.ts', startLine: 200, endLine: 300 }), 'read_file:src/a.ts');

  assert.equal(explorationDecision(5, 1).block, undefined);
  assert.match(explorationDecision(6, 1).guidance, /evidence-backed edit/i);

  const repeated = explorationDecision(8, 3);
  assert.equal(repeated.block, undefined);
  assert.equal(repeated.lock, undefined);
  assert.match(repeated.guidance, /inspected this target repeatedly/i);

  const longRun = explorationDecision(12, 1);
  assert.equal(longRun.block, undefined);
  assert.equal(longRun.lock, undefined);
});

test('terminal source inspection remains identifiable without being a hard lock', () => {
  assert.equal(isExploratoryTerminalCommand("grep -rn 'StreamChunk' src/"), true);
  assert.equal(isExploratoryTerminalCommand('git grep StreamChunk -- src'), true);
  assert.equal(isExploratoryTerminalCommand('cat src/openRouterClient.ts'), true);
  assert.equal(isExploratoryTerminalCommand('npm test'), false);
  assert.equal(isExploratoryTerminalCommand('npm run compile'), false);
});
