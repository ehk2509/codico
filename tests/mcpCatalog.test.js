const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// A stand-in for VS Code: files in memory, one settings store, and a scripted answer to the approval dialog
const files = new Map();        // path → text
const settings = { global: undefined, workspace: undefined };
const workspaceState = new Map();
const dialogs = [];             // every dialog shown
const notices = [];
let answer;                     // the button the "user" presses next
const uri = (p) => ({ path: p, fsPath: p });
const vscodeStub = {
  Uri: { joinPath: (base, ...parts) => uri(path.posix.join(base.path, ...parts)) },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  workspace: {
    workspaceFolders: [{ uri: uri('/ws') }],
    asRelativePath: (u) => u.path.replace('/ws/', ''),
    fs: {
      readFile: async (u) => { if (!files.has(u.path)) { throw new Error('ENOENT'); } return new TextEncoder().encode(files.get(u.path)); },
      writeFile: async (u, bytes) => { files.set(u.path, new TextDecoder().decode(bytes)); },
    },
    getConfiguration: () => ({
      get: (key, fallback) => settings.workspace ?? settings.global ?? fallback,
      inspect: () => ({ globalValue: settings.global, workspaceValue: settings.workspace, workspaceFolderValue: undefined }),
      update: async (key, value, target) => { settings[target === 1 ? 'global' : 'workspace'] = value; },
    }),
  },
  window: {
    showWarningMessage: async (message, options, ...buttons) => { dialogs.push({ message, detail: options && options.detail, modal: options && options.modal, buttons }); return answer; },
    showInformationMessage: async (message) => { notices.push(message); },
    showErrorMessage: async (message) => { notices.push(message); },
  },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain); };
test.after(() => { Module._load = originalLoad; });

const { parseCatalog, catalogRows, commandLine, addToMcpJson, removeFromMcpJson } = require('../out/mcpCatalog.js');
const { handleMcpCatalogAction, mcpCatalogMessage } = require('../out/mcpCatalogCommands.js');
const { mcpFingerprint, approveMcpServers, loadMcpConfigs, APPROVED_WORKSPACE_MCP_KEY } = require('../out/mcpManager.js');

const CATALOG = fs.readFileSync(path.join(__dirname, '..', 'media', 'mcpCatalog.json'), 'utf8');
const extensionUri = uri('/ext');
const context = { workspaceState: { get: (k, d) => workspaceState.get(k) ?? d, update: async (k, v) => { workspaceState.set(k, v); } } };
function reset() {
  files.clear(); files.set('/ext/media/mcpCatalog.json', CATALOG);
  settings.global = undefined; settings.workspace = undefined; workspaceState.clear(); dialogs.length = 0; notices.length = 0; answer = undefined;
}

