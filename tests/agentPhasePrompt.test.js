const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTION_PHASE_SYSTEM_PROMPT,
  POST_EDIT_VERIFICATION_PROMPT,
  systemPromptForAgentPhase,
} = require('../out/agentPhasePrompt.js');

test('action phase prefers implementation without closing discovery', () => {
  assert.match(ACTION_PHASE_SYSTEM_PROMPT, /prefer action, preserve correctness/i);
  assert.match(ACTION_PHASE_SYSTEM_PROMPT, /Discovery remains available/i);
  assert.match(ACTION_PHASE_SYSTEM_PROMPT, /abstraction that owns the behavior/i);
  assert.doesNotMatch(ACTION_PHASE_SYSTEM_PROMPT, /Discovery is closed/i);

  const prompt = systemPromptForAgentPhase(false, true, false);
  assert.equal(prompt, ACTION_PHASE_SYSTEM_PROMPT);
});

test('post-edit phase verifies acceptance while allowing targeted dependencies', () => {
  assert.match(POST_EDIT_VERIFICATION_PROMPT, /Local invariant audit/);
  assert.match(POST_EDIT_VERIFICATION_PROMPT, /normal success, completion, terminal, cancellation/i);
  assert.match(POST_EDIT_VERIFICATION_PROMPT, /callers, consumers, shared abstractions, sibling implementations/i);
  assert.match(POST_EDIT_VERIFICATION_PROMPT, /Discovery remains available/i);

  const prompt = systemPromptForAgentPhase(false, false, true, 'src/openRouterClient.ts');
  assert.match(prompt, /satisfy the acceptance contract/i);
  assert.match(prompt, /src\/openRouterClient\.ts/);
  assert.doesNotMatch(prompt, /read budget is exhausted/i);
});

test('Ask mode remains read-only even when autonomous phase flags are set', () => {
  const prompt = systemPromptForAgentPhase(true, true, true);
  assert.match(prompt, /read-only Ask mode/i);
  assert.doesNotMatch(prompt, /edit_file/);
});

test('verification prompt carries the acceptance contract without arbitrary read limits', () => {
  const contract = '## Task acceptance contract\nKeep normal completed streams unchanged.';
  const allowed = systemPromptForAgentPhase(false, false, true, 'src/openRouterClient.ts', contract, true);
  const formerlyExhausted = systemPromptForAgentPhase(false, false, true, 'src/openRouterClient.ts', contract, false);

  assert.match(allowed, /Keep normal completed streams unchanged/);
  assert.match(allowed, /Discovery remains available/i);
  assert.equal(formerlyExhausted, allowed);
  assert.doesNotMatch(allowed, /read budget is exhausted/i);
});
