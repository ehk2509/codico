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

test('think tags split across chunks never leak into the reply', () => {
  const { ThinkTagSplitter } = require('../out/streamCompletion.js');
  const run = (chunks) => {
    const out = [];
    const splitter = new ThinkTagSplitter((kind, text) => {
      const last = out[out.length - 1];
      if (last && last.kind === kind) { last.text += text; } else { out.push({ kind, text }); }
    });
    chunks.forEach(c => splitter.push(c));
    splitter.flush();
    return out;
  };
  const expected = [{ kind: 'thinking', text: 'plan it' }, { kind: 'content', text: 'Answer.' }];
  assert.deepEqual(run(['<think>plan it</think>Answer.']), expected);
  assert.deepEqual(run(['<thi', 'nk>plan', ' it</th', 'ink>Ans', 'wer.']), expected);
  assert.deepEqual(run(['<', 't', 'h', 'i', 'n', 'k', '>plan it<', '/think', '>Answer.']), expected);
  // A "<" that is not a tag is held only until the next chunk, and flushed at the end
  assert.deepEqual(run(['a <', ' b']), [{ kind: 'content', text: 'a < b' }]);
  assert.deepEqual(run(['ends with <th']), [{ kind: 'content', text: 'ends with <th' }]);
});
