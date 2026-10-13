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

test('a result repeated unchanged is sent once: the older copy becomes a short note', () => {
  const file = '[read_file: media/chat.html lines 1–246 of 246]\n```\n' + 'h'.repeat(5000) + '\n```';
  const call = (id) => ({ role: 'assistant', content: '', nativeToolCalls: [{ id, name: 'read_file', arguments: { filepath: 'media/chat.html' } }] });
  const result = (id, content) => ({ role: 'tool', toolCallId: id, toolName: 'read_file', content });
  const history = [
    { role: 'user', content: 'plan it' },
    call('c1'), result('c1', file),
    call('c2'), result('c2', file),
    call('c3'), result('c3', file.replace('hhh', 'hXh')), // the file changed: a different result
    call('c4'), result('c4', file),
  ];
  const { history: sent, omittedMessages } = projectHistoryForModel(history);
  assert.match(sent[2].content, /identical to a later result/);
  assert.match(sent[4].content, /identical to a later result/);
  assert.equal(sent[6].content, history[6].content, 'a changed file is not a duplicate');
  assert.equal(sent[8].content, file, 'the newest copy is kept verbatim');
  assert.equal(omittedMessages, 2);
  assert.equal(history[2].content, file, 'the stored history is not modified');
});

// ── File reads that are still current are not trimmed ──────────────────────────
const readOf = (path, from, to, total = 4000, note = '') => `[read_file: ${path} lines ${from}–${to} of ${total}; each line is shown as <number><tab><text>, and the number is not part of the file${note}]\n\`\`\`\n` +
  Array.from({ length: to - from + 1 }, (_, i) => `${from + i}\t${path} line ${from + i} ${'x'.repeat(60)}`).join('\n') + '\n```';
const toolMsg = (content, n, name = 'read_file') => ({ role: 'tool', content, toolCallId: 'c' + n, toolName: name });
const isTrimmed = (m) => /compacted: [\d,]+ chars omitted/.test(m.content);

test('a large read stays while its file is unchanged, however many other large results came after it', () => {
  // Nine large reads of nine places, then one more step: the old rule kept the newest six
  const history = [{ role: 'user', content: 'do it' }];
  for (let n = 1; n <= 9; n++) { history.push({ role: 'assistant', content: 'step ' + n }, toolMsg(readOf(`src/f${n}.ts`, 1, 110), n)); }
  history.push({ role: 'assistant', content: 'now edit' });
  const projected = projectHistoryForModel(history).history;
  assert.equal(projected.filter(isTrimmed).length, 0, 'every read is still there, so none has to be made again');
  assert.equal(projected[2].content, history[2].content);
});

test('a read is trimmed once it is stale or repeated, and current reads are bounded in total', () => {
  const big = (path, n, from = 1, to = 110) => toolMsg(readOf(path, from, to), n);
  const filler = (n) => [{ role: 'assistant', content: 'step' }, toolMsg(`[run_terminal: npm test -- ${n}]\nExit: 0\n` + 'y'.repeat(9000 + n), 'r' + n, 'run_terminal')];
  // Stale: the file was edited after the read
  const edited = [{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'a' }, big('src/a.ts', 1),
    { role: 'assistant', content: 'b' }, toolMsg('[edit_file: ./src/a.ts] Edit applied successfully.\nResult (lines 10–14, numbered like read_file):\n```\n10\tx\n```', 2, 'edit_file'),
    ...Array.from({ length: 8 }, (_, n) => filler(n)).flat(), { role: 'assistant', content: 'end' }];
  assert.equal(isTrimmed(projectHistoryForModel(edited).history[2]), true, 'its line numbers are out of date: it goes like any old result');
  // The same history without the edit: kept
  const untouched = edited.filter((_, i) => i !== 4 && i !== 3);
  assert.equal(isTrimmed(projectHistoryForModel(untouched).history[2]), false);
  // An edit that failed does not make the read stale
  const failed = edited.map((m, i) => i === 4 ? toolMsg('[edit_file: src/a.ts] ERROR: old_str not found', 2, 'edit_file') : m);
  assert.equal(isTrimmed(projectHistoryForModel(failed).history[2]), false);

  // Repeated: a later read holds the same lines, so the older copy is the one to drop
  const again = [{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'a' }, big('src/a.ts', 1, 100, 210),
    ...Array.from({ length: 8 }, (_, n) => filler(n)).flat(), { role: 'assistant', content: 'b' }, big('src/a.ts', 2, 50, 260), { role: 'assistant', content: 'end' }];
  const projectedAgain = projectHistoryForModel(again).history;
  assert.equal(isTrimmed(projectedAgain[2]), true);
  assert.equal(isTrimmed(projectedAgain.at(-2)), false);
  // …but not when the later read left those lines out itself ("already in this conversation")
  const partial = again.map((m, i) => i === again.length - 2 ? toolMsg(readOf('src/a.ts', 50, 260, 4000, '; lines 100–210 are left out because they are already in this conversation, unchanged'), 2) : m);
  assert.equal(isTrimmed(projectHistoryForModel(partial).history[2]), false, 'the older read is the only copy of those lines');

  // Bounded: with more current reads than the budget, the newest are kept and the oldest go
  const many = [{ role: 'user', content: 'do it' }];
  for (let n = 1; n <= 30; n++) { many.push({ role: 'assistant', content: 's' }, big(`src/g${n}.ts`, n)); }
  many.push({ role: 'assistant', content: 'end' });
  const bounded = projectHistoryForModel(many, { maxCurrentReadChars: 60_000 }).history.filter(m => m.role === 'tool');
  const kept = bounded.filter(m => !isTrimmed(m)).reduce((sum, m) => sum + m.content.length, 0);
  assert.ok(kept <= 60_000 + 80_000, `${kept} characters of reads kept`);
  assert.equal(isTrimmed(bounded[0]), true);
  assert.equal(isTrimmed(bounded.at(-1)), false);
});

test('the text tool format: a read result inside "[Tool Results]" is kept the same way', () => {
  const history = [{ role: 'user', content: 'do it' }];
  for (let n = 1; n <= 9; n++) { history.push({ role: 'assistant', content: '```read_file…' }, { role: 'user', content: '[Tool Results]\n\n' + readOf(`src/f${n}.ts`, 1, 110) }); }
  history.push({ role: 'assistant', content: 'end' });
  assert.equal(projectHistoryForModel(history).history.filter(isTrimmed).length, 0);
  const edited = [...history, { role: 'user', content: '[Tool Results]\n\n[write_file: src/f1.ts] Written successfully (3 lines).' }, { role: 'assistant', content: 'end' }];
  for (let n = 0; n < 8; n++) { edited.push({ role: 'assistant', content: 's' }, { role: 'user', content: `[Tool Results]\n\n[run_terminal: x${n}]\nExit: 0\n` + 'y'.repeat(9000 + n) }); }
  assert.equal(isTrimmed(projectHistoryForModel(edited).history[2]), true, 'rewritten since: the old text is trimmed');
  assert.equal(isTrimmed(projectHistoryForModel(edited).history[4]), false);
});
