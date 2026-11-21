const test = require('node:test');
const assert = require('node:assert/strict');

const { scanXmlToolCalls, partialXmlOpenerLength } = require('../out/xmlToolCalls.js');
const { nativeToolCallToToolCall } = require('../out/nativeTools.js');

// As Qwen3 30B A3B wrote it on Ollama, in Codico's text tool format
const QWEN = 'Checking the blast radius across `src/`.\n\n<tool_call>\n<function=search_files>\n<parameter=pattern>\ntoLocaleString|Intl\\.\n</parameter>\n<parameter=glob>\n**/src/**/*.ts\n</parameter>\n<parameter=regex>\ntrue\n</parameter>\n</function>\n</tool_call>\n';

test('a Qwen XML tool call is read as the call it stands for, typed by the tool schema', () => {
  const scan = scanXmlToolCalls(QWEN);
  assert.equal(scan.unclosedStart, -1);
  assert.equal(scan.calls.length, 1);
  const [{ start, end, call }] = scan.calls;
  assert.equal(QWEN.slice(start, start + 11), '<tool_call>');
  assert.equal(QWEN.slice(end - 12, end), '</tool_call>');
  assert.deepEqual(call, { name: 'search_files', arguments: { pattern: 'toLocaleString|Intl\\.', glob: '**/src/**/*.ts', regex: true } });
  assert.deepEqual(nativeToolCallToToolCall(call), { type: 'search_files', pattern: 'toLocaleString|Intl\\.', glob: '**/src/**/*.ts', isRegex: true });
});

test('several calls, a bare <function=…> block, and values that keep their inner lines', () => {
  const text = '<function=read_file>\n<parameter=filepath>\nsrc/a.ts\n</parameter>\n<parameter=start_line>\n10\n</parameter>\n</function>\n' +
    'then\n<tool_call>\n<function=write_file>\n<parameter=filepath>\nb.py\n</parameter>\n<parameter=content>\ndef f():\n    return 1\n</parameter>\n</function>\n</tool_call>';
  const calls = scanXmlToolCalls(text).calls.map(c => c.call);
  assert.deepEqual(calls, [
    { name: 'read_file', arguments: { filepath: 'src/a.ts', start_line: 10 } },
    { name: 'write_file', arguments: { filepath: 'b.py', content: 'def f():\n    return 1' } },
  ]);
});

test('the JSON form inside <tool_call> is read too', () => {
  const scan = scanXmlToolCalls('<tool_call>\n{"name": "run_terminal", "arguments": {"command": "npm test"}}\n</tool_call>');
  assert.deepEqual(scan.calls[0].call, { name: 'run_terminal', arguments: { command: 'npm test' } });
});

test('a call still streaming is unclosed; at the end of the stream it is taken as it is', () => {
  const partial = 'Reading it.\n<tool_call>\n<function=read_file>\n<parameter=filepath>\nsrc/a.ts\n</parameter>\n';
  assert.deepEqual(scanXmlToolCalls(partial), { calls: [], unclosedStart: partial.indexOf('<tool_call>') });
  assert.deepEqual(scanXmlToolCalls(partial, 0, true).calls[0].call, { name: 'read_file', arguments: { filepath: 'src/a.ts' } });
});

test('a tag mentioned in a sentence is not a call', () => {
  assert.deepEqual(scanXmlToolCalls('Qwen writes `<tool_call>` blocks, and <function=x> inline.'), { calls: [], unclosedStart: -1 });
});

test('the start of a line that may become an opening tag is held back from display', () => {
  assert.equal(partialXmlOpenerLength('text\n<tool_c'), 7);
  assert.equal(partialXmlOpenerLength('text\n<functi'), 7);
  assert.equal(partialXmlOpenerLength('text\n<'), 1);
  assert.equal(partialXmlOpenerLength('a < b'), 0);
  assert.equal(partialXmlOpenerLength('text\n<div'), 0);
});
