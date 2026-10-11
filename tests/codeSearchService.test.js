const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

// A stand-in for VS Code with two workspace folders held in memory
const FileType = { File: 1, Directory: 2, SymbolicLink: 64 };
const files = new Map();          // "web/src/a.ts" → text  (the first segment is the folder)
const links = new Set();          // paths that are symbolic links
const symbolAnswers = new Map();  // name asked → [{ name, file, line }]
const asked = [];
let folderListeners = [];
const uri = (p) => ({ scheme: 'mem', path: p, fsPath: p, toString: () => `mem:${p}` });
const folders = [{ name: 'web', uri: uri('/web'), index: 0 }, { name: 'api', uri: uri('/api'), index: 1 }];
let openFolders = folders;
const key = (u) => u.path.replace(/^\//, '');
const vscodeStub = {
  FileType,
  Uri: { joinPath: (base, ...parts) => uri(path.posix.join(base.path, ...parts)), file: (p) => uri(p) },
  workspace: {
    get workspaceFolders() { return openFolders; },
    getWorkspaceFolder: (u) => openFolders.find(f => u.path === f.uri.path || u.path.startsWith(f.uri.path + '/')),
    asRelativePath: (u, includeFolder) => { const k = key(u); return includeFolder ? k : k.slice(k.indexOf('/') + 1); },
    getConfiguration: () => ({ get: (name, fallback) => fallback }),
    onDidChangeWorkspaceFolders: (listener) => { folderListeners.push(listener); return { dispose() {} }; },
    fs: {
      readFile: async (u) => { const k = key(u); if (!files.has(k)) { throw new Error('ENOENT ' + k); } return new TextEncoder().encode(files.get(k)); },
      readDirectory: async (u) => {
        const prefix = key(u) + '/'; const seen = new Map();
        for (const k of files.keys()) {
          if (!k.startsWith(prefix)) { continue; }
          const rest = k.slice(prefix.length); const name = rest.split('/')[0]; const full = prefix + name;
          const type = (rest.includes('/') ? FileType.Directory : FileType.File) | (links.has(full) ? FileType.SymbolicLink : 0);
          seen.set(name, type);
        }
        return [...seen.entries()];
      },
    },
  },
  commands: {
    executeCommand: async (command, name) => {
      assert.equal(command, 'vscode.executeWorkspaceSymbolProvider');
      asked.push(name);
      return (symbolAnswers.get(name) ?? []).map(s => ({ name: s.name, location: { uri: uri('/' + s.file), range: { start: { line: s.line - 1 } } } }));
    },
  },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain); };
test.after(() => { Module._load = originalLoad; });

const { CodeSearchService } = require('../out/codeSearchService.js');

function workspace() {
  files.clear(); links.clear(); symbolAnswers.clear(); asked.length = 0; openFolders = folders;
  const pad = Array.from({ length: 16 }, (_, i) => `  // filler ${i}`).join('\n');
  files.set('web/src/cart.ts', `import { priceOf } from './price';\n${pad}\nexport function cartTotal(items) {\n  return items.reduce((sum, item) => sum + priceOf(item), 0);\n}\n`);
  files.set('web/src/price.ts', 'export function priceOf(item) {\n  return item.cents;\n}\n');
  files.set('web/.env', 'STRIPE_SECRET=sk_live_abc\n');
  files.set('web/node_modules/lib/index.js', 'export function cartTotal() {}\n');
  files.set('api/billing/invoice.py', 'def invoice_total(order):\n    return order.amount\n');
  files.set('api/billing/secrets.py', 'API_KEY = "hunter2"  # invoice total key\n');
  files.set('api/.codicoignore', 'billing/secrets.py\n');
  files.set('api/linked/outside.py', 'def invoice_total_outside(): pass\n');
  links.add('api/linked');
}
const top = (text) => [...text.matchAll(/^\d+\. (\S+?):\d+-\d+/gm)].map(m => m[1]);

test('with several folders open, every folder is searched and a file is named folder/path', async () => {
  workspace();
  const service = new CodeSearchService();
  const cart = await service.search('cart total', 8, '');
  assert.deepEqual(top(cart.text)[0], 'web/src/cart.ts');
  assert.match(cart.text, /defines: cartTotal/);
  const invoice = await service.search('invoice total', 8, '');
  assert.equal(top(invoice.text)[0], 'api/billing/invoice.py');
  // The importer is named the same way
  assert.match((await service.search('price of an item', 8, '')).text, /1\. web\/src\/price\.ts:[\s\S]*used by: web\/src\/cart\.ts/);
  // Only one folder
  assert.deepEqual(top((await service.search('total', 8, 'api')).text).every(f => f.startsWith('api/')), true);
});

