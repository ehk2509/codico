const test = require('node:test');
const assert = require('node:assert/strict');

const { attentionText, decideAttention, desktopNotifyCommand } = require('../out/attention.js');
const { searchThreads } = require('../out/threadSearch.js');
const { shouldOnboard } = require('../out/onboarding.js');

const away = { mode: 'whenAway', windowFocused: false, chatVisible: true };

test('what is worth telling someone who is away', () => {
  assert.equal(attentionText({ type: 'endMessage', id: 'm1' }), 'Codico finished its reply.');
  // A turn that never started (stopped before the first request) is not a finished reply
  assert.equal(attentionText({ type: 'endMessage', id: '' }), undefined);
  assert.equal(attentionText({ type: 'writePermissionRequest', id: 'm', permId: 'p', filepath: 'src/app.ts', preview: '' }), 'Codico is waiting for your approval to change src/app.ts.');
  assert.equal(attentionText({ type: 'terminalPermissionRequest', id: 'm', permId: 'p', command: 'npm test\nrm -rf x' }), 'Codico is waiting for your approval to run: npm test');
  assert.match(attentionText({ type: 'terminalPermissionRequest', id: 'm', permId: 'p', command: 'x'.repeat(300) }), /^Codico is waiting for your approval to run: x{79}…$/);
  assert.equal(attentionText({ type: 'checkpoint', id: 'm', steps: 20 }), 'Codico paused and asks whether to continue.');
  assert.equal(attentionText({ type: 'iterationLimit', id: 'm', limit: 50 }), 'Codico stopped at its limit of 50 steps.');
  // Ordinary traffic
  for (const type of ['appendContent', 'toolStart', 'tokenUsage', 'startMessage', 'error']) { assert.equal(attentionText({ type, id: 'm', text: 'x', message: 'x' }), undefined, type); }
});

test('nothing while the chat is in view; a desktop notification only when the window is in the background', () => {
  const done = { type: 'endMessage', id: 'm1' };
  assert.equal(decideAttention(done, { mode: 'whenAway', windowFocused: true, chatVisible: true }), undefined);
  assert.deepEqual(decideAttention(done, { mode: 'whenAway', windowFocused: true, chatVisible: false }), { text: 'Codico finished its reply.', desktop: false });
  assert.deepEqual(decideAttention(done, away), { text: 'Codico finished its reply.', desktop: true });
  assert.deepEqual(decideAttention(done, { mode: 'whenAway', windowFocused: false, chatVisible: false }), { text: 'Codico finished its reply.', desktop: true });
  assert.equal(decideAttention(done, { ...away, mode: 'off' }), undefined);
  assert.equal(decideAttention({ type: 'appendContent', id: 'm', text: 'x' }, away), undefined);
});

test('desktop notification commands never put the text into a script', () => {
  const body = 'approve `rm -rf "$HOME"`; $(reboot) \' "';
  const linux = desktopNotifyCommand('linux', 'Codico', body);
  assert.equal(linux.command, 'notify-send');
  // After "--": a text that starts with a dash is not read as an option
  assert.deepEqual(linux.args.slice(-3), ['--', 'Codico', body]);
  const mac = desktopNotifyCommand('darwin', 'Codico', body);
  assert.equal(mac.command, 'osascript');
  assert.deepEqual(mac.args.slice(-2), ['Codico', body]);
  assert.ok(mac.args.slice(0, -2).every(a => !a.includes('rm -rf')));
  const win = desktopNotifyCommand('win32', 'Codico', body);
  assert.equal(win.command, 'powershell.exe');
  assert.ok(win.args.every(a => !a.includes('rm -rf')));
  assert.deepEqual(win.env, { CODICO_NOTIFY_TITLE: 'Codico', CODICO_NOTIFY_BODY: body });
  assert.equal(desktopNotifyCommand('freebsd', 'Codico', body), undefined);
});

test('search across threads: messages and names, snippets around the match', () => {
  const threads = [{ id: 'a', name: 'Login bug' }, { id: 'b', name: 'Refactor' }, { id: 'c', name: 'Docs' }];
  const messages = {
    a: [{ role: 'user', text: 'the token expires too early' }, { role: 'assistant', text: `${'x'.repeat(100)} Token refresh was off by one ${'y'.repeat(100)}` }],
    b: [{ role: 'user', text: 'token token token token token' }],
    c: [{ role: 'user', text: 'write the readme' }],
  };
  const found = searchThreads(threads, id => messages[id], '  TOKEN ');
  assert.deepEqual(found.map(r => r.threadId), ['a', 'b']);
  assert.equal(found[0].snippets[0].snippet, 'the token expires too early');
  assert.match(found[0].snippets[1].snippet, /^…x{59} Token refresh was off by one y+…$/);
  assert.equal(found[1].snippets.length, 3, 'at most three snippets per thread');
  // A thread whose name matches is listed even with no matching message
  assert.deepEqual(searchThreads(threads, id => messages[id], 'refactor'), [{ threadId: 'b', threadName: 'Refactor', snippets: [] }]);
  assert.deepEqual(searchThreads(threads, id => messages[id], '   '), []);
});

test('the Get Started guide opens by itself only for someone who has not set Codico up', () => {
  const none = { openrouter: false, 'direct:deepseek': false, ollama: true, 'claude-code': true, chatgpt: true };
  assert.equal(shouldOnboard({ onboarded: false, keys: none, modelChosen: false }), true);
  assert.equal(shouldOnboard({ onboarded: true, keys: none, modelChosen: false }), false, 'only once');
  // Someone updating from an earlier version: they have a key, or picked a model (Ollama, Claude Code)
  assert.equal(shouldOnboard({ onboarded: false, keys: { ...none, openrouter: true }, modelChosen: false }), false);
  assert.equal(shouldOnboard({ onboarded: false, keys: { ...none, 'direct:deepseek': true }, modelChosen: false }), false);
  assert.equal(shouldOnboard({ onboarded: false, keys: none, modelChosen: true }), false);
});
