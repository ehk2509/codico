const test = require('node:test');
const assert = require('node:assert/strict');

const { parseToolCalls } = require('../out/toolParser.js');

test('parses terminal and file tool calls without executing content', () => {
  const raw = [
    'I will inspect the project.',
    '```read_file',
    'filepath: src/index.ts',
    '```',
    '```run_terminal',
    'command: npm test',
    '```',
  ].join('\n');

  assert.deepEqual(parseToolCalls(raw), [
    { type: 'read_file', filepath: 'src/index.ts' },
    { type: 'run_terminal', command: 'npm test' },
  ]);
});

test('ignores malformed or unknown tool fences', () => {
  const raw = [
    '```unknown_tool',
    'command: rm -rf .',
    '```',
    '```read_file',
    'not_filepath: src/index.ts',
    '```',
  ].join('\n');

  assert.deepEqual(parseToolCalls(raw), []);
});
