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


test('action guidance keeps discovery available but prioritizes mutation', () => {
  const { getNativeToolDefinitions, restrictNativeToolsForAction } = require('../out/nativeTools.js');
  const action = restrictNativeToolsForAction(getNativeToolDefinitions(false));
  const names = new Set(action.map(tool => tool.name));

  for (const name of ['read_file', 'search_files', 'list_directory', 'edit_file', 'write_file', 'run_terminal', 'get_diagnostics']) {
    assert.equal(names.has(name), true, `expected ${name} to remain available`);
  }

  assert.equal(action[0].name, 'edit_file');
  assert.equal(action[1].name, 'write_file');
  assert.match(action.find(tool => tool.name === 'read_file').description, /escape hatch/i);
  assert.match(action.find(tool => tool.name === 'edit_file').description, /preferred action-phase tool/i);
});

test('post-edit verification keeps dependencies but prioritizes audit then tests', () => {
  const { getNativeToolDefinitions, nativeToolsForAgentPhase } = require('../out/nativeTools.js');
  const beforeRead = nativeToolsForAgentPhase(
    getNativeToolDefinitions(false),
    false,
    true,
    'src/a.ts',
    true,
  );

  const names = new Set(beforeRead.map(tool => tool.name));
  for (const name of ['read_file', 'search_files', 'list_directory', 'fetch_url', 'edit_file', 'write_file', 'run_terminal']) {
    assert.equal(names.has(name), true, `expected ${name} during verification`);
  }

  assert.equal(beforeRead[0].name, 'read_file');
  assert.match(beforeRead.find(tool => tool.name === 'read_file').description, /Verification priority/i);
  assert.match(beforeRead.find(tool => tool.name === 'get_diagnostics').description, /Static verification only/i);

  const afterRead = nativeToolsForAgentPhase(
    getNativeToolDefinitions(false),
    false,
    true,
    'src/a.ts',
    false,
  );
  assert.equal(afterRead[0].name, 'run_terminal');
  assert.match(afterRead.find(tool => tool.name === 'run_terminal').description, /Preferred verification tool/i);
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


test('unresolved integration makes edit_file the verification priority', () => {
  const { getNativeToolDefinitions, nativeToolsForAgentPhase } = require('../out/nativeTools.js');
  const tools = nativeToolsForAgentPhase(
    getNativeToolDefinitions(false),
    false,
    true,
    'src/consumer.ts',
    false,
    true,
  );

  assert.equal(tools[0].name, 'edit_file');
  assert.match(tools.find(tool => tool.name === 'edit_file').description, /Blocking integration fix/i);
  assert.match(tools.find(tool => tool.name === 'read_file').description, /Integration recovery/i);
});


test('closed action phase withdraws discovery tools but keeps mutation and verification', () => {
  const {
    getNativeToolDefinitions,
    nativeToolsForAgentPhase,
  } = require('../out/nativeTools.js');

  const tools = nativeToolsForAgentPhase(
    getNativeToolDefinitions(false),
    true,
    false,
    undefined,
    true,
    false,
    true,
  );
  const names = new Set(tools.map(tool => tool.name));

  for (const name of ['edit_file', 'write_file', 'run_terminal', 'get_diagnostics']) {
    assert.equal(names.has(name), true, 'expected ' + name + ' after discovery closes');
  }
  for (const name of ['read_file', 'search_files', 'find_files', 'list_directory', 'fetch_url', 'lsp_symbol']) {
    assert.equal(names.has(name), false, 'did not expect ' + name + ' after discovery closes');
  }
});
