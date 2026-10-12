const test = require('node:test');
const assert = require('node:assert/strict');
const { untilStopped } = require('../out/stopRace.js');
const { STOPPED_NOTE } = require('../out/steering.js');

const later = (ms, value, fail) => new Promise((resolve, reject) => setTimeout(() => fail ? reject(new Error(value)) : resolve(value), ms));

test('Stop ends the wait for a tool that cannot be interrupted, at once', async () => {
  const stop = new AbortController(); let told = 0;
  const started = Date.now();
  const waiting = untilStopped(later(3000, 'page loaded'), stop.signal, () => { told++; return '[fetch_url] Stopped by the user before it finished.'; });
  setTimeout(() => stop.abort(), 30);
  assert.equal(await waiting, '[fetch_url] Stopped by the user before it finished.');
  assert.ok(Date.now() - started < 1000, 'did not wait for the page');
  assert.equal(told, 1);
});

test('without Stop the tool result is passed through, and its failure too', async () => {
  const stop = new AbortController(); let told = 0;
  assert.equal(await untilStopped(later(10, 'result'), stop.signal, () => { told++; return 'stopped'; }), 'result');
  await assert.rejects(untilStopped(later(10, 'boom', true), stop.signal, () => 'stopped'), /boom/);
  // Stop after the tool has finished changes nothing, and says nothing
  stop.abort();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(told, 0);
});

test('already stopped: the answer is immediate, and a failure of the abandoned work is not an unhandled error', async () => {
  const stop = new AbortController(); stop.abort();
  const unhandled = []; const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  assert.equal(await untilStopped(later(20, 'late failure', true), stop.signal, () => 'stopped'), 'stopped');
  const second = new AbortController();
  const waiting = untilStopped(later(40, 'late failure', true), second.signal, () => 'stopped');
  second.abort();
  assert.equal(await waiting, 'stopped');
  await new Promise(r => setTimeout(r, 80));
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, []);
  assert.match(STOPPED_NOTE, /^\(The user stopped the task here/);
});
