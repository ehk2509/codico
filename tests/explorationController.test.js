const test = require('node:test');
const assert = require('node:assert/strict');
const { ExplorationController } = require('../out/explorationController.js');

test('controller transitions from broad action escape to focused ranged reads', () => {
  const controller = new ExplorationController();

  for (let i = 0; i < 10; i++) {
    controller.beginIteration();
    const check = controller.before({ type: 'search_files', pattern: 'p' + i, isRegex: false }, false);
    assert.equal(check.block, undefined);
  }

  assert.equal(controller.locked, true);
  controller.beginIteration();
  const unbounded = controller.before({ type: 'read_file', filepath: 'src/a.ts' }, false);
  assert.match(unbounded.block, /Broad discovery is now closed|Broad reads are closed/i);
  assert.equal(controller.focusedAction, true);

  const ranged = controller.before(
    { type: 'read_file', filepath: 'src/a.ts', startLine: 100, endLine: 180 },
    false,
  );
  assert.equal(ranged.block, undefined);
  assert.match(ranged.guidance, /bounded range|exact edit context/i);
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


test('action phase allows four broad escape turns before focused action', () => {
  const controller = new ExplorationController();
  for (let i = 0; i < 6; i++) {
    controller.beginIteration();
    controller.before({ type: 'search_files', pattern: 'p' + i, isRegex: false }, false);
  }
  assert.equal(controller.locked, true);

  const allowed = [];
  for (let i = 0; i < 4; i++) {
    controller.beginIteration();
    allowed.push(controller.before({ type: 'read_file', filepath: 'src/' + i + '.ts' }, false));
  }
  controller.beginIteration();
  const blocked = controller.before({ type: 'search_files', pattern: 'more', isRegex: false }, false);

  for (const check of allowed) { assert.equal(check.block, undefined); }
  assert.match(blocked.block, /Broad discovery is now closed/i);
  assert.equal(controller.focusedAction, true);

  const ranged = controller.before(
    { type: 'read_file', filepath: 'src/agentProvider.ts', startLine: 1100, endLine: 1250 },
    false,
  );
  assert.equal(ranged.block, undefined);
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

test('focused action blocks terminal cat/grep bypasses while allowing ranged reads', () => {
  const controller = new ExplorationController();
  for (let i = 0; i < 6; i++) {
    controller.beginIteration();
    controller.before({ type: 'search_files', pattern: 'p' + i, isRegex: false }, false);
  }
  for (let i = 0; i < 4; i++) {
    controller.beginIteration();
    controller.before({ type: 'read_file', filepath: 'src/' + i + '.ts' }, false);
  }
  controller.beginIteration();
  const blocked = controller.before({ type: 'read_file', filepath: 'src/c.ts' }, false);
  assert.match(blocked.block, /Broad discovery is now closed|Broad reads are closed/i);
  const ranged = controller.before(
    { type: 'read_file', filepath: 'src/c.ts', startLine: 50, endLine: 100 },
    false,
  );
  assert.equal(ranged.block, undefined);
  assert.equal(controller.blocksTerminal({ type: 'run_terminal', command: 'grep -rn foo src/' }), true);
  assert.equal(controller.blocksTerminal({ type: 'run_terminal', command: 'npm test' }), false);
});


test('focused action closes broad discovery but preserves explicit source ranges', () => {
  const controller = new ExplorationController();
  for (let i = 0; i < 6; i++) {
    controller.beginIteration();
    controller.before({ type: 'search_files', pattern: 'p' + i, isRegex: false }, false);
  }

  for (let i = 0; i < 4; i++) {
    controller.beginIteration();
    controller.before({ type: 'search_files', pattern: 'escape-' + i, isRegex: false }, false);
  }

  controller.beginIteration();
  const transition = controller.before(
    { type: 'read_file', filepath: 'src/agentProvider.ts', startLine: 900, endLine: 1100 },
    false,
  );
  assert.equal(controller.focusedAction, true);
  assert.equal(transition.block, undefined);
  assert.match(transition.guidance, /bounded range/i);

  controller.beginIteration();
  const broad = controller.before({ type: 'search_files', pattern: 'resume', isRegex: false }, false);
  assert.match(broad.block, /Broad discovery is closed/i);

  const wholeFile = controller.before({ type: 'read_file', filepath: 'src/agentProvider.ts' }, false);
  assert.match(wholeFile.block, /Broad reads are closed/i);

  const ranged = controller.before(
    { type: 'read_file', filepath: 'src/agentProvider.ts', startLine: 1101, endLine: 1300 },
    false,
  );
  assert.equal(ranged.block, undefined);
  assert.match(ranged.guidance, /exact edit context/i);

  assert.equal(controller.blocksTerminal({ type: 'run_terminal', command: 'grep -n resume src/agentProvider.ts' }), true);
  assert.equal(controller.before(
    { type: 'edit_file', filepath: 'src/agentProvider.ts', oldStr: 'a', newStr: 'b' },
    false,
  ).isExploration, false);
});


test('focused action permits two ranged-read turns then requires mutation', () => {
  const controller = new ExplorationController(
    'Fix the stream seam and add a general overlap calculation.'
  );

  for (let i = 0; i < 6; i++) {
    controller.beginIteration();
    controller.before({ type: 'search_files', pattern: 'p' + i, isRegex: false }, false);
  }
  for (let i = 0; i < 4; i++) {
    controller.beginIteration();
    controller.before({ type: 'read_file', filepath: 'src/' + i + '.ts' }, false);
  }

  controller.beginIteration();
  const first = controller.before(
    { type: 'read_file', filepath: 'src/agentProvider.ts', startLine: 900, endLine: 1100 },
    false,
  );
  assert.equal(controller.focusedAction, true);
  assert.equal(first.block, undefined);
  assert.equal(controller.focusedReadExhausted, false);

  controller.beginIteration();
  const second = controller.before(
    { type: 'read_file', filepath: 'src/agentProvider.ts', startLine: 1101, endLine: 1250 },
    false,
  );
  assert.equal(second.block, undefined);
  assert.equal(controller.focusedReadExhausted, true);
  assert.match(second.guidance, /final bounded source-read turn/i);

  controller.beginIteration();
  const third = controller.before(
    { type: 'read_file', filepath: 'src/agentProvider.ts', startLine: 1251, endLine: 1350 },
    false,
  );
  assert.match(third.block, /two focused source-read turns are exhausted/i);
  assert.match(controller.completionGuidance(), /no mutation has succeeded/i);
});

test('focused action does not force a mutation for explanation-only requests', () => {
  const controller = new ExplorationController('Explain how the stream recovery flow works.');
  for (let i = 0; i < 6; i++) {
    controller.beginIteration();
    controller.before({ type: 'search_files', pattern: 'p' + i, isRegex: false }, false);
  }
  for (let i = 0; i < 5; i++) {
    controller.beginIteration();
    controller.before(
      i === 4
        ? { type: 'read_file', filepath: 'src/a.ts', startLine: 1, endLine: 20 }
        : { type: 'search_files', pattern: 'e' + i, isRegex: false },
      false,
    );
  }
  assert.equal(controller.focusedAction, true);
  assert.equal(controller.completionGuidance(), undefined);
});


test('mutation grace activates only after focused reads are exhausted for coding work', () => {
  const controller = new ExplorationController('Fix the bug and update the implementation.');

  for (let i = 0; i < 6; i++) {
    controller.beginIteration();
    controller.before({ type: 'search_files', pattern: 'p' + i, isRegex: false }, false);
  }
  for (let i = 0; i < 4; i++) {
    controller.beginIteration();
    controller.before({ type: 'read_file', filepath: 'src/' + i + '.ts' }, false);
  }

  controller.beginIteration();
  controller.before(
    { type: 'read_file', filepath: 'src/target.ts', startLine: 1, endLine: 80 },
    false,
  );
  assert.equal(controller.mutationGracePending, false);

  controller.beginIteration();
  controller.before(
    { type: 'read_file', filepath: 'src/target.ts', startLine: 81, endLine: 160 },
    false,
  );
  assert.equal(controller.focusedReadExhausted, true);
  assert.equal(controller.mutationGracePending, true);

  controller.after(
    { type: 'edit_file', filepath: 'src/target.ts', oldStr: 'before', newStr: 'after' },
    '[edit_file: src/target.ts] Edit applied successfully.'
  );
  assert.equal(controller.mutationGracePending, false);
  assert.equal(controller.verificationPending, true);
});

test('explanation-only focused work never receives mutation grace', () => {
  const controller = new ExplorationController('Explain the implementation and summarize the flow.');

  for (let i = 0; i < 6; i++) {
    controller.beginIteration();
    controller.before({ type: 'search_files', pattern: 'p' + i, isRegex: false }, false);
  }
  for (let i = 0; i < 4; i++) {
    controller.beginIteration();
    controller.before({ type: 'read_file', filepath: 'src/' + i + '.ts' }, false);
  }
  controller.beginIteration();
  controller.before(
    { type: 'read_file', filepath: 'src/target.ts', startLine: 1, endLine: 80 },
    false,
  );
  controller.beginIteration();
  controller.before(
    { type: 'read_file', filepath: 'src/target.ts', startLine: 81, endLine: 160 },
    false,
  );

  assert.equal(controller.focusedReadExhausted, true);
  assert.equal(controller.mutationGracePending, false);
});


test('finite coding budgets reserve their second half for focused action', () => {
  const controller = new ExplorationController('Fix the runtime bug.', 16);

  for (let turn = 1; turn <= 6; turn++) {
    controller.beginIteration();
    controller.before({ type: 'search_files', pattern: 'p' + turn, isRegex: false }, false);
  }
  assert.equal(controller.locked, true);
  assert.equal(controller.focusedAction, false);

  controller.beginIteration(); // 7
  assert.equal(controller.focusedAction, false);
  controller.before({ type: 'read_file', filepath: 'src/a.ts' }, false);

  controller.beginIteration(); // 8
  assert.equal(controller.focusedAction, false);
  controller.before({ type: 'read_file', filepath: 'src/b.ts' }, false);

  controller.beginIteration(); // 9 > half of 16
  assert.equal(controller.focusedAction, true);
});

test('budget-aware focus does not force explanation-only or unlimited tasks', () => {
  const explanation = new ExplorationController('Explain how this works.', 16);
  for (let turn = 1; turn <= 10; turn++) {
    explanation.beginIteration();
    explanation.before({ type: 'search_files', pattern: 'e' + turn, isRegex: false }, false);
  }
  assert.equal(explanation.focusedAction, false);

  const unlimited = new ExplorationController('Fix the runtime bug.', 0);
  for (let turn = 1; turn <= 10; turn++) {
    unlimited.beginIteration();
    unlimited.before({ type: 'search_files', pattern: 'u' + turn, isRegex: false }, false);
  }
  assert.equal(unlimited.locked, true);
  assert.equal(unlimited.focusedAction, false);
});


test('successful edits expose their model turn for progress-aware verification grace', () => {
  const controller = new ExplorationController('Fix the implementation.');
  controller.beginIteration();
  controller.beginIteration();
  controller.beginIteration();
  controller.after(
    { type: 'edit_file', filepath: 'src/a.ts', oldStr: 'before', newStr: 'after' },
    '[edit_file: src/a.ts] Edit applied successfully.'
  );
  assert.equal(controller.lastMutationIteration, 3);

  controller.beginIteration();
  controller.after(
    { type: 'edit_file', filepath: 'src/a.ts', oldStr: 'after', newStr: 'final' },
    '[edit_file: src/a.ts] Edit applied successfully.'
  );
  assert.equal(controller.lastMutationIteration, 4);
});
