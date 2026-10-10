const test = require('node:test');
const assert = require('node:assert/strict');

const { threadMarkdown, exportFileName } = require('../out/threadExport.js');

const AT = Date.UTC(2026, 9, 10, 14, 5);

test('a conversation as Markdown: questions, answers, steps and the change report', () => {
  const md = threadMarkdown('Fix the   parser', [
    { role: 'user', text: 'fix the parser bug', id: 'u1', at: AT },
    { role: 'assistant', text: 'Fixed.', at: AT + 60000, events: [
      { type: 'appendThinking', text: 'SECRET REASONING' },
      { type: 'toolStart', tool: 'read_file', label: 'src/parser.ts' },
      { type: 'toolResult', tool: 'read_file', label: 'src/parser.ts', success: true },
      { type: 'appendContent', text: 'Found it.\n\n' },
      { type: 'toolStart', tool: 'run_terminal', label: 'npm test\n2>&1' },
      { type: 'terminalChunk', text: 'RAW TERMINAL OUTPUT' },
      { type: 'appendContent', text: '# Summary\n\nThe loop was off by one.\n\n```md\n# not a heading\n```\n' },
      { type: 'patchPassport', passport: {}, markdown: '## Change report\n\n**Verified: checks passed after the last change**\n' },
    ] },
  ]);
  assert.equal(md, [
    '# Fix the parser', '',
    '## You — 2026-10-10 14:05 UTC', '',
    'fix the parser bug', '',
    '## Codico — 2026-10-10 14:06 UTC', '',
    '<details><summary>2 steps</summary>', '',
    '- `read_file` src/parser.ts',
    '- `run_terminal` npm test 2>&1', '',
    '</details>', '',
    'Found it.', '',
    // Headings inside the reply sit below the message heading; a "#" inside a code block is left alone
    '### Summary', '',
    'The loop was off by one.', '',
    '```md', '# not a heading', '```', '',
    '#### Change report', '',
    '**Verified: checks passed after the last change**', '',
  ].join('\n'));
  assert.doesNotMatch(md, /SECRET REASONING|RAW TERMINAL OUTPUT/);
});

test('replies saved without their events, errors, and an empty conversation', () => {
  const md = threadMarkdown('Old', [
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'A summary kept from an older version…' },
    { role: 'user', text: 'again' },
    { role: 'assistant', text: '', events: [{ type: 'streamError', message: 'HTTP 500' }] },
  ]);
  assert.match(md, /## You\n\nhello\n\n## Codico\n\nA summary kept from an older version…\n/);
  assert.match(md, /## Codico\n\n> Error: HTTP 500\n$/);
  assert.equal(threadMarkdown('  ', []), '# Conversation\n');
});

test('the file name is the thread name, safe everywhere', () => {
  assert.equal(exportFileName('Plan: plan for ux new features'), 'Plan-plan-for-ux-new-features.md');
  assert.equal(exportFileName('../../etc/passwd'), 'etcpasswd.md');
  assert.equal(exportFileName('a/b\\c:d*e?"f<g>h|i'), 'abcdefghi.md');
  assert.equal(exportFileName('Café ☕ notes'), 'Cafe-notes.md');
  assert.equal(exportFileName('...'), 'conversation.md');
  assert.equal(exportFileName(''), 'conversation.md');
  assert.ok(exportFileName('x'.repeat(300)).length <= 63);
});
