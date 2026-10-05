const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getNativeToolDefinitions,
  nativeToolCallToToolCall,
  OpenAIToolCallAccumulator,
} = require('../out/nativeTools.js');

test('Ask mode exposes only read-only native tools', () => {
  const names = new Set(getNativeToolDefinitions(true).map(t => t.name));
  assert.equal(names.has('read_file'), true);
  assert.equal(names.has('search_files'), true);
  assert.equal(names.has('fetch_url'), true);
  assert.equal(names.has('write_file'), false);
  assert.equal(names.has('edit_file'), false);
  assert.equal(names.has('run_terminal'), false);
  assert.equal(names.has('mcp_call'), false);
});

test('native calls map onto the same internal ToolCall contract', () => {
  assert.deepEqual(
    nativeToolCallToToolCall({
      name: 'read_file',
      arguments: { filepath: 'src/a.ts', start_line: 10, end_line: 25 },
    }),
    { type: 'read_file', filepath: 'src/a.ts', startLine: 10, endLine: 25 },
  );

  assert.deepEqual(
    nativeToolCallToToolCall({
      name: 'edit_file',
      arguments: { filepath: 'src/a.ts', old_str: 'a', new_str: 'b' },
    }),
    { type: 'edit_file', filepath: 'src/a.ts', oldStr: 'a', newStr: 'b' },
  );

  assert.deepEqual(
    nativeToolCallToToolCall({
      name: 'mcp_call',
      arguments: { server: 'docs', tool: 'search', args: { q: 'streaming' } },
    }),
    { type: 'mcp_call', server: 'docs', tool: 'search', args: { q: 'streaming' } },
  );
});

test('OpenAI tool-call fragments survive arbitrary SSE chunking', () => {
  const acc = new OpenAIToolCallAccumulator();
  acc.add({ index: 0, id: 'call_1', function: { name: 'edit_' } });
  acc.add({ index: 0, function: { name: 'file', arguments: '{"filepath":"src/a.ts",' } });
  assert.deepEqual(acc.flushReady(), []);
  acc.add({ index: 0, function: { arguments: '"old_str":"a","new_str":"b"}' } });

  assert.deepEqual(acc.flushReady(), [{
    id: 'call_1',
    name: 'edit_file',
    arguments: { filepath: 'src/a.ts', old_str: 'a', new_str: 'b' },
  }]);
  assert.deepEqual(acc.flushReady(), [], 'a completed call must be emitted only once');
});

test('malformed native arguments remain pending instead of executing', () => {
  const acc = new OpenAIToolCallAccumulator();
  acc.add({ index: 0, function: { name: 'run_terminal', arguments: '{"command":' } });
  assert.equal(acc.hasPending, true);
  assert.deepEqual(acc.flushReady(), []);
  assert.deepEqual(acc.pendingNames(), ['run_terminal']);
});


test('action guidance keeps discovery capabilities available', () => {
  const { getNativeToolDefinitions, restrictNativeToolsForAction } = require('../out/nativeTools.js');
  const action = restrictNativeToolsForAction(getNativeToolDefinitions(false));
  const names = new Set(action.map(tool => tool.name));

  for (const name of ['read_file', 'search_files', 'list_directory', 'edit_file', 'write_file', 'run_terminal', 'get_diagnostics']) {
    assert.equal(names.has(name), true, `expected ${name} to remain available`);
  }

  assert.match(action.find(tool => tool.name === 'run_terminal').description, /source inspection remains available/i);
});

test('post-edit verification keeps dependency discovery available', () => {
  const { getNativeToolDefinitions, nativeToolsForAgentPhase } = require('../out/nativeTools.js');
  const verification = nativeToolsForAgentPhase(
    getNativeToolDefinitions(false),
    false,
    true,
    'src/a.ts',
  );

  const names = new Set(verification.map(tool => tool.name));
  for (const name of ['read_file', 'search_files', 'list_directory', 'fetch_url', 'edit_file', 'write_file', 'run_terminal']) {
    assert.equal(names.has(name), true, `expected ${name} during verification`);
  }

  const read = verification.find(tool => tool.name === 'read_file');
  assert.equal(read.inputSchema.properties.filepath.enum, undefined);
  assert.match(read.description, /callers\/consumers\/siblings/i);
});

test('read capability is never withdrawn by an arbitrary audit count', () => {
  const { getNativeToolDefinitions, nativeToolsForAgentPhase } = require('../out/nativeTools.js');
  const verification = nativeToolsForAgentPhase(
    getNativeToolDefinitions(false),
    false,
    true,
    'src/a.ts',
    false,
  );

  const names = new Set(verification.map(tool => tool.name));
  assert.equal(names.has('read_file'), true);
  assert.equal(names.has('search_files'), true);
});