test('the bundled catalog is well formed: every entry is usable and pinned to a version', () => {
  const entries = parseCatalog(CATALOG);
  assert.equal(entries.length, JSON.parse(CATALOG).length);
  assert.ok(entries.length >= 3);
  assert.equal(new Set(entries.map(e => e.id)).size, entries.length, 'ids are unique');
  for (const entry of entries) {
    assert.match(entry.homepage, /^https:\/\/github\.com\//, entry.id);
    // A pinned package version: what is approved is what runs, today and next month
    assert.equal(entry.command, 'npx', entry.id);
    assert.equal(entry.args[0], '-y', entry.id);
    assert.match(entry.args[1], /^(@[a-z0-9-]+\/)?[a-z0-9-]+@\d+\.\d+\.\d+$/, entry.id);
    assert.equal(entry.args.length, 2, entry.id);
  }
});

test('entries that are not well formed are dropped, not shown', () => {
  assert.deepEqual(parseCatalog('not json'), []);
  assert.deepEqual(parseCatalog('{"id":"x"}'), []);
  const good = JSON.parse(CATALOG)[0];
  const rows = parseCatalog(JSON.stringify([good, { ...good, id: 'Bad Id' }, { ...good, id: 'no-command', command: '' }, { ...good, id: 'bad-args', args: ['-y', 3] }, null]));
  assert.deepEqual(rows.map(r => r.id), [good.id]);
});

test('the command line shown is exactly the command and its arguments', () => {
  assert.equal(commandLine('npx', ['-y', '@playwright/mcp@0.0.83']), 'npx -y @playwright/mcp@0.0.83');
  assert.equal(commandLine('node', ['my server.js', "it's"]), "node 'my server.js' 'it'\\''s'");
  const rows = catalogRows(parseCatalog(CATALOG), [{ name: 'playwright', source: 'workspace' }, { name: 'memory', source: 'settings' }, { name: 'other', source: 'settings' }]);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(byId.playwright.added, 'project');
  assert.equal(byId.memory.added, 'user');
  assert.equal(byId.context7.added, null);
  assert.equal(byId.context7.commandLine, 'npx -y @upstash/context7-mcp@4.3.0');
});

test('.mcp.json: a server is added or removed and everything else in the file is kept', () => {
  const entry = { id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp@4.3.0'] };
  assert.deepEqual(JSON.parse(addToMcpJson(undefined, entry)), { mcpServers: { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp@4.3.0'] } } });
  const existing = JSON.stringify({ note: 'keep me', mcpServers: { mine: { command: 'node', args: ['s.js'], env: { A: '1' } } } });
  const added = JSON.parse(addToMcpJson(existing, entry));
  assert.equal(added.note, 'keep me');
  assert.deepEqual(added.mcpServers.mine, { command: 'node', args: ['s.js'], env: { A: '1' } });
  assert.ok(added.mcpServers.context7);
  const removed = JSON.parse(removeFromMcpJson(JSON.stringify(added), 'context7'));
  assert.deepEqual(removed, JSON.parse(existing));
  // Removing what is not there leaves the text as it was, byte for byte
  assert.equal(removeFromMcpJson(existing, 'context7'), existing);
  // A file that cannot be understood is never overwritten
  assert.throws(() => addToMcpJson('{ broken', entry));
  assert.throws(() => addToMcpJson('[1,2]', entry), /not a JSON object/);
  assert.throws(() => addToMcpJson('{"mcpServers":[]}', entry), /"mcpServers" is not an object/);
});

test('adding shows the exact command in a modal dialog, and nothing is written when it is dismissed', async () => {
  reset();
  answer = undefined; // the dialog is closed
  assert.equal(await handleMcpCatalogAction({ action: 'add', id: 'playwright' }, context, extensionUri), false);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].modal, true);
  assert.match(dialogs[0].message, /Add the MCP server "Playwright" \(Microsoft\)\?/);
  assert.match(dialogs[0].detail, /\n    npx -y @playwright\/mcp@0\.0\.83\n/);
  assert.match(dialogs[0].detail, /Requires Node\.js/);
  assert.match(dialogs[0].detail, /It adds 25 tools/);
  assert.deepEqual(dialogs[0].buttons, ['Add to This Project', 'Add for All Projects']);
  assert.equal(files.has('/ws/.mcp.json'), false);
  assert.equal(settings.global, undefined);
});

test('"Add to This Project" writes .mcp.json and the server then starts without a second question', async () => {
  reset();
  answer = 'Add to This Project';
  assert.equal(await handleMcpCatalogAction({ action: 'add', id: 'context7' }, context, extensionUri), true);
  assert.deepEqual(JSON.parse(files.get('/ws/.mcp.json')), { mcpServers: { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp@4.3.0'] } } });
  // What Codico loads from the file is approved already: the approval covered this exact command
  dialogs.length = 0;
  const configs = await loadMcpConfigs();
  assert.deepEqual(configs.map(c => [c.name, c.source]), [['context7', 'workspace']]);
  assert.deepEqual((await approveMcpServers(context, configs)).map(c => c.name), ['context7']);
  assert.equal(dialogs.length, 0);
  // The same name with another command is a different server, and is asked about
  files.set('/ws/.mcp.json', JSON.stringify({ mcpServers: { context7: { command: 'npx', args: ['-y', 'evil-package'] } } }));
  answer = undefined;
  assert.deepEqual(await approveMcpServers(context, await loadMcpConfigs()), []);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].detail, /evil-package/);
});

test('"Add for All Projects" writes the user setting; the catalog then shows where each server is', async () => {
  reset();
  settings.global = [{ name: 'mine', command: 'node', args: ['s.js'] }];
  answer = 'Add for All Projects';
  assert.equal(await handleMcpCatalogAction({ action: 'add', id: 'memory' }, context, extensionUri), true);
  assert.deepEqual(settings.global, [{ name: 'mine', command: 'node', args: ['s.js'] }, { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory@2026.8.31'] }]);
  assert.equal(files.has('/ws/.mcp.json'), false);
  answer = 'Add to This Project';
  await handleMcpCatalogAction({ action: 'add', id: 'playwright' }, context, extensionUri);
  const shown = Object.fromEntries((await mcpCatalogMessage(extensionUri)).servers.map(s => [s.id, s.added]));
  assert.equal(shown.memory, 'user');
  assert.equal(shown.playwright, 'project');
  assert.equal(shown.context7, null);
  // Adding one that is there already asks nothing and changes nothing
  dialogs.length = 0;
  assert.equal(await handleMcpCatalogAction({ action: 'add', id: 'memory' }, context, extensionUri), false);
  assert.equal(dialogs.length, 0);
  assert.match(notices.pop(), /already configured/);
});

test('removing takes the server out of where it is, and leaves the others', async () => {
  reset();
  settings.global = [{ name: 'mine', command: 'node' }, { name: 'memory', command: 'npx', args: [] }];
  files.set('/ws/.mcp.json', JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: [] }, theirs: { command: 'node' } } }));
  assert.equal(await handleMcpCatalogAction({ action: 'remove', id: 'memory' }, context, extensionUri), true);
  assert.deepEqual(settings.global, [{ name: 'mine', command: 'node' }]);
  assert.equal(await handleMcpCatalogAction({ action: 'remove', id: 'playwright' }, context, extensionUri), true);
  assert.deepEqual(JSON.parse(files.get('/ws/.mcp.json')), { mcpServers: { theirs: { command: 'node' } } });
  // Not configured: nothing to do
  assert.equal(await handleMcpCatalogAction({ action: 'remove', id: 'context7' }, context, extensionUri), false);
});

test('the panel can only name a catalog entry: an unknown id, or a command of its own, does nothing', async () => {
  reset();
  answer = 'Add for All Projects';
  assert.equal(await handleMcpCatalogAction({ action: 'add', id: 'not-in-catalog' }, context, extensionUri), false);
  assert.equal(await handleMcpCatalogAction({ action: 'add', id: 'memory', command: 'rm', args: ['-rf', '/'] }, context, extensionUri), true);
  assert.deepEqual(settings.global, [{ name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory@2026.8.31'] }]);
  assert.equal(await handleMcpCatalogAction({ action: 'open' }, context, extensionUri), false);
});

test('a broken .mcp.json is reported and left untouched', async () => {
  reset();
  files.set('/ws/.mcp.json', '{ broken');
  answer = 'Add to This Project';
  assert.equal(await handleMcpCatalogAction({ action: 'add', id: 'memory' }, context, extensionUri), false);
  assert.equal(files.get('/ws/.mcp.json'), '{ broken');
  assert.match(notices.join('\n'), /\.mcp\.json could not be updated/);
});

test('approvals given before this version still hold: the fingerprint is unchanged', () => {
  const crypto = require('node:crypto');
  const cfg = { name: 'x', command: 'node', args: ['a'], env: { K: 'v' }, source: 'workspace' };
  const old = crypto.createHash('sha256').update(JSON.stringify({ name: cfg.name, command: cfg.command, args: cfg.args ?? [], env: cfg.env ?? {} })).digest('hex');
  assert.equal(mcpFingerprint(cfg), old);
  assert.equal(APPROVED_WORKSPACE_MCP_KEY, 'codico.approvedWorkspaceMcp.v1');
});