test('what the file tools refuse is not indexed: ignored files, links out of the folder, .env, dependencies', async () => {
  workspace();
  const service = new CodeSearchService();
  const all = [await service.search('invoice total key', 8, ''), await service.search('stripe secret', 8, ''), await service.search('cart total', 8, ''), await service.search('invoice total outside', 8, '')].map(r => r.text).join('\n');
  assert.doesNotMatch(all, /secrets\.py|hunter2/, 'excluded by that folder\'s .codicoignore');
  assert.doesNotMatch(all, /\.env|sk_live/);
  assert.doesNotMatch(all, /node_modules/);
  assert.doesNotMatch(all, /linked\/outside/, 'a symbolic link is not followed');
});

test('a language server\'s symbols are asked for by name and lift the place they point at', async () => {
  workspace();
  // The pattern matcher cannot see this declaration; the language server can
  files.set('web/src/legacy.js', `${Array.from({ length: 30 }, (_, i) => `// note ${i}`).join('\n')}\nObject.defineProperty(exports, 'refundOrder', { value: () => 1 });\n`);
  symbolAnswers.set('refundOrder', [{ name: 'refundOrder()', file: 'web/src/legacy.js', line: 31 }, { name: 'refundOrder', file: 'elsewhere/not-indexed.js', line: 1 }]);
  const service = new CodeSearchService();
  const result = await service.search('where is refundOrder declared', 8, '');
  assert.deepEqual(asked, ['refundOrder'], 'only identifiers are sent to the language server');
  assert.equal(top(result.text)[0], 'web/src/legacy.js');
  assert.match(result.text, /1\. web\/src\/legacy\.js:\d+-\d+  defines: refundOrder\n/);
  assert.doesNotMatch(result.text, /not-indexed/, 'a symbol in a file that is not indexed is ignored');
});

test('the embeddings index, when it has vectors, brings in a match no word of the question is in', async () => {
  workspace();
  const calls = [];
  const semantic = { status: { hasVectors: true }, search: async (query, k) => { calls.push([query, k]); return [{ file: 'api/billing/invoice.py', startLine: 1 }]; } };
  const withMeaning = new CodeSearchService(() => semantic);
  const found = await withMeaning.search('money owed by a customer', 8, '');
  assert.deepEqual(calls, [['money owed by a customer', 8]]);
  assert.equal(top(found.text)[0], 'api/billing/invoice.py');
  // Without vectors it is not asked, and the search still works
  const noVectors = new CodeSearchService(() => ({ status: { hasVectors: false }, search: async () => { throw new Error('must not be called'); } }));
  assert.match((await noVectors.search('money owed by a customer', 8, '')).text, /No match in \d+ indexed files/);
  // An embeddings search that fails or hangs does not fail the search
  const broken = new CodeSearchService(() => ({ status: { hasVectors: true }, search: async () => { throw new Error('HTTP 500'); } }));
  assert.equal(top((await broken.search('cart total', 8, '')).text)[0], 'web/src/cart.ts');
});

test('edits are applied before the next search, and a change of folders starts the index again', async () => {
  workspace();
  const service = new CodeSearchService();
  assert.match((await service.search('zebra quokka', 8, '')).text, /No match/);
  files.set('web/src/zoo.ts', 'export function zebraQuokka() { return 1; }\n');
  service.changed(uri('/web/src/zoo.ts'));
  assert.equal(top((await service.search('zebra quokka', 8, '')).text)[0], 'web/src/zoo.ts');
  // The agent's own write, by the path it used
  files.set('api/billing/refund.py', 'def okapi_refund():\n    pass\n');
  service.changedPath('api/billing/refund.py');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(top((await service.search('okapi refund', 8, '')).text)[0], 'api/billing/refund.py');
  files.delete('web/src/zoo.ts');
  service.removed(uri('/web/src/zoo.ts'));
  assert.match((await service.search('zebra quokka', 8, '')).text, /No match/);
  // One folder closed: its files are gone from the results, and paths lose the folder prefix
  openFolders = [folders[0]];
  folderListeners.forEach(listener => listener());
  const after = await service.search('total', 8, '');
  assert.deepEqual(top(after.text), ['src/cart.ts']);
});

test('the tool never throws: a failure is its result', async () => {
  workspace();
  openFolders = [];
  const service = new CodeSearchService();
  const none = await service.run({ query: 'x' });
  assert.equal(none.success, true);
  assert.match(none.text, /ERROR: no folder is open/);
  openFolders = folders;
  assert.match((await service.run({ query: '   ' })).text, /ERROR: give a query/);
  const ok = await service.run({ query: 'cart total', path: 'web', maxResults: 1 });
  assert.equal(ok.label, 'cart total in web — 1 result');
});
