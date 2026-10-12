const test = require('node:test');
const assert = require('node:assert/strict');
const { steerText, addSteer, steerNote, MAX_STEER_CHARS } = require('../out/steering.js');

test('a message sent mid-task joins the tool results that go with the next request', () => {
  // Native tools: the last thing in the conversation is a tool result
  const native = [{ role: 'user', content: 'fix it', turnId: 't1' }, { role: 'assistant', content: '', nativeToolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] }, { role: 'tool', content: '[read_file: a.ts] …', toolCallId: 'c1', toolName: 'read_file' }];
  addSteer(native, '  use the v2 API  ');
  assert.equal(native.length, 3, 'no turn is added between a tool call and its result, or after it');
  assert.equal(native[2].content, '[read_file: a.ts] …\n\n' + steerText('use the v2 API'));
  assert.match(native[2].content, /\[Message from the user, sent while you were working on the task above\]\nuse the v2 API\n\[End of the message\. Take it into account from now on/);
  // Text tools: the results are a user message; still one user turn
  const fenced = [{ role: 'user', content: 'fix it', turnId: 't1' }, { role: 'assistant', content: '```read_file…' }, { role: 'user', content: '[Tool Results]\n\n…' }];
  addSteer(fenced, 'stop touching the tests');
  assert.equal(fenced.length, 3);
  assert.ok(fenced[2].content.startsWith('[Tool Results]\n\n…\n\n[Message from the user'));
  assert.equal(fenced[2].turnId, undefined, 'it is part of the turn in progress, so rewinding or deleting that turn removes it');
  // Anything else (an assistant message last, or images): a turn of its own
  const other = [{ role: 'assistant', content: 'working' }];
  addSteer(other, 'hello');
  assert.deepEqual(other[1], { role: 'user', content: steerText('hello') });
  const images = [{ role: 'user', content: [{ type: 'text', text: 'x' }] }];
  addSteer(images, 'hello');
  assert.equal(images.length, 2);
});

test('the reply shows where the message was taken in, on one line and not at full length', () => {
  assert.equal(steerNote('use v2\n  and keep the tests'), '\n\n> 💬 **You, while Codico was working:** use v2 and keep the tests\n\n');
  assert.ok(steerNote('x'.repeat(900)).length < 480);
  assert.equal(MAX_STEER_CHARS, 8000);
});
