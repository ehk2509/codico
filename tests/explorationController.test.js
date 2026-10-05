const test = require('node:test');
const assert = require('node:assert/strict');
const { ExplorationController } = require('../out/explorationController.js');

test('controller enters action phase without withdrawing discovery capabilities', () => {
  const controller = new ExplorationController();
  let last;

  for (let i = 0; i < 8; i++) {
    last = controller.before({ type: 'search_files', pattern: 'p' + i, isRegex: false }, false);
    assert.equal(last.block, undefined);
  }

  assert.equal(controller.locked, true);
  assert.match(last.guidance, /make the smallest evidence-backed code change/i);

  const stillReadable = controller.before({ type: 'read_file', filepath: 'src/a.ts' }, false);
  assert.equal(stillReadable.block, undefined);
  assert.equal(controller.blocksTerminal({ type: 'run_terminal', command: 'cat src/a.ts' }), false);
});

test('post-edit verification resets action phase and can follow dependencies', () => {
  const controller = new ExplorationController(
    'Fix premature EOF handling. Keep normal completed streams unchanged.'
  );

  for (let i = 0; i < 8; i++) {
    controller.before({ type: 'search_files', pattern: 'p' + i, isRegex: false }, false);
  }
  assert.equal(controller.locked, true);

  controller.after(
    { type: 'edit_file', filepath: 'src/openRouterClient.ts', oldStr: 'a', newStr: 'b' },
    '[edit_file: src/openRouterClient.ts] Edit applied successfully.\n\n[Local invariant audit]\n- finishReason'
  );

  assert.equal(controller.locked, false);
  assert.equal(controller.verificationPending, true);
  assert.match(controller.completionGuidance(), /have not completed the task acceptance check/i);

  const sibling = controller.before({ type: 'read_file', filepath: 'src/directProviderClient.ts' }, false);
  assert.equal(sibling.block, undefined);
  assert.match(sibling.guidance, /following a dependency/i);

  const verified = controller.after(
    { type: 'run_terminal', command: 'npm test' },
    '[run_terminal: npm test]\nExit: 0\nall good'
  );
  assert.equal(controller.verificationPending, false);
});

test('Ask mode remains unconstrained', () => {
  const controller = new ExplorationController();
  for (let i = 0; i < 20; i++) {
    const check = controller.before({ type: 'read_file', filepath: 'src/a.ts' }, true);
    assert.equal(check.block, undefined);
    assert.equal(check.isExploration, false);
  }
});
