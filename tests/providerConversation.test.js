const test = require('node:test');
const assert = require('node:assert/strict');

const {
  flattenChatHistory,
  toOpenAIMessages,
  toAnthropicMessages,
  toGeminiMessages,
} = require('../out/providerConversation.js');

const history = [
  { role: 'user', content: 'Read the file' },
  {
    role: 'assistant',
    content: '',
    nativeToolCalls: [{
      id: 'call_123',
      name: 'read_file',
      arguments: { filepath: 'src/a.ts' },
    }],
  },
  {
    role: 'tool',
    content: '[read_file: src/a.ts]\nexport const a = 1;',
    toolCallId: 'call_123',
    toolName: 'read_file',
  },
];

test('OpenAI history preserves tool call id and tool result linkage', () => {
  assert.deepEqual(toOpenAIMessages(history, true), [
    { role: 'user', content: 'Read the file' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_123',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: '{"filepath":"src/a.ts"}',
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_123',
      content: '[read_file: src/a.ts]\nexport const a = 1;',
    },
  ]);
});

test('Anthropic history emits tool_use followed by tool_result', () => {
  const messages = toAnthropicMessages(history);
  assert.deepEqual(messages[1], {
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'call_123',
      name: 'read_file',
      input: { filepath: 'src/a.ts' },
    }],
  });
  assert.deepEqual(messages[2], {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'call_123',
      content: '[read_file: src/a.ts]\nexport const a = 1;',
    }],
  });
});

test('Gemini history emits functionCall followed by functionResponse', () => {
  const messages = toGeminiMessages(history);
  assert.deepEqual(messages[1], {
    role: 'model',
    parts: [{
      functionCall: {
        name: 'read_file',
        args: { filepath: 'src/a.ts' },
      },
    }],
  });
  assert.deepEqual(messages[2], {
    role: 'user',
    parts: [{
      functionResponse: {
        name: 'read_file',
        response: { result: '[read_file: src/a.ts]\nexport const a = 1;' },
      },
    }],
  });
});

test('compatibility transports flatten native tool turns to readable text', () => {
  const flattened = flattenChatHistory(history);
  assert.equal(flattened[1].role, 'assistant');
  assert.match(flattened[1].content, /Native tool calls executed: read_file/);
  assert.equal(flattened[2].role, 'user');
  assert.match(flattened[2].content, /Tool Result: read_file/);
});


test('Anthropic and Gemini compatibility mode flatten prior native turns', () => {
  const anthropic = toAnthropicMessages(history, false);
  assert.equal(JSON.stringify(anthropic).includes('tool_use'), false);
  assert.equal(JSON.stringify(anthropic).includes('tool_result'), false);
  assert.match(JSON.stringify(anthropic), /Tool Result: read_file/);

  const gemini = toGeminiMessages(history, false);
  assert.equal(JSON.stringify(gemini).includes('functionCall'), false);
  assert.equal(JSON.stringify(gemini).includes('functionResponse'), false);
  assert.match(JSON.stringify(gemini), /Tool Result: read_file/);
});
