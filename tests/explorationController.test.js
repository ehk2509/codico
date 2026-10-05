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

test('lifecycle edits require a post-edit audit and behavior-level verification', () => {
  const controller = new ExplorationController(
    'Fix premature EOF handling. Keep normal completed streams unchanged.'
  );

  controller.after(
    { type: 'edit_file', filepath: 'src/openRouterClient.ts', oldStr: 'a', newStr: 'b' },
    '[edit_file: src/openRouterClient.ts] Edit applied successfully.\n\n[Local invariant audit]\n- finishReason'
  );

  assert.equal(controller.verificationPending, true);
  assert.equal(controller.verificationReadAllowed, true);
  assert.match(controller.completionGuidance(), /re-read the edited control flow/i);

  const diagnostics = controller.after(
    { type: 'get_diagnostics', filepath: 'src/openRouterClient.ts' },
    '[get_diagnostics] No diagnostics.'
  );
  assert.equal(controller.verificationPending, true);
  assert.match(diagnostics, /static evidence/i);

  const local = controller.before({ type: 'read_file', filepath: 'src/openRouterClient.ts' }, false);
  assert.equal(local.block, undefined);
  assert.match(local.guidance, /required post-edit control-flow audit/i);
  assert.equal(controller.verificationReadAllowed, false);

  const compile = controller.after(
    { type: 'run_terminal', command: 'npm run compile' },
    '[run_terminal: npm run compile]\nExit: 0'
  );
  assert.equal(controller.verificationPending, true);
  assert.match(compile, /behavior-level test/i);

  const verified = controller.after(
    { type: 'run_terminal', command: 'npm test' },
    '[run_terminal: npm test]\nExit: 0\nall good'
  );
  assert.equal(controller.verificationPending, false);
  assert.match(verified, /acceptance gate is satisfied/i);
});

test('verification dependency reads stay available without changing mutation focus', () => {
  const controller = new ExplorationController();
  controller.after(
    { type: 'edit_file', filepath: 'src/a.ts', oldStr: 'a', newStr: 'b' },
    '[edit_file: src/a.ts] Edit applied successfully.\n\n[Local invariant audit]\n- done'
  );

  const sibling = controller.before({ type: 'read_file', filepath: 'src/b.ts' }, false);
  assert.equal(sibling.block, undefined);
  assert.match(sibling.guidance, /do not mutate sibling implementations/i);
  assert.equal(controller.verificationPending, true);
});

test('Ask mode remains unconstrained', () => {
  const controller = new ExplorationController();
  for (let i = 0; i < 20; i++) {
    const check = controller.before({ type: 'read_file', filepath: 'src/a.ts' }, true);
    assert.equal(check.block, undefined);
    assert.equal(check.isExploration, false);
  }
});
