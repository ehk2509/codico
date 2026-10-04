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

test('detects action announcements that were never followed by a tool call', () => {
  const { isUnfulfilledActionAnnouncement } = require('../out/streamCompletion.js');

  assert.equal(isUnfulfilledActionAnnouncement('I’ll locate the `js/KartoFacadeCameraControllerView.js` file.'), true);
  assert.equal(isUnfulfilledActionAnnouncement('I’m searching for the INFOWINDOW mouseout guard in the Map component.'), true);
  assert.equal(isUnfulfilledActionAnnouncement("Let me check what's in the src directory."), true);

  assert.equal(isUnfulfilledActionAnnouncement('The build completed successfully.\n\n## Summary\nAll files are in place.'), false);
  assert.equal(isUnfulfilledActionAnnouncement('Should I also add tests? I will wait for your answer?'), false);
  assert.equal(isUnfulfilledActionAnnouncement('<clarify>\nquestion: Which framework?\n</clarify>'), false);
  assert.equal(isUnfulfilledActionAnnouncement(''), false);
});

test('drops text a resumed response repeats from before the cutoff', () => {
  const { repeatedPrefixLength } = require('../out/streamCompletion.js');
  const before = 'API service is ready.\n\nNow creating the component files, starting with the price';
  const restarted = 'Now creating the component files, starting with the price ticker and chart.';
  assert.equal(restarted.slice(repeatedPrefixLength(before, restarted)), ' ticker and chart.');

  const exact = ' ticker and chart components.';
  assert.equal(repeatedPrefixLength(before, exact), 0);

  const repeatOnly = '\nNow creating the component';
  assert.equal(repeatedPrefixLength(before, repeatOnly), repeatOnly.length);

  assert.equal(repeatedPrefixLength('', 'anything'), 0);
});
