const test = require('node:test');
const assert = require('node:assert/strict');
const { cutAtTurn, lastTurnId } = require('../out/threadEditing.js');

const display = [
  { role: 'user', text: 'first', id: 't1' },
  { role: 'assistant', text: 'one' },
  { role: 'user', text: '📋 Plan: add login', id: 't2', plan: 'add login' },
  { role: 'assistant', text: 'plan' },
  { role: 'user', text: '✅ Plan approved — executing…', id: 't3', prompt: 'The user has approved the following plan…' },
  { role: 'assistant', text: 'done' },
];
const history = [
  { role: 'user', content: '[Context]\n\n[User request]\nfirst', turnId: 't1' },
  { role: 'assistant', content: 'one' },
  { role: 'user', content: [{ type: 'text', text: 'planner prompt' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }], turnId: 't2' },
  { role: 'assistant', content: '', nativeToolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }] },
  { role: 'tool', content: 'file', toolCallId: 'c1', toolName: 'read_file' },
  { role: 'assistant', content: 'plan' },
  { role: 'user', content: 'The user has approved the following plan…', turnId: 't3' },
  { role: 'assistant', content: 'done' },
];

test('a turn is cut from the transcript and the model history at the same point', () => {
  const cut = cutAtTurn(display, history, 't2');
  assert.deepEqual(cut.display, display.slice(0, 2));
  assert.deepEqual(cut.history, history.slice(0, 2), 'the tool steps of later turns go too');
  assert.deepEqual(cut.turn, { text: '📋 Plan: add login', plan: 'add login', parts: [history[2].content[1]], shownAs: undefined });
});

test('an approved plan is resent with its full prompt and shown as the panel showed it', () => {
  const { turn } = cutAtTurn(display, history, 't3');
  assert.equal(turn.text, 'The user has approved the following plan…');
  assert.equal(turn.shownAs, '✅ Plan approved — executing…');
});

test('a message summarised by compaction, or unknown, cannot be changed', () => {
  const compacted = [{ role: 'user', content: '[Conversation Summary]\n\n…' }, ...history.slice(2)];
  assert.match(cutAtTurn(display, compacted, 't1').error, /compacted/);
  assert.match(cutAtTurn(display, history, 'nope').error, /no longer in this conversation/);
});

test('regenerate targets the newest message that has a turn', () => {
  assert.equal(lastTurnId(display), 't3');
  assert.equal(lastTurnId([{ role: 'user', text: 'saved before turn ids' }, { role: 'assistant', text: 'x' }]), undefined);
});
