const test = require('node:test');
const assert = require('node:assert/strict');

const { filter, limit, groupBy, MAX_ROWS, GROUP_ORDER } = require('../media/quickActions');

const ITEMS = [
  { id: 'cmd:codico.setApiKey', label: 'Set API Key', group: 'Commands', hint: 'codico.setApiKey' },
  { id: 'cmd:codico.compact', label: 'Compact Context', group: 'Commands', hint: 'codico.compactChat' },
  { id: 'cmd:codico.openChat', label: 'Open Chat', group: 'Commands', hint: 'codico.openChat' },
  { id: 'mode:plan', label: 'Mode: Plan', group: 'Modes' },
  { id: 'model:ollama/llama3', label: 'Llama 3 (local)', group: 'Models', hint: 'ollama/llama3' },
  { id: 'model:deepseek/v4', label: 'DeepSeek v4', group: 'Models' },
  { id: 'thread:t1', label: 'Refactor the parser', group: 'Threads', hint: 'Saved conversation' },
];

test('an empty query keeps every item in its original order', () => {
  assert.deepEqual(filter(ITEMS, '').map(i => i.id), ITEMS.map(i => i.id));
  assert.deepEqual(filter(ITEMS, '   ').map(i => i.id), ITEMS.map(i => i.id));
  assert.deepEqual(filter(null, 'x'), []);
});

test('matching is case-insensitive and covers label, hint and group', () => {
  assert.deepEqual(filter(ITEMS, 'COMPACT').map(i => i.id), ['cmd:codico.compact']);
  // The hint (command id) is searchable, so users can type what the docs show
  assert.deepEqual(filter(ITEMS, 'compactChat').map(i => i.id), ['cmd:codico.compact']);
  // A group name lists that whole section
  assert.deepEqual(filter(ITEMS, 'models').map(i => i.id), ['model:ollama/llama3', 'model:deepseek/v4']);
});

test('exact and prefix label matches rank above hint and mid-label matches', () => {
  const items = [
    { id: 'hint', label: 'Something else', group: 'Commands', hint: 'open chat' },
    { id: 'mid', label: 'Reopen chat', group: 'Commands' },
    { id: 'prefix', label: 'Open chat panel', group: 'Commands' },
    { id: 'exact', label: 'Open Chat', group: 'Commands' },
  ];
  assert.deepEqual(filter(items, 'open chat').map(i => i.id), ['exact', 'prefix', 'mid', 'hint']);
});

test('equal scores keep the incoming order (stable ranking)', () => {
  const items = [
    { id: 'a', label: 'Reset A', group: 'Commands' },
    { id: 'b', label: 'Reset B', group: 'Commands' },
    { id: 'c', label: 'Reset C', group: 'Models' },
  ];
  assert.deepEqual(filter(items, 'reset').map(i => i.id), ['a', 'b', 'c']);
});

test('limit caps the row count without mutating the input', () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ id: 'i' + i, label: 'Item ' + i, group: 'Models' }));
  const capped = limit(items);
  assert.equal(capped.length, MAX_ROWS);
  assert.equal(items.length, 120);
  assert.deepEqual(limit(items, 3).map(i => i.id), ['i0', 'i1', 'i2']);
  assert.equal(limit(items, 0).length, MAX_ROWS);
});

test('groupBy returns declared order for known groups and discovery order for the rest', () => {
  const groups = groupBy([
    { id: 't', label: 'T', group: 'Threads' },
    { id: 'c', label: 'C', group: 'Commands' },
    { id: 'z', label: 'Z', group: 'Zebra' },
    { id: 'm', label: 'M', group: 'Models' },
    { id: 'a', label: 'A', group: 'Aardvark' },
  ]);
  assert.deepEqual(groups.map(g => g.group), ['Commands', 'Models', 'Threads', 'Zebra', 'Aardvark']);
  assert.deepEqual(GROUP_ORDER.slice(0, 3), ['Commands', 'Modes', 'Models']);
  assert.deepEqual(groups[0].items.map(i => i.id), ['c']);
});

test('groupBy tolerates items with no group and an empty list', () => {
  assert.deepEqual(groupBy([]), []);
  assert.deepEqual(groupBy([{ id: 'x', label: 'X' }]).map(g => g.group), ['Other']);
});
