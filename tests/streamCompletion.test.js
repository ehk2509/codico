const test = require('node:test');
const assert = require('node:assert/strict');

const {
  StreamCompletionGuard,
  isRecoverableStreamInterruption,
  normalizeFinishReason,
} = require('../out/streamCompletion.js');

test('unexpected EOF is reported until a terminal marker is seen', () => {
  const guard = new StreamCompletionGuard();
  assert.match(
    guard.unexpectedEofMessage('OpenRouter'),
    /stream interrupted: connection closed before/i,
  );

  guard.markTerminal();
  assert.equal(guard.unexpectedEofMessage('OpenRouter'), null);
});

test('only transport interruptions are auto-recoverable', () => {
  assert.equal(
    isRecoverableStreamInterruption(
      'OpenRouter stream interrupted: connection closed before the provider sent a completion marker.',
    ),
    true,
  );
  assert.equal(
    isRecoverableStreamInterruption('Anthropic stream transport error: ECONNRESET'),
    true,
  );
  assert.equal(isRecoverableStreamInterruption('content filter blocked output'), false);
});

test('provider-specific cutoff reasons normalize for the UI', () => {
  assert.equal(normalizeFinishReason('MAX_TOKENS'), 'length');
  assert.equal(normalizeFinishReason('max_tokens'), 'length');
  assert.equal(normalizeFinishReason('SAFETY'), 'content_filter');
  assert.equal(normalizeFinishReason('length'), 'length');
});
