const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanReply, ReplyCleaner } = require('../out/headlessText.js');

// What a real run printed: the tool fences' bodies are already hidden, the fragments are what is left
const SAMPLE_PIECES = ['```accept', 'ance', '\n\n', '```accept', 'ance', '```accept', 'ance', '```accept', 'ance', '\n\n', '⚠️ Loop detected — same tool call issued 4 times. Stopping repetition.\n', '```accept', 'ance', '\n\n> **Codico\'s check: Not accepted.**'];

test('tool fences are removed whole, ordinary code blocks and prose stay', () => {
  const reply = 'I fixed it.\n\n```run_terminal\ncommand: npm test\n```\n\nHere is the change:\n\n```js\nconst a = 1;\n```\n\n```acceptance\naction: verify\ncriterion: AC1\n```\nDone.';
  assert.equal(cleanReply(reply, true), 'I fixed it.\n\nHere is the change:\n\n```js\nconst a = 1;\n```\n\nDone.');
});

test('fragments of a tool fence whose body was already hidden do not reach the output', () => {
  const out = cleanReply(SAMPLE_PIECES.join(''), true);
  assert.doesNotMatch(out, /acceptance/);
  assert.doesNotMatch(out, /`{3}/);
  assert.match(out, /Loop detected/, 'Codico\'s own notes are kept');
  assert.match(out, /Codico's check: Not accepted/);
});

test('streamed in pieces, the same text comes out, and a fence split across pieces never shows', () => {
  const cleaner = new ReplyCleaner();
  const shown = [];
  for (const piece of SAMPLE_PIECES) { shown.push(cleaner.push(piece)); }
  shown.push(cleaner.flush());
  assert.equal(shown.join(''), cleanReply(SAMPLE_PIECES.join(''), true));
  assert.ok(shown.every(part => !/`/.test(part)), 'no backtick of a fence was ever printed');
});

test('a half-arrived fence is held back, and is printed at the end if it was not a tool fence', () => {
  const cleaner = new ReplyCleaner();
  assert.equal(cleaner.push('Use `'), 'Use ');
  assert.equal(cleaner.push('x` to set it'), '`x` to set it');
  assert.equal(cleaner.push('\n\n``'), '\n\n', 'two backticks might still become a fence');
  assert.equal(cleaner.flush(), '``', 'at the end they are just text');
});

test('a stray header never swallows the text after it', () => {
  const cleaner = new ReplyCleaner();
  assert.equal(cleaner.push('Checking.\n```acceptance\nThe fix is in src/cart.js.\n'), 'Checking.\n\nThe fix is in src/cart.js.\n');
  // An empty block, and a block whose closing fence is directly followed by the next header, are both whole blocks / headers
  assert.equal(cleanReply('a\n```acceptance\n```\nb', true), 'a\n\nb');
  assert.equal(cleanReply('a\n```acceptance\n```acceptance\nb', true), 'a\n\nb');
});

test('a new reply starts clean', () => {
  const cleaner = new ReplyCleaner();
  cleaner.push('First reply.');
  cleaner.reset();
  assert.equal(cleaner.push('Second.'), 'Second.');
});
