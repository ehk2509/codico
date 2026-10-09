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


test('focused action permits exact-file locating plus bounded source reads', () => {
  assert.match(FOCUSED_ACTION_SYSTEM_PROMPT, /Broad repository discovery is complete/i);
  assert.match(FOCUSED_ACTION_SYSTEM_PROMPT, /source-inspection shell commands/i);
  assert.match(FOCUSED_ACTION_SYSTEM_PROMPT, /search_files is allowed only when glob is exactly one file/i);
  assert.match(FOCUSED_ACTION_SYSTEM_PROMPT, /read_file is allowed only with explicit start_line\/end_line/i);
  assert.match(FOCUSED_ACTION_SYSTEM_PROMPT, /edit_file or write_file/i);

  const prompt = systemPromptForAgentPhase(false, true, false, undefined, '', true, true);
  assert.match(prompt, /focused action/i);
  assert.match(prompt, /exact-file locator/i);
  assert.match(prompt, /Do not use terminal commands to recover source context/i);
  assert.doesNotMatch(prompt, /Discovery tools remain available/);
});


test('mutation-only phase removes discovery tool affordances from the compatibility prompt', () => {
  const prompt = systemPromptForAgentPhase(
    false,
    true,
    false,
    undefined,
    '## Task acceptance contract\nFix the bug.',
    true,
    true,
    true,
  );

  assert.match(prompt, /mutation required/i);
  assert.match(prompt, /```edit_file/);
  assert.match(prompt, /```write_file/);
  assert.match(prompt, /```run_terminal/);
  assert.match(prompt, /```get_diagnostics/);

  assert.doesNotMatch(prompt, /```read_file/);
  assert.doesNotMatch(prompt, /```search_files/);
  assert.doesNotMatch(prompt, /```find_files/);
  assert.doesNotMatch(prompt, /```list_directory/);
  assert.doesNotMatch(prompt, /Explore narrowly before editing/i);
  assert.match(prompt, /Only the four tools listed above are valid/i);
});

test('phase guidance is split off so the system prompt stays the same for the whole task', () => {
  const { splitPhasePrompt, systemPromptForAgentPhase } = require('../out/agentPhasePrompt.js');
  const { SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT } = require('../out/openRouterClient.js');
  const verifying = splitPhasePrompt(systemPromptForAgentPhase(false, false, true, 'src/a.ts'));
  assert.equal(verifying.systemPrompt, undefined, 'the default system prompt is used');
  assert.match(verifying.phaseNote, /Edited file: `src\/a\.ts`/);
  assert.ok(!verifying.phaseNote.includes(SYSTEM_PROMPT.slice(0, 200)));
  const acting = splitPhasePrompt(systemPromptForAgentPhase(false, true, false));
  assert.equal(acting.systemPrompt, undefined);
  assert.match(acting.phaseNote, /Current phase/);
  assert.deepEqual(splitPhasePrompt(undefined), { systemPrompt: undefined, phaseNote: '' });
  // Ask mode keeps its own (fixed) system prompt
  assert.deepEqual(splitPhasePrompt(CHAT_SYSTEM_PROMPT), { systemPrompt: CHAT_SYSTEM_PROMPT, phaseNote: '' });
});

test('a phase change is added to the conversation without changing earlier messages', () => {
  const { appendPhaseNote } = require('../out/agentPhasePrompt.js');
  const sent = { role: 'assistant', content: '', nativeToolCalls: [{ id: 'c1', name: 'edit_file', arguments: {} }] };
  // Native tools: the newest message is a tool result, so the note is a new user message
  const native = [{ role: 'user', content: 'fix it' }, sent, { role: 'tool', toolCallId: 'c1', toolName: 'edit_file', content: 'ok' }];
  appendPhaseNote(native, 'Verify the edit.');
  assert.deepEqual(native[3], { role: 'user', content: '[System Phase]\nVerify the edit.' });
  assert.equal(native[2].content, 'ok', 'earlier messages are untouched');
  // Tool-text mode: joins the unsent [Tool Results] message, so roles keep alternating
  const fenced = [{ role: 'user', content: 'fix it' }, { role: 'assistant', content: '```edit_file' }, { role: 'user', content: '[Tool Results]\n\nok' }];
  appendPhaseNote(fenced, '');
  assert.equal(fenced.length, 3);
  assert.match(fenced[2].content, /^\[Tool Results\]\n\nok\n\n\[System Phase\]\nThe previous phase is complete/);
});
