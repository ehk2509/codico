const test = require('node:test');
const assert = require('node:assert/strict');

const { appendPhaseNote, withoutRepeats, POST_EDIT_VERIFICATION_PROMPT, ACTION_PHASE_SYSTEM_PROMPT } = require('../out/agentPhasePrompt.js');
const { editResultSnippet } = require('../out/fileReadWindow.js');
const { buildLocalInvariantAudit } = require('../out/localInvariantAudit.js');
const { buildTaskAcceptanceContract } = require('../out/taskAcceptance.js');

const CONTRACT = buildTaskAcceptanceContract('Fix the retry loop in src/net.ts. Do not change the public API.');
const verifyNote = (file) => `${POST_EDIT_VERIFICATION_PROMPT}\nEdited file: \`${file}\`.\nNext verification step: re-read the edited control flow once before relying on static checks.\n\n${CONTRACT}`;
const notes = (history) => history.filter(m => m.role === 'user' && m.content.includes('[System Phase]')).map(m => m.content);

test('the first note of a phase is complete; a repeat keeps only what is new', () => {
  const history = [{ role: 'user', content: 'fix it' }, { role: 'assistant', content: 'ok' }];
  appendPhaseNote(history, verifyNote('src/net.ts'));
  appendPhaseNote(history, '');
  history.push({ role: 'assistant', content: 'next' });
  appendPhaseNote(history, verifyNote('src/retry.ts'));
  const [first, , repeat] = notes(history).flatMap(text => text.split('[System Phase]\n').slice(1));
  assert.ok(first.includes(POST_EDIT_VERIFICATION_PROMPT) && first.includes(CONTRACT), 'the first note is whole');
  // The repeat: the phase by name, a pointer to its rules, this edit's own lines, a pointer to the contract
  assert.match(repeat, /^## Current phase — satisfy the acceptance contract\n\nThe rules of this phase are the same as in the earlier note for it; they still apply in full\.\nEdited file: `src\/retry\.ts`\.\nNext verification step: [^\n]+\n\n## Task acceptance contract\n\nUnchanged: the task acceptance contract given earlier in this conversation still applies in full\.$/);
  assert.ok(repeat.length < first.length / 5, `${repeat.length} of ${first.length} chars`);
  assert.doesNotMatch(repeat, /Do not change the public API/);
});

test('another phase gets its own rules in full, with the contract by reference', () => {
  const history = [{ role: 'user', content: 'fix it' }];
  appendPhaseNote(history, verifyNote('src/net.ts'));
  history.push({ role: 'assistant', content: 'x' });
  const second = withoutRepeats(history, `${ACTION_PHASE_SYSTEM_PROMPT}\n\n${CONTRACT}`);
  assert.ok(second.startsWith(ACTION_PHASE_SYSTEM_PROMPT), 'rules not seen before are given in full');
  assert.match(second, /Unchanged: the task acceptance contract given earlier/);
});

test('once the earlier note is gone from the history (after a compaction), the next note is whole again', () => {
  const history = [{ role: 'user', content: 'fix it' }];
  appendPhaseNote(history, verifyNote('src/net.ts'));
  const compacted = [{ role: 'user', content: '[Conversation Summary]\nWorked on the retry loop.' }, { role: 'assistant', content: 'continuing' }];
  assert.equal(withoutRepeats(compacted, verifyNote('src/net.ts')), verifyNote('src/net.ts'));
  // A different task's contract is not "unchanged"
  const other = verifyNote('a.ts').replace('Fix the retry loop', 'Rewrite the retry loop');
  assert.ok(withoutRepeats(history, other).includes('Rewrite the retry loop'));
  assert.equal(withoutRepeats(history, ''), '');
});

test('an edit result numbers its lines and does not echo a long insertion back in full', () => {
  const file = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
  // Lines 21–40 are the insertion
  const result = editResultSnippet(file, 20, 20);
  assert.deepEqual([result.from, result.to], [11, 50]);
  const lines = result.text.split('\n');
  assert.equal(lines[0], '11\tline 11');
  assert.equal(lines[9], '20\tline 20', 'ten lines of context before');
  assert.deepEqual(lines.slice(10, 17), ['21\tline 21', '22\tline 22', '23\tline 23', '… (14 more lines you wrote, lines 24–37, as in your edit)', '38\tline 38', '39\tline 39', '40\tline 40']);
  assert.equal(lines[lines.length - 1], '50\tline 50', 'ten lines of context after');
  // A short insertion is shown whole
  const short = editResultSnippet(file, 20, 8).text;
  assert.doesNotMatch(short, /more lines you wrote/);
  assert.match(short, /\n24\tline 24\n25\tline 25\n/);
  // At the start and end of a file
  assert.deepEqual([editResultSnippet(file, 0, 1).from, editResultSnippet(file, 59, 1).to], [1, 60]);
});

test('a very long line in an edit result is cut, with its length', () => {
  const file = ['short', 'x'.repeat(1000), 'tail'];
  const text = editResultSnippet(file, 0, 1).text;
  assert.match(text, /^1\tshort\n2\tx{240}… \(\+760 chars\)\n3\ttail$/);
});

test('the lifecycle audit is for code: prose and data files get none', () => {
  const changed = 'let done = false;\nif (error) { reject(error); }';
  const source = `function run() {\n${changed}\n  stream.on('end', () => resolve());\n}\n`;
  assert.match(buildLocalInvariantAudit(source, changed, 'src/stream.ts'), /\[Local invariant audit\]/);
  assert.match(buildLocalInvariantAudit(source, changed), /\[Local invariant audit\]/, 'no path given: as before');
  for (const file of ['CHANGELOG.md', 'README.MD', 'package.json', 'config.yml', 'docs/notes.txt', 'media/chat.css', 'media/chat.html']) {
    assert.equal(buildLocalInvariantAudit('- Fixed: the stream could end with an error before done.\n', 'the stream could end with an error before done', file), '', file);
  }
});
