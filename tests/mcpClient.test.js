const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const warnings = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') { return { window: { showWarningMessage: (m) => { warnings.push(m); return Promise.resolve(); } } }; }
  return originalLoad.call(this, request, parent, isMain);
};
const { McpClient } = require('../out/mcpClient.js');
const { McpManager } = require('../out/mcpManager.js');
test.after(() => { Module._load = originalLoad; });

const SERVER = path.join(__dirname, 'fixtures', 'fakeMcpServer.js');
const statusFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codico-mcp-')), 'status.json');
const readStatus = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } }; // {} until written
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) { return true; } await new Promise(r => setTimeout(r, 25)); } return false; };

test('a request from the server is answered, not mistaken for the reply to ours', async () => {
  const file = statusFile();
  const client = new McpClient('fake', process.execPath, [SERVER, 'normal', file]);
  try {
    await client.connect();
    assert.deepEqual(client.tools.map(t => t.name), ['echo'], 'the tool list is the real reply');
    assert.ok(await until(() => readStatus(file).pingAnswered), 'the server ping got a reply');
    const result = await client.callTool('echo', { text: 'hi' });
    assert.equal(result.content[0].text, 'hi');
  } finally { client.disconnect(); }
});

test('Stop cancels a running call and tells the server', async () => {
  const file = statusFile();
  const client = new McpClient('fake', process.execPath, [SERVER, 'normal', file]);
  try {
    await client.connect();
    const stop = new AbortController();
    const call = client.callTool('slow', {}, stop.signal);
    setTimeout(() => stop.abort(), 100);
    const started = Date.now();
    await assert.rejects(call, /stopped/);
    assert.ok(Date.now() - started < 2000, 'not left waiting for the timeout');
    assert.ok(await until(() => readStatus(file).cancelled?.requestId > 0), 'the server was told');
  } finally { client.disconnect(); }
});

test('a server that stops reading and exits does not crash the host', async () => {
  const client = new McpClient('fake', process.execPath, [SERVER, 'deaf', statusFile()]);
  await client.connect();
  // Its input is closed: this write fails asynchronously (EPIPE) and must not be an unhandled error
  await assert.rejects(client.callTool('echo', { text: 'hi' }), /exited|disconnected/);
  client.disconnect();
});

test('a server whose handshake fails is not left running', async () => {
  const file = statusFile();
  const manager = new McpManager();
  const [status] = await manager.connectAll([{ name: 'bad', command: process.execPath, args: [SERVER, 'badhandshake', file] }]);
  assert.equal(status.connected, false);
  assert.match(status.error, /refusing/);
  const pid = readStatus(file).pid;
  assert.ok(pid > 0, 'the server started');
  assert.ok(await until(() => !alive(pid)), 'the process was stopped');
});
