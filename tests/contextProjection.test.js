const test = require('node:test');
const assert = require('node:assert/strict');

const { projectHistoryForModel } = require('../out/contextProjection.js');

test('older large tool results are compacted while newest target evidence stays verbatim', () => {
  const oldLarge = '[read_file: src/a.ts]\n' + 'x'.repeat(8000);
  const newestA = '[read_file: src/a.ts]\n' + 'a'.repeat(8000);
  const newestB = '[read_file: src/b.ts]\n' + 'b'.repeat(8000);
  const history = [
    { role: 'user', content: 'fix it' },
    { role: 'assistant', content: '', nativeToolCalls: [{ id: 'call_1', name: 'read_file', arguments: { filepath: 'src/a.ts' } }] },
    { role: 'tool', content: oldLarge, toolCallId: 'call_1', toolName: 'read_file' },
    { role: 'assistant', content: 'next' },
    { role: 'assistant', content: '', nativeToolCalls: [{ id: 'call_2', name: 'read_file', arguments: { filepath: 'src/a.ts' } }] },
    { role: 'tool', content: newestA, toolCallId: 'call_2', toolName: 'read_file' },
    { role: 'assistant', content: '', nativeToolCalls: [{ id: 'call_3', name: 'read_file', arguments: { filepath: 'src/b.ts' } }] },
    { role: 'tool', content: newestB, toolCallId: 'call_3', toolName: 'read_file' },
    { role: 'assistant', content: 'latest' },
  ];

  const result = projectHistoryForModel(history, {
    recentMessages: 2,
    largeResultChars: 6000,
    maxLargeResultChars: 8000,
    preserveNewestLargeResults: 1,
    preserveNewestTargetResults: 4,
    maxWorkingSetChars: 24000,
  });

  assert.equal(result.omittedMessages, 1);
  assert.equal(result.history[2].role, 'tool');
  assert.match(result.history[2].content, /prior read_file result compacted/i);
  assert.equal(result.history[5].content, newestA, 'newest evidence for src/a.ts stays verbatim');
  assert.equal(result.history[7].content, newestB, 'newest evidence for src/b.ts stays verbatim');
  assert.equal(history[2].content, oldLarge, 'canonical history remains lossless');
});

test('different read windows of the same file are distinct working-set targets', () => {
  const first = 'a'.repeat(7000);
  const second = 'b'.repeat(7000);
  const history = [
    { role: 'assistant', content: '', nativeToolCalls: [{ id: 'a', name: 'read_file', arguments: { filepath: 'src/a.ts', start_line: 1, end_line: 200 } }] },
    { role: 'tool', content: first, toolCallId: 'a', toolName: 'read_file' },
    { role: 'assistant', content: '', nativeToolCalls: [{ id: 'b', name: 'read_file', arguments: { filepath: 'src/a.ts', start_line: 201, end_line: 400 } }] },
    { role: 'tool', content: second, toolCallId: 'b', toolName: 'read_file' },
    { role: 'assistant', content: 'continue' },
  ];

  const result = projectHistoryForModel(history, {
    recentMessages: 2,
    largeResultChars: 6000,
    maxLargeResultChars: 7000,
    preserveNewestTargetResults: 4,
    maxWorkingSetChars: 20000,
  });

  assert.equal(result.history[1].content, first);
  assert.equal(result.history[3].content, second);
});

test('working-set retention remains bounded', () => {
  const history = [];
  for (let i = 0; i < 8; i++) {
    history.push({
      role: 'assistant',
      content: '',
      nativeToolCalls: [{ id: 'c' + i, name: 'read_file', arguments: { filepath: `src/${i}.ts` } }],
    });
    history.push({ role: 'tool', content: String(i).repeat(9000), toolCallId: 'c' + i, toolName: 'read_file' });
  }

  const result = projectHistoryForModel(history, {
    recentMessages: 2,
    largeResultChars: 6000,
    maxLargeResultChars: 9000,
    preserveNewestLargeResults: 1,
    preserveNewestTargetResults: 3,
    maxWorkingSetChars: 27000,
  });

  const verbatim = result.history.filter(message => message.role === 'tool' && !/compacted/i.test(message.content));
  assert.ok(verbatim.length <= 3);
  assert.ok(result.omittedMessages >= 5);
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


test('identical repeated tool evidence is omitted only from provider copy', () => {
  const value = '[read_file: src/a.ts]\n' + 'identical '.repeat(400);
  const history = [
    { role: 'assistant', content: '', nativeToolCalls: [{ id: 'old', name: 'read_file', arguments: { filepath: 'src/a.ts' } }] },
    { role: 'tool', content: value, toolCallId: 'old', toolName: 'read_file' },
    { role: 'assistant', content: '', nativeToolCalls: [{ id: 'new', name: 'read_file', arguments: { filepath: 'src/a.ts' } }] },
    { role: 'tool', content: value, toolCallId: 'new', toolName: 'read_file' },
  ];
  const result = projectHistoryForModel(history, { recentMessages: 8, largeResultChars: 6000 });
  assert.equal(result.omittedMessages, 1);
  assert.match(result.history[1].content, /identical newer evidence retained/);
  assert.equal(result.history[3].content, value);
  assert.equal(history[1].content, value, 'canonical tool history remains unchanged');
});

test('changed evidence or distinct read ranges are never deduplicated', () => {
  const a = 'a'.repeat(3000);
  const b = 'b'.repeat(3000);
  const history = [
    { role: 'assistant', content: '', nativeToolCalls: [{ id: 'a', name: 'read_file', arguments: { filepath: 'src/a.ts', start_line: 1, end_line: 50 } }] },
    { role: 'tool', content: a, toolCallId: 'a', toolName: 'read_file' },
    { role: 'assistant', content: '', nativeToolCalls: [{ id: 'b', name: 'read_file', arguments: { filepath: 'src/a.ts', start_line: 51, end_line: 100 } }] },
    { role: 'tool', content: a, toolCallId: 'b', toolName: 'read_file' },
    { role: 'assistant', content: '', nativeToolCalls: [{ id: 'c', name: 'read_file', arguments: { filepath: 'src/a.ts', start_line: 1, end_line: 50 } }] },
    { role: 'tool', content: b, toolCallId: 'c', toolName: 'read_file' },
  ];
  const result = projectHistoryForModel(history, { recentMessages: 8 });
  assert.equal(result.omittedMessages, 0);
  assert.equal(result.history[1].content, a);
  assert.equal(result.history[3].content, a);
});

test('deduplication can be disabled without changing large-result policy', () => {
  const value = 'same'.repeat(800);
  const history = [
    { role: 'assistant', content: '', nativeToolCalls: [{ id: 'a', name: 'read_file', arguments: { filepath: 'a' } }] },
    { role: 'tool', content: value, toolCallId: 'a', toolName: 'read_file' },
    { role: 'assistant', content: '', nativeToolCalls: [{ id: 'b', name: 'read_file', arguments: { filepath: 'a' } }] },
    { role: 'tool', content: value, toolCallId: 'b', toolName: 'read_file' },
  ];
  assert.equal(projectHistoryForModel(history, { deduplicateExactResults: false }).omittedMessages, 0);
});
