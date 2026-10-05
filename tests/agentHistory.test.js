const test = require('node:test');
const assert = require('node:assert/strict');

const { appendAssistantIteration } = require('../out/agentHistory.js');

test('native executions append assistant tool calls and linked tool results', () => {
  const history = [{ role: 'user', content: 'read it' }];
  appendAssistantIteration(history, '', [{
    call: {
      id: 'call_42',
      name: 'read_file',
      arguments: { filepath: 'src/a.ts' },
    },
    result: '[read_file] ok',
  }], 'fallback');

  assert.deepEqual(history.slice(1), [
    {
      role: 'assistant',
      content: '',
      nativeToolCalls: [{
        id: 'call_42',
        name: 'read_file',
        arguments: { filepath: 'src/a.ts' },
      }],
    },
    {
      role: 'tool',
      content: '[read_file] ok',
      toolCallId: 'call_42',
      toolName: 'read_file',
    },
  ]);
});

test('text-only assistant turns stay simple', () => {
  const history = [];
  appendAssistantIteration(history, 'done', [], 'fallback');
  assert.deepEqual(history, [{ role: 'assistant', content: 'done' }]);
});
