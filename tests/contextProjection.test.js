const test = require('node:test');
const assert = require('node:assert/strict');

const { projectHistoryForModel } = require('../out/contextProjection.js');

test('old large tool results are compacted without mutating canonical history', () => {
  const large = '[read_file: src/a.ts]\n' + 'x'.repeat(8000);
  const history = [
    { role: 'user', content: 'fix it' },
    { role: 'assistant', content: '', nativeToolCalls: [{ id: 'call_1', name: 'read_file', arguments: { filepath: 'src/a.ts' } }] },
    { role: 'tool', content: large, toolCallId: 'call_1', toolName: 'read_file' },
    { role: 'assistant', content: 'thinking' },
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: 'more' },
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: 'more' },
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: 'latest' },
  ];

  const result = projectHistoryForModel(history, { recentMessages: 6, largeResultChars: 6000 });
  assert.equal(result.omittedMessages, 1);
  assert.ok(result.omittedChars >= 8000);
  assert.equal(history[2].content, large, 'canonical history must remain lossless');
  assert.equal(result.history[2].role, 'tool');
  assert.equal(result.history[2].toolCallId, 'call_1');
  assert.match(result.history[2].content, /prior read_file result compacted/i);
  assert.equal(result.history.at(-1), history.at(-1), 'recent working set should stay verbatim');
});

test('recent or small tool results are preserved verbatim', () => {
  const history = [
    { role: 'tool', content: 'small result', toolCallId: 'a', toolName: 'search_files' },
    { role: 'assistant', content: 'one' },
    { role: 'user', content: 'two' },
  ];
  const result = projectHistoryForModel(history, { recentMessages: 2, largeResultChars: 6000 });
  assert.equal(result.omittedMessages, 0);
  assert.equal(result.history[0].content, 'small result');
});
