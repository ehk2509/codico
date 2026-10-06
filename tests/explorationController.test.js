const test = require('node:test');
const assert = require('node:assert/strict');
const { ExplorationController } = require('../out/explorationController.js');

test('controller enters action phase with two discovery escape hatches', () => {
  const controller = new ExplorationController();
  let last;

  for (let i = 0; i < 8; i++) {
    controller.beginIteration();
    last = controller.before({ type: 'search_files', pattern: 'p' + i, isRegex: false }, false);
    assert.equal(last.block, undefined);
  }

  assert.equal(controller.locked, true);
  controller.beginIteration();
  const thirdAfterLock = controller.before({ type: 'read_file', filepath: 'src/a.ts' }, false);
  assert.match(thirdAfterLock.block, /exploration is closed/i);
  assert.equal(controller.blocksTerminal({ type: 'run_terminal', command: 'cat src/a.ts' }), true);
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


test('unwired import blocks completion even after clean diagnostics and a passing test', () => {
  const controller = new ExplorationController('Wire the new helper into the actual call site');
  const tool = { type: 'edit_file', filepath: 'src/consumer.ts', oldStr: 'old', newStr: 'new' };
  const first = controller.after(tool,
    "[edit_file: src/consumer.ts] Edit applied successfully.\n\n[Post-edit integration audit]\n- dedupe from ./helpers");
  assert.match(first, /imported helper is not implemented/i);
  assert.match(controller.completionGuidance(), /unreferenced local import/i);
  assert.equal(controller.verificationPending, true);

  const diagnostics = controller.after(
    { type: 'get_diagnostics', filepath: 'src/consumer.ts' }, '[get_diagnostics] No diagnostics.');
  assert.match(diagnostics, /cannot prove/i);
  const terminal = controller.after(
    { type: 'run_terminal', command: 'npm test' }, '[run_terminal]\nExit: 0');
  assert.match(terminal, /cannot close the acceptance gate/i);
  assert.equal(controller.verificationPending, true);

  controller.after(tool, '[edit_file: src/consumer.ts] Edit applied successfully.');
  assert.doesNotMatch(controller.completionGuidance(), /unreferenced local import/i);
  controller.after({ type: 'run_terminal', command: 'npm test' }, '[run_terminal]\nExit: 0');
  assert.equal(controller.verificationPending, false);
});

test('unapplied and denied edits do not start verification', () => {
  const controller = new ExplorationController();
  const result = controller.after(
    { type: 'edit_file', filepath: 'src/a.ts', oldStr: 'x', newStr: 'y' },
    '[edit_file: src/a.ts] ERROR: oldStr not found');
  assert.match(result, /was not applied/i);
  assert.equal(controller.verificationPending, false);
});

test('unwired imports in another edited file remain pending', () => {
  const controller = new ExplorationController();
  controller.after({ type: 'edit_file', filepath: 'src/a.ts', oldStr: 'a', newStr: 'b' },
    '[edit_file: src/a.ts] Edit applied successfully.\n\n[Post-edit integration audit]\n- helper from ./helpers');
  controller.after({ type: 'edit_file', filepath: 'src/b.ts', oldStr: 'a', newStr: 'b' },
    '[edit_file: src/b.ts] Edit applied successfully.');
  assert.match(controller.completionGuidance(), /src\/a\.ts/);
});


test('unwired helper is injected into every verification system prompt and tool policy', () => {
  const controller = new ExplorationController('Use the helper in the actual caller.');
  controller.after(
    { type: 'edit_file', filepath: 'src/consumer.ts', oldStr: 'old', newStr: 'new' },
    '[edit_file: src/consumer.ts] Edit applied successfully.\n\n[Post-edit integration audit]\n- dedupe from ./helpers'
  );

  const prompt = controller.systemPrompt(false);
  assert.match(prompt, /Blocking integration issue/);
  assert.match(prompt, /src\/consumer\.ts/);

  const tools = controller.nativeTools(require('../out/nativeTools.js').getNativeToolDefinitions(false));
  assert.equal(tools[0].name, 'edit_file');

  const search = controller.before({ type: 'search_files', pattern: 'anything', isRegex: false }, false);
  assert.match(search.block, /Broad discovery is blocked/i);
});


test('action phase allows only two targeted exploration escape hatches before requiring an edit', () => {
  const controller = new ExplorationController();
  for (let i = 0; i < 6; i++) {
    controller.beginIteration();
    controller.before({ type: 'search_files', pattern: 'p' + i, isRegex: false }, false);
  }
  assert.equal(controller.locked, true);

  controller.beginIteration();
  const first = controller.before({ type: 'read_file', filepath: 'src/a.ts' }, false);
  controller.beginIteration();
  const second = controller.before({ type: 'read_file', filepath: 'src/b.ts' }, false);
  controller.beginIteration();
  const third = controller.before({ type: 'search_files', pattern: 'more', isRegex: false }, false);

  assert.equal(first.block, undefined);
  assert.equal(second.block, undefined);
  assert.match(third.block, /exploration is closed/i);
});

test('unwired helper gets one recovery read and then must be edited', () => {
  const controller = new ExplorationController('Wire the helper.');
  controller.after(
    { type: 'edit_file', filepath: 'src/consumer.ts', oldStr: 'old', newStr: 'new' },
    '[edit_file: src/consumer.ts] Edit applied successfully.\n\n[Post-edit integration audit]\n- dedupe from ./helpers'
  );

  controller.beginIteration();
  const first = controller.before({ type: 'read_file', filepath: 'src/consumer.ts' }, false);
  controller.beginIteration();
  const second = controller.before({ type: 'read_file', filepath: 'src/consumer.ts' }, false);
  const search = controller.before({ type: 'search_files', pattern: 'dedupe', isRegex: false }, false);

  assert.equal(first.block, undefined);
  assert.match(second.block, /already used the one targeted recovery read/i);
  assert.match(search.block, /Broad discovery is blocked/i);

  controller.after(
    { type: 'edit_file', filepath: 'src/consumer.ts', oldStr: 'before', newStr: 'after' },
    '[edit_file: src/consumer.ts] Edit applied successfully.'
  );
  const afterFix = controller.before({ type: 'read_file', filepath: 'src/consumer.ts' }, false);
  assert.equal(afterFix.block, undefined);
});


test('batched exploration calls in one model turn consume one exploration iteration', () => {
  const controller = new ExplorationController();

  for (let turn = 1; turn <= 5; turn++) {
    controller.beginIteration();
    for (let call = 0; call < 4; call++) {
      const check = controller.before(
        { type: 'search_files', pattern: 'turn-' + turn + '-call-' + call, isRegex: false },
        false,
      );
      assert.equal(check.block, undefined);
    }
    assert.equal(controller.locked, false);
  }

  controller.beginIteration();
  const first = controller.before({ type: 'search_files', pattern: 'sixth-turn-a', isRegex: false }, false);
  const second = controller.before({ type: 'search_files', pattern: 'sixth-turn-b', isRegex: false }, false);
  assert.equal(controller.locked, true);
  assert.equal(first.block, undefined);
  assert.equal(second.block, undefined);
});

test('closed action exploration also blocks terminal cat/grep bypasses', () => {
  const controller = new ExplorationController();
  for (let i = 0; i < 6; i++) {
    controller.beginIteration();
    controller.before({ type: 'search_files', pattern: 'p' + i, isRegex: false }, false);
  }
  controller.beginIteration();
  controller.before({ type: 'read_file', filepath: 'src/a.ts' }, false);
  controller.beginIteration();
  controller.before({ type: 'read_file', filepath: 'src/b.ts' }, false);
  controller.beginIteration();
  const blocked = controller.before({ type: 'read_file', filepath: 'src/c.ts' }, false);
  assert.match(blocked.block, /exploration is closed/i);
  assert.equal(controller.blocksTerminal({ type: 'run_terminal', command: 'grep -rn foo src/' }), true);
  assert.equal(controller.blocksTerminal({ type: 'run_terminal', command: 'npm test' }), false);
});
