const test = require('node:test');
const assert = require('node:assert/strict');
const { knownLines, splitWindow, partialBody, notRepeatedText, alreadyDeclined, MIN_OMITTED_RUN } = require('../out/readDedup.js');
const { buildImportUsageAudit } = require('../out/importUsageAudit.js');
const { buildLocalInvariantAudit } = require('../out/localInvariantAudit.js');

const FILE = Array.from({ length: 60 }, (_, i) => `const line${i + 1} = ${i + 1};`);
const names = new Set(['src/a.ts', '/work/project/src/a.ts']);
const numbered = (from, to, lines = FILE) => lines.slice(from - 1, to).map((text, i) => `${from + i}\t${text}`).join('\n');
const readResult = (path, from, to, lines = FILE) => `[read_file: ${path} lines ${from}–${to} of ${lines.length}; each line is shown as <number><tab><text>, and the number is not part of the file]\n\`\`\`\n${numbered(from, to, lines)}\n\`\`\`\n… (bounded read; use start_line: ${to + 1} and end_line to continue)\n`;
const tool = (content) => ({ role: 'tool', content, toolCallId: 'c', toolName: 'read_file' });
const sorted = (set) => [...set].sort((a, b) => a - b);

test('lines count as known only while their text is in the conversation and still equal to the file', () => {
  const history = [{ role: 'user', content: 'fix it', turnId: 't' }, tool(readResult('src/a.ts', 10, 30))];
  assert.deepEqual(sorted(knownLines(history, names, FILE)), Array.from({ length: 21 }, (_, i) => i + 10));
  // The file changed at line 20 (and everything after it moved down one line): only what still matches is known
  const edited = FILE.slice(); edited.splice(19, 0, 'const inserted = true;');
  assert.deepEqual(sorted(knownLines(history, names, edited)), Array.from({ length: 10 }, (_, i) => i + 10));
  // Another file, or another spelling that is not this file: nothing
  assert.equal(knownLines([tool(readResult('src/b.ts', 10, 30))], names, FILE).size, 0);
  assert.equal(knownLines([tool(readResult('/work/project/src/a.ts', 1, 5))], names, FILE).size, 5, 'an absolute path is the same file');
  assert.equal(knownLines([tool(readResult('./src/a.ts', 1, 5))], names, FILE).size, 5);
  // Gone from the conversation (compacted, rewound, another thread): nothing is assumed
  assert.equal(knownLines([{ role: 'user', content: '[Conversation Summary] the agent read src/a.ts lines 10–30' }], names, FILE).size, 0);
  // What the assistant wrote is not evidence, only tool results are
  assert.equal(knownLines([{ role: 'assistant', content: readResult('src/a.ts', 1, 60) }], names, FILE).size, 0);
});

test('results in the text tool format and the snippets edits return count too', () => {
  const fenced = { role: 'user', content: `[Tool Results]\n\n[search_files: "x"] none\n\n---\n\n${readResult('src/a.ts', 1, 12)}\n---\n\n[read_file: src/b.ts lines 1–3 of 3; …]\n\`\`\`\n40\tconst line40 = 40;\n\`\`\`` };
  assert.deepEqual(sorted(knownLines([fenced], names, FILE)), Array.from({ length: 12 }, (_, i) => i + 1), 'the other file\'s block is not taken for this one');
  const edit = tool(`[edit_file: src/a.ts] Edit applied successfully.\nResult (lines 38–44, numbered like read_file):\n\`\`\`\n${numbered(38, 44)}\n\`\`\`\n\n[Post-edit integration audit]…`);
  assert.deepEqual(sorted(knownLines([edit], names, FILE)), [38, 39, 40, 41, 42, 43, 44]);
  // A header with no numbered block of its own (an error, a refusal) gives nothing
  assert.equal(knownLines([tool('[edit_file: src/a.ts] ERROR: old_str not found\n\n---\n\n[read_file: src/b.ts lines 1–2 of 2; …]\n```\n1\tconst line1 = 1;\n```')], names, FILE).size, 0);
});

test('a window is cut into what is new and the long runs that are not', () => {
  const known = new Set([...Array(21).keys()].map(i => i + 10));   // 10–30
  assert.deepEqual(splitWindow(10, 30, known), [{ from: 10, to: 30, known: true }]);
  assert.deepEqual(splitWindow(1, 40, known), [{ from: 1, to: 9, known: false }, { from: 10, to: 30, known: true }, { from: 31, to: 40, known: false }]);
  assert.deepEqual(splitWindow(41, 50, known), [{ from: 41, to: 50, known: false }]);
  // A few known lines among new ones are sent with them: a marker would cost as much
  const few = new Set([5, 6, 7]);
  assert.ok(MIN_OMITTED_RUN > 3);
  assert.deepEqual(splitWindow(1, 12, few), [{ from: 1, to: 12, known: false }]);
  const body = partialBody(splitWindow(1, 40, known), FILE);
  assert.equal(body.omitted, '10–30');
  const lines = body.text.split('\n');
  assert.equal(lines.length, 9 + 1 + 10);
  assert.equal(lines[8], '9\tconst line9 = 9;');
  assert.equal(lines[9], '… lines 10–30 not repeated: already shown above, unchanged …');
  assert.equal(lines[10], '31\tconst line31 = 31;');
});

test('asked again for exactly the lines that were declined, the model gets them', () => {
  const declined = notRepeatedText('src/a.ts', 10, 30, 60);
  assert.match(declined, /^\[read_file: src\/a\.ts lines 10–30 of 60\] Not repeated: these lines are already in this conversation/);
  assert.match(declined, /asking for exactly these lines again returns them\.$/);
  const history = [tool(readResult('src/a.ts', 10, 30)), tool(declined)];
  assert.equal(alreadyDeclined(history, names, 10, 30), true);
  assert.equal(alreadyDeclined(history, names, 10, 31), false);
  assert.equal(alreadyDeclined(history, new Set(['src/b.ts']), 10, 30), false);
  // The pointer itself is not numbered text: it never makes lines "known"
  assert.equal(knownLines([tool(declined)], names, FILE).size, 0);
});

test('an import that was already unused before the edit is not blamed on the edit', () => {
  const before = "import { used, stale } from './helpers';\nimport { other } from './other';\nused();\n";
  const after = before + "import { fresh } from './fresh';\n";
  assert.match(buildImportUsageAudit(after), /stale from \.\/helpers/, 'without the earlier version, every unused import is listed');
  const audit = buildImportUsageAudit(after, before);
  assert.match(audit, /- fresh from \.\/fresh/);
  assert.doesNotMatch(audit, /stale|other/);
  // Nothing new left unused: no audit at all, so the agent is not sent to tidy up old code
  assert.equal(buildImportUsageAudit(before + 'const x = 1;\n', before), '');
  assert.equal(buildLocalInvariantAudit(before + 'const x = 1;\n', 'const x = 1;', 'src/a.ts', before), '');
  // An import the edit itself orphaned (its only use was removed) is still reported
  assert.match(buildImportUsageAudit("import { used } from './helpers';\n", "import { used } from './helpers';\nused();\n"), /used from \.\/helpers/);
});
