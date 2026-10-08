const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFollowUps } = require('../out/followUps.js');

test('follow-up suggestions are parsed from a JSON array, with or without fences', () => {
  assert.deepEqual(parseFollowUps('["Run the tests", "Add docs", "Refactor X", "extra"]'), ['Run the tests', 'Add docs', 'Refactor X']);
  assert.deepEqual(parseFollowUps('```json\n["a", "b"]\n```'), ['a', 'b']);
  assert.deepEqual(parseFollowUps('Sure! Here are some ideas'), []);
  assert.deepEqual(parseFollowUps('{"a": 1}'), []);
});
