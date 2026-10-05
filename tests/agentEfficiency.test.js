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

test('exploration transitions from advisory guidance to an action-preferred phase', () => {
  assert.equal(explorationGuidance(5), null);
  assert.match(explorationGuidance(6), /evidence-backed edit/i);
  assert.equal(explorationGuidance(7), null);

  const action = explorationDecision(8, 1);
  assert.equal(action.lock, true);
  assert.equal(action.block, undefined);
  assert.match(action.guidance, /make the smallest evidence-backed code change/i);

  const later = explorationDecision(14, 1);
  assert.equal(later.lock, true);
  assert.equal(later.block, undefined);
});

test('repeated targets become stronger guidance without capability withdrawal', () => {
  assert.equal(explorationTarget({ type: 'read_file', filepath: 'src/a.ts', startLine: 1, endLine: 100 }), 'read_file:src/a.ts');
  assert.equal(explorationTarget({ type: 'read_file', filepath: 'src/a.ts', startLine: 200, endLine: 300 }), 'read_file:src/a.ts');

  const early = explorationDecision(5, 3);
  assert.equal(early.lock, undefined);
  assert.equal(early.block, undefined);
  assert.match(early.guidance, /inspected this target repeatedly/i);

  const action = explorationDecision(8, 3);
  assert.equal(action.lock, true);
  assert.equal(action.block, undefined);
  assert.match(action.guidance, /revisited this target repeatedly/i);
});

test('terminal source inspection remains identifiable without being a hard lock', () => {
  assert.equal(isExploratoryTerminalCommand("grep -rn 'StreamChunk' src/"), true);
  assert.equal(isExploratoryTerminalCommand('git grep StreamChunk -- src'), true);
  assert.equal(isExploratoryTerminalCommand('cat src/openRouterClient.ts'), true);
  assert.equal(isExploratoryTerminalCommand('npm test'), false);
  assert.equal(isExploratoryTerminalCommand('npm run compile'), false);
});
