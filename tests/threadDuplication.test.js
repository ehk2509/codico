const test = require('node:test');
const assert = require('node:assert/strict');
const { duplicateThread, duplicateStoredThread } = require('../out/threadDuplication.js');

const source = {
  id: 'a', name: 'Login work', createdAt: 100, updatedAt: 200,
  messageCount: 2, preview: 'add login', pinned: true, tokens: 500, costUsd: 0.02,
};
const history = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }, { role: 'assistant', content: 'hi' }];
const display = [{ role: 'user', text: 'hello', parts: [{ type: 'text', text: 'hello' }] }, { role: 'assistant', text: 'hi' }];

// A stand-in for the VS Code Memento the extension stores threads in.
function fakeStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  const writes = [];
  return {
    writes,
    get: (key, fallback) => (data.has(key) ? data.get(key) : fallback),
    update: async (key, value) => { writes.push(key); if (value === undefined) { data.delete(key); } else { data.set(key, value); } },
  };
}
const keys = { index: 'threads', activeId: 'active', history: id => 'history.' + id, display: id => 'display.' + id };

test('the copy is named "<original> (copy)", keeps the conversation size, and is never pinned', () => {
  const copy = duplicateThread(source, history, display, 'x', 1234);
  assert.equal(copy.entry.id, 'x');
  assert.equal(copy.entry.name, 'Login work (copy)');
  assert.equal(copy.entry.createdAt, 1234);
  assert.equal(copy.entry.updatedAt, 1234);
  assert.equal(copy.entry.messageCount, 2);
  assert.equal(copy.entry.preview, 'add login');
  assert.equal(copy.entry.hasBeenNamed, true, 'the "(copy)" name survives the first message');
  assert.ok(!('pinned' in copy.entry), 'a copy of a pinned thread is not pinned');
});

test('later changes to either thread cannot reach the other', () => {
  const copy = duplicateThread(source, history, display, 'x', 1234);
  copy.history[0].content[0].text = 'changed in the copy';
  copy.display[0].parts[0].text = 'changed in the copy';
  assert.equal(history[0].content[0].text, 'hello');
  assert.equal(display[0].parts[0].text, 'hello');
  assert.notEqual(copy.history, history, 'the copy has its own history');
  assert.notEqual(copy.display, display, 'the copy has its own transcript');
  assert.notEqual(copy.history[0], history[0], 'no nested object is shared');
});

test('duplicating stores an independent thread, unpinned, and makes it active', async () => {
  const storage = fakeStorage({ threads: [source], 'history.a': history, 'display.a': display });
  const copy = await duplicateStoredThread(storage, keys, 'a', { id: 'a', history, display }, 'x', 1234);
  assert.equal(copy.entry.name, 'Login work (copy)');
  const threads = storage.get('threads', []);
  assert.equal(threads.length, 2, 'the original stays and the copy is added');
  assert.equal(threads[0], source, 'the original is left exactly as it was');
  assert.equal(threads[1].id, 'x');
  assert.equal(storage.get('active', null), 'x', 'the copy becomes the active thread');
  assert.deepEqual(storage.get('history.x', null), history);
  assert.deepEqual(storage.get('display.x', null), display);
  assert.equal(storage.get('history.a', null)[0].content[0].text, 'hello', 'the original still has its own copy');
});

test('copying the open thread saves it first, so nothing just streamed is lost', async () => {
  const storage = fakeStorage({ threads: [source], 'history.a': [{ role: 'user', content: 'stale' }], 'display.a': [] });
  const live = [{ role: 'user', content: 'fresh' }];
  await duplicateStoredThread(storage, keys, 'a', { id: 'a', history: live, display: [] }, 'x', 1);
  assert.deepEqual(storage.get('history.a', null), live, 'the open thread is saved before it is read');
  assert.deepEqual(storage.get('history.x', null), live);
});

test('a thread that no longer exists is not duplicated', async () => {
  const storage = fakeStorage({ threads: [source] });
  assert.equal(await duplicateStoredThread(storage, keys, 'missing', { id: 'a', history: [], display: [] }, 'x', 1), undefined);
  assert.equal(storage.get('threads', []).length, 1);
  assert.equal(storage.get('active', null), null, 'a failed duplicate does not change the active thread');
});
