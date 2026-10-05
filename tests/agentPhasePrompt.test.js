const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTION_PHASE_SYSTEM_PROMPT,
  POST_EDIT_VERIFICATION_PROMPT,
  systemPromptForAgentPhase,
} = require('../out/agentPhasePrompt.js');

test('action phase stops advertising discovery tools to fenced-tool fallbacks', () => {
  assert.match(ACTION_PHASE_SYSTEM_PROMPT, /```edit_file/);
  assert.match(ACTION_PHASE_SYSTEM_PROMPT, /```write_file/);
  assert.match(ACTION_PHASE_SYSTEM_PROMPT, /```run_terminal/);
  assert.doesNotMatch(ACTION_PHASE_SYSTEM_PROMPT, /```read_file/);
  assert.doesNotMatch(ACTION_PHASE_SYSTEM_PROMPT, /```search_files/);
  assert.doesNotMatch(ACTION_PHASE_SYSTEM_PROMPT, /```list_directory/);

  const prompt = systemPromptForAgentPhase(false, true, false);
  assert.equal(prompt, ACTION_PHASE_SYSTEM_PROMPT);
});

test('post-edit phase requires a local invariant audit before broadening', () => {
  assert.match(POST_EDIT_VERIFICATION_PROMPT, /Local invariant audit/);
  assert.match(POST_EDIT_VERIFICATION_PROMPT, /normal success, completion, terminal/i);
  assert.match(POST_EDIT_VERIFICATION_PROMPT, /does not conflate two different lifecycle states/i);
  const prompt = systemPromptForAgentPhase(false, false, true, 'src/openRouterClient.ts');
  assert.match(prompt, /verify the local invariant/i);
  assert.match(prompt, /src\/openRouterClient\.ts/);
  assert.match(prompt, /re-read the edited file once/i);
});

test('Ask mode remains read-only even when autonomous phase flags are set', () => {
  const prompt = systemPromptForAgentPhase(true, true, true);
  assert.match(prompt, /read-only Ask mode/i);
  assert.doesNotMatch(prompt, /```edit_file/);
});


test('verification prompt carries the original acceptance contract and enforces the read budget', () => {
  const contract = '## Task acceptance contract\nKeep normal completed streams unchanged.';
  const first = systemPromptForAgentPhase(false, false, true, 'src/openRouterClient.ts', contract, true);
  assert.match(first, /Keep normal completed streams unchanged/);
  assert.match(first, /re-read the edited file once/i);

  const exhausted = systemPromptForAgentPhase(false, false, true, 'src/openRouterClient.ts', contract, false);
  assert.match(exhausted, /read budget is exhausted/i);
  assert.match(exhausted, /test\/build\/diagnostics/i);
});
