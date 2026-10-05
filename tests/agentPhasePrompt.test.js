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

test('post-edit phase requires verification and downstream consumer follow-through', () => {
  assert.match(POST_EDIT_VERIFICATION_PROMPT, /narrowest relevant test/i);
  assert.match(POST_EDIT_VERIFICATION_PROMPT, /downstream consumer\/caller/i);
  const prompt = systemPromptForAgentPhase(false, false, true);
  assert.match(prompt, /read_file/);
  assert.match(prompt, /verify the change/i);
  assert.match(prompt, /downstream consumer\/caller/i);
});

test('Ask mode remains read-only even when autonomous phase flags are set', () => {
  const prompt = systemPromptForAgentPhase(true, true, true);
  assert.match(prompt, /read-only Ask mode/i);
  assert.doesNotMatch(prompt, /```edit_file/);
});
