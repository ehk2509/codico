const test = require('node:test');
const assert = require('node:assert/strict');

const { ExplorationController } = require('../out/explorationController.js');

test('controller locks discovery after the turn exploration budget', () => {
  const controller = new ExplorationController();
  for (let i = 0; i < 11; i++) {
    const check = controller.before({
      type: 'search_files',
      pattern: 'p' + i,
      isRegex: false,
    }, false);
    assert.equal(check.block, undefined);
  }

  const locked = controller.before({
    type: 'search_files',
    pattern: 'p11',
    isRegex: false,
  }, false);
  assert.match(locked.block, /discovery tools are now disabled/i);
  assert.equal(controller.locked, true);

  const stillLocked = controller.before({ type: 'read_file', filepath: 'src/a.ts' }, false);
  assert.match(stillLocked.block, /remain disabled/i);

  const diagnostics = controller.before({ type: 'get_diagnostics' }, false);
  assert.equal(diagnostics.isExploration, false);
  assert.equal(diagnostics.block, undefined);
});

test('controller resets after mutation and does not constrain Ask mode', () => {
  const controller = new ExplorationController();
  for (let i = 0; i < 12; i++) {
    controller.before({ type: 'search_files', pattern: 'q' + i, isRegex: false }, false);
  }
  assert.equal(controller.locked, true);
  assert.equal(controller.blocksTerminal({ type: 'run_terminal', command: "grep -rn foo src/" }), true);
  assert.equal(controller.blocksTerminal({ type: 'run_terminal', command: 'npm test' }), false);

  const followThrough = controller.after(
    { type: 'edit_file', filepath: 'a.ts', oldStr: 'x', newStr: 'y' },
    '[edit_file: a.ts] Edit applied successfully.\n\n[Local invariant audit]\n- L1: finishReason',
  );
  assert.equal(controller.locked, false);
  assert.equal(controller.verificationPending, true);
  assert.equal(controller.verificationFile, 'a.ts');
  assert.match(followThrough, /attached Local invariant audit/i);

  const sibling = controller.before({ type: 'read_file', filepath: 'b.ts' }, false);
  assert.match(sibling.block, /local verification is active/i);
  const local = controller.before({ type: 'read_file', filepath: 'a.ts' }, false);
  assert.equal(local.block, undefined);
  assert.match(local.guidance, /normal success, completion, or terminal path/i);
  assert.equal(controller.before({ type: 'read_file', filepath: 'a.ts' }, false).block, undefined);
  assert.match(controller.before({ type: 'read_file', filepath: 'a.ts' }, false).block, /already re-read/i);
  assert.equal(controller.blocksTerminal({ type: 'run_terminal', command: 'cat a.ts' }), true);

  const verified = controller.after(
    { type: 'run_terminal', command: 'npm test' },
    '[run_terminal: npm test]\nExit: 0\nall good',
  );
  assert.equal(controller.verificationPending, false);
  assert.equal(controller.verificationFile, undefined);
  assert.match(verified, /broader follow-through is available/i);

  const ask = new ExplorationController();
  for (let i = 0; i < 20; i++) {
    const check = ask.before({ type: 'read_file', filepath: 'src/a.ts' }, true);
    assert.equal(check.isExploration, false);
    assert.equal(check.block, undefined);
  }
});


test('post-edit verification allows one local reread then forces revision or verification', () => {
  const controller = new ExplorationController(
    'Fix premature EOF handling. Keep normal completed streams unchanged.'
  );
  controller.after({ type: 'edit_file', filepath: 'src/openRouterClient.ts', oldStr: 'a', newStr: 'b' });

  assert.equal(controller.verificationReadAllowed, true);
  const first = controller.before({ type: 'read_file', filepath: 'src/openRouterClient.ts' }, false);
  assert.equal(first.block, undefined);
  assert.match(first.guidance, /one post-edit audit read/i);
  assert.match(first.guidance, /preservation\/negative constraint/i);
  assert.equal(controller.verificationReadAllowed, false);

  const second = controller.before({ type: 'read_file', filepath: 'src/openRouterClient.ts' }, false);
  assert.match(second.block, /read budget is exhausted/i);

  const prompt = controller.systemPrompt(false);
  assert.match(prompt, /Keep normal completed streams unchanged/);
  assert.match(prompt, /read budget is exhausted/i);
});
