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

  const followThrough = controller.after({ type: 'edit_file', filepath: 'a.ts', oldStr: 'x', newStr: 'y' });
  assert.equal(controller.locked, false);
  assert.equal(controller.verificationPending, true);
  assert.match(followThrough, /downstream consumer\/caller/i);
  assert.match(followThrough, /narrowest relevant test/i);

  const ask = new ExplorationController();
  for (let i = 0; i < 20; i++) {
    const check = ask.before({ type: 'read_file', filepath: 'src/a.ts' }, true);
    assert.equal(check.isExploration, false);
    assert.equal(check.block, undefined);
  }
});
