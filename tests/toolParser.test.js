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

test('tool fingerprints distinguish calls by their arguments', () => {
  const { toolFingerprint } = require('../out/toolParser.js');
  const writeA = { type: 'write_file', filepath: 'src/A.js', content: 'a' };
  const writeB = { type: 'write_file', filepath: 'src/B.js', content: 'b' };
  const runLs = { type: 'run_terminal', command: 'ls' };
  const runPwd = { type: 'run_terminal', command: 'pwd' };

  assert.notEqual(toolFingerprint(writeA), toolFingerprint(writeB));
  assert.notEqual(toolFingerprint(runLs), toolFingerprint(runPwd));
  assert.equal(toolFingerprint(writeA), toolFingerprint({ ...writeA }));
});

test('finds a tool fence the model never closed', () => {
  const { findUnclosedToolFence, parseToolCalls } = require('../out/toolParser.js');
  const unclosed = 'Now creating the server.\n\n```write_file\nfilepath: server.js\ncontent:\nserver.close();\n});';
  const start = findUnclosedToolFence(unclosed);
  assert.equal(start, unclosed.indexOf('```write_file'));
  const tools = parseToolCalls(unclosed.slice(start) + '\n```');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].filepath, 'server.js');

  assert.equal(findUnclosedToolFence('```run_terminal\ncommand: ls\n```'), -1);
  assert.equal(findUnclosedToolFence('```bash\nls'), -1);
  assert.equal(findUnclosedToolFence('No tools here.'), -1);
});

test('write_file content may contain its own code blocks', () => {
  const { parseToolCalls } = require('../out/toolParser.js');
  const readme = [
    '# Crypto Trading Bot', '', '## Quick Start', '', '```bash', 'cd server', 'npm start', '```', '',
    '## Disclaimer', '', 'Use at your own risk.',
  ].join('\n');
  const raw = 'Writing the README.\n\n```write_file\nfilepath: README.md\ncontent:\n' + readme + '\n```\n\nDone.';
  const tools = parseToolCalls(raw);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].content, readme);
});

test('four-backtick tool fences treat inner fences as content', () => {
  const { parseToolCalls } = require('../out/toolParser.js');
  const content = 'Example:\n```\nplain block without a language\n```\nEnd.';
  const raw = '````write_file\nfilepath: docs.md\ncontent:\n' + content + '\n````';
  const tools = parseToolCalls(raw);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].content, content);
});

test('edit_file strings may contain code blocks', () => {
  const { parseToolCalls } = require('../out/toolParser.js');
  const raw = [
    '```edit_file', 'filepath: README.md', 'old_str:', '## Usage', 'new_str:', '## Usage', '',
    '```js', 'run();', '```', '```',
  ].join('\n');
  const tools = parseToolCalls(raw);
  assert.equal(tools.length, 1);
  assert.match(tools[0].newStr, /```js\nrun\(\);\n```/);
});

test('scanner waits for a complete closing line while streaming', () => {
  const { scanToolFences } = require('../out/toolParser.js');
  const partial = '```run_terminal\ncommand: ls\n```';
  assert.equal(scanToolFences(partial, 0, false).fences.length, 0);
  assert.equal(scanToolFences(partial, 0, false).unclosedStart, 0);
  assert.equal(scanToolFences(partial + '\n', 0, false).fences.length, 1);
  assert.equal(scanToolFences(partial, 0, true).fences.length, 1);

  const two = '```read_file\nfilepath: a\n```\ntext\n```read_file\nfilepath: b\n```\n';
  const scan = scanToolFences(two);
  assert.deepEqual(scan.fences.map(f => f.body), ['filepath: a', 'filepath: b']);
  assert.equal(two.slice(scan.fences[0].start, scan.fences[0].end), '```read_file\nfilepath: a\n```');
});
