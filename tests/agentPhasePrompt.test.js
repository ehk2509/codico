const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTION_PHASE_SYSTEM_PROMPT,
  FOCUSED_ACTION_SYSTEM_PROMPT,
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

test('post-edit phase keeps mutation local and requires behavioral evidence', () => {
  assert.match(POST_EDIT_VERIFICATION_PROMPT, /Local invariant audit/);
  assert.match(POST_EDIT_VERIFICATION_PROMPT, /semantic-completion candidates as explicit proof obligations/i);
  assert.match(POST_EDIT_VERIFICATION_PROMPT, /normal success, completion, terminal, cancellation/i);
  assert.match(POST_EDIT_VERIFICATION_PROMPT, /do not mutate siblings/i);
  assert.match(POST_EDIT_VERIFICATION_PROMPT, /behavior-level test-like command/i);

  const first = systemPromptForAgentPhase(false, true, true, 'src/openRouterClient.ts', '', true);
  assert.match(first, /re-read the edited control flow once/i);
  assert.doesNotMatch(first, /act on the evidence/i);
  assert.match(first, /src\/openRouterClient\.ts/);

  const afterRead = systemPromptForAgentPhase(false, false, true, 'src/openRouterClient.ts', '', false);
  assert.match(afterRead, /post-edit control-flow read is complete/i);
  assert.match(afterRead, /behavior-level test next/i);
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
  const beforeAudit = systemPromptForAgentPhase(false, false, true, 'src/openRouterClient.ts', contract, true);
  const afterAudit = systemPromptForAgentPhase(false, false, true, 'src/openRouterClient.ts', contract, false);

  assert.match(beforeAudit, /Keep normal completed streams unchanged/);
  assert.match(afterAudit, /Keep normal completed streams unchanged/);
  assert.match(beforeAudit, /re-read the edited control flow once/i);
  assert.match(afterAudit, /post-edit control-flow read is complete/i);
  assert.match(afterAudit, /behavior-level test next/i);
  assert.doesNotMatch(beforeAudit, /read budget is exhausted/i);
  assert.doesNotMatch(afterAudit, /read budget is exhausted/i);
});


test('focused action forbids broad and terminal discovery but permits one bounded read', () => {
  assert.match(FOCUSED_ACTION_SYSTEM_PROMPT, /Discovery tools are no longer available|Broad repository discovery is complete/i);
  assert.match(FOCUSED_ACTION_SYSTEM_PROMPT, /source-inspection shell commands/i);
  assert.match(FOCUSED_ACTION_SYSTEM_PROMPT, /bounded read_file/i);
  assert.match(FOCUSED_ACTION_SYSTEM_PROMPT, /edit_file or write_file/i);

  const prompt = systemPromptForAgentPhase(false, true, false, undefined, '', true, true);
  assert.match(prompt, /focused action/i);
  assert.match(prompt, /Do not use terminal commands to recover source context/i);
  assert.doesNotMatch(prompt, /Discovery tools remain available/);
});
