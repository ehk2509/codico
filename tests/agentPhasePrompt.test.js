const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTION_PHASE_SYSTEM_PROMPT,
  POST_EDIT_VERIFICATION_PROMPT,
  systemPromptForAgentPhase,
} = require('../out/agentPhasePrompt.js');

test('action phase is strong guidance layered on the normal tool contract', () => {
  assert.match(ACTION_PHASE_SYSTEM_PROMPT, /act on the evidence/i);
  assert.match(ACTION_PHASE_SYSTEM_PROMPT, /next response should make the smallest evidence-backed code change/i);
  assert.match(ACTION_PHASE_SYSTEM_PROMPT, /Discovery tools remain available/i);

  const prompt = systemPromptForAgentPhase(false, true, false);
  assert.match(prompt, /Invoke tools using these exact fenced-code-block formats/i);
  assert.match(prompt, /act on the evidence/i);
  assert.match(prompt, /read_file/);
  assert.match(prompt, /edit_file/);
});

test('post-edit phase verifies acceptance while allowing targeted dependencies', () => {
  assert.match(POST_EDIT_VERIFICATION_PROMPT, /Local invariant audit/);
  assert.match(POST_EDIT_VERIFICATION_PROMPT, /normal success, completion, terminal, cancellation/i);
  assert.match(POST_EDIT_VERIFICATION_PROMPT, /callers, consumers, shared abstractions, sibling implementations/i);
  assert.match(POST_EDIT_VERIFICATION_PROMPT, /Discovery remains available/i);

  const prompt = systemPromptForAgentPhase(false, true, true, 'src/openRouterClient.ts');
  assert.match(prompt, /satisfy the acceptance contract/i);
  assert.doesNotMatch(prompt, /act on the evidence/i);
  assert.match(prompt, /src\/openRouterClient\.ts/);
});

test('Ask mode remains read-only even when autonomous phase flags are set', () => {
  const prompt = systemPromptForAgentPhase(true, true, true);
  assert.match(prompt, /Tools \(read-only\)/i);
  assert.match(prompt, /Do NOT emit write_file, edit_file, run_terminal/i);
  assert.match(prompt, /```read_file/);
  assert.doesNotMatch(prompt, /```write_file/);
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
