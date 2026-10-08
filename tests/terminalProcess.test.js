const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTerminalEnvironment, runTerminalProcess } = require('../out/terminalProcess.js');

test('terminal runner streams output and reports success', async () => {
  const controller = new AbortController();
  let streamed = '';
  const result = await runTerminalProcess({
    command: 'node -e "console.log(\'codico-ok\')"',
    timeoutMs: 5000,
    signal: controller.signal,
    onChunk: text => { streamed += text; },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stopped, false);
  assert.match(streamed, /codico-ok/);
  assert.match(result.output, /codico-ok/);
});

test('terminal runner times out hung commands', async () => {
  const controller = new AbortController();
  const result = await runTerminalProcess({
    command: 'node -e "setTimeout(() => {}, 5000)"',
    timeoutMs: 100,
    signal: controller.signal,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.stopped, false);
});

test('terminal runner honors user abort', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 75);
  const result = await runTerminalProcess({
    command: 'node -e "setTimeout(() => {}, 5000)"',
    timeoutMs: 5000,
    signal: controller.signal,
  });

  assert.equal(result.stopped, true);
});


test('terminal environment keeps execution essentials and drops secrets', () => {
  const env = buildTerminalEnvironment({
    PATH: '/usr/bin',
    Path: 'C:\\Tools',
    HOME: '/home/user',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    OPENAI_API_KEY: 'secret',
    GITHUB_TOKEN: 'secret',
    AWS_SECRET_ACCESS_KEY: 'secret',
    CUSTOM_SECRET: 'secret',
  });

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.Path, 'C:\\Tools');
  assert.equal(env.HOME, '/home/user');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.LC_ALL, 'C');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.CUSTOM_SECRET, undefined);
});
