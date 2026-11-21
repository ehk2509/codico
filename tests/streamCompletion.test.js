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

  // A closing offer, or a reply saying the work is done, is not an announced step (both cost extra requests when nudged)
  assert.equal(isUnfulfilledActionAnnouncement("Done. Created `empty.json`.\n\nIf you meant a file containing an empty JSON object (`{}`) or a specific filename/path, let me know and I'll adjust."), false);
  assert.equal(isUnfulfilledActionAnnouncement("The task is complete — no further action is needed.\n\nIf you wanted a different filename, or a file containing `{}`, just say so and I'll adjust it."), false);
  assert.equal(isUnfulfilledActionAnnouncement('Final answer: the task is complete. No further tool calls are required. I will not change anything else.'), false);
  assert.equal(isUnfulfilledActionAnnouncement('Want me to also add tests? Let me know.'), false);
  // An announcement after a finished step is still one
  assert.equal(isUnfulfilledActionAnnouncement('The config is read.\n\nNow I\'ll update the parser to use it.'), true);
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

test('a reply that hands the decision back: an offer to go on, or a question', () => {
  const { endsWithOfferOrQuestion } = require('../out/streamCompletion.js');
  assert.equal(endsWithOfferOrQuestion('The helper is written.\n\nIt would touch only the agent loop. Say the word and I\'ll start.'), true);
  assert.equal(endsWithOfferOrQuestion('Two ways to do it: fix the parser, or keep the four-backtick form.\n\nWhich do you want?'), true);
  assert.equal(endsWithOfferOrQuestion('Done: the parser keeps inner fences, and the 9 tests pass.'), false);
  assert.equal(endsWithOfferOrQuestion('<clarify>\nquestion: Which file?\n</clarify>'), false, 'a clarify block is its own way of asking');
  assert.equal(endsWithOfferOrQuestion(''), false);
});

test('detects tool calls written in a syntax Codico does not run', () => {
  const { containsPseudoToolCall } = require('../out/streamCompletion.js');

  // What qwen3 sent when asked to resume a review (Qwen's native XML call)
  assert.equal(containsPseudoToolCall('<tool_call>\n<function=read_file>\n<parameter=filepath>\nsrc/space/orbits.ts\n</parameter>\n</function>\n</tool_call>'), true);
  assert.equal(containsPseudoToolCall('<function=search_code>\n<parameter=query>frame</parameter>\n</function>'), true);
  assert.equal(containsPseudoToolCall('<function_calls><invoke name="read_file"></invoke></function_calls>'), true);

  assert.equal(containsPseudoToolCall('```read_file\nfilepath: src/a.ts\n```'), false);
  assert.equal(containsPseudoToolCall('The `frame` function returns early when nothing changed.'), false);
  assert.equal(containsPseudoToolCall(''), false);
});

test('detects a reply that ends where its answer should start', () => {
  const { endsBeforeTheAnswer } = require('../out/streamCompletion.js');

  // The end of a real review that stopped there (qwen3 through Ollama)
  assert.equal(endsBeforeTheAnswer("The `parseTle` doc confirms the format expectation, so line 515's silent `['', '']` fallback is a real (if minor) gap.\n\nNow the remaining check: whether the two lines I flagged in `frame` are safe — `frame.eye` is a `[number, number, number]`, so `.set(...)` is correct. I have what I need for the review."), true);
  assert.equal(endsBeforeTheAnswer('I now have everything I need to write the summary.'), true);
  assert.equal(endsBeforeTheAnswer("That's all I need."), true);
  assert.equal(endsBeforeTheAnswer("I'm ready to write the review."), true);
  assert.equal(endsBeforeTheAnswer('Here is my review:'), true);

  // An answer, or a reply that only mentions what it needed along the way
  assert.equal(endsBeforeTheAnswer('Here is my review: the parser is fine, and `frame` leaks no buffers.'), false);
  assert.equal(endsBeforeTheAnswer('I have what I need, so here is the fix: `port` is now 8080 and the tests pass.'), false);
  assert.equal(endsBeforeTheAnswer('Done. The port is now 8080.'), false);
  assert.equal(endsBeforeTheAnswer('<clarify>\nquestion: I have what I need, which file?\n</clarify>'), false);
  assert.equal(endsBeforeTheAnswer(''), false);
  // A long reply is the answer, whatever its last sentence says
  assert.equal(endsBeforeTheAnswer('## Review\n\n' + '- a finding about the code.\n'.repeat(80) + '\nI have what I need.'), false);
});
