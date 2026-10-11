const test = require('node:test');
const assert = require('node:assert/strict');

const { tokenize, stem, extractSymbols, extractImports, chunkBySymbols, CodeIndex, bestLines, renderSearchResults } = require('../out/codeSearch.js');
const { parseToolBody } = require('../out/toolParser.js');
const { nativeToolCallToToolCall, getNativeToolDefinitions } = require('../out/nativeTools.js');
const { SUBAGENT_TOOLS } = require('../out/subagent.js');
const { SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT } = require('../out/openRouterClient.js');

const names = (lines, ext) => extractSymbols(lines.split('\n'), ext).map(s => `${s.kind} ${s.name}@${s.line}`);

test('identifiers are searched by their parts, in any naming style, and by word stem', () => {
  assert.deepEqual(tokenize('autoCompactThreshold'), ['auto', 'compact', 'threshold']);
  assert.deepEqual(tokenize('MAX_RETRY_COUNT'), ['max', 'retry', 'count']);
  assert.deepEqual(tokenize('parseHTTPResponse'), ['parse', 'http', 'response']);
  assert.deepEqual(tokenize('where is the compaction threshold checked?'), ['compact', 'threshold', 'check']);
  // One word for search, whatever its ending
  assert.deepEqual(['compaction', 'compacted', 'compacts', 'compacting', 'compact'].map(stem), Array(5).fill('compact'));
  assert.deepEqual(['retries', 'queries'].map(stem), ['retry', 'query']);
  assert.equal(stem('class'), 'class', 'short words are left alone');
  assert.deepEqual(tokenize('x = a + 1 // i'), [], 'one-letter names carry nothing');
});

test('definitions are found by pattern in the common languages', () => {
  assert.deepEqual(names('export async function loadUser(id) {\nexport class Session {\n  private async refresh(token: string): Promise<void> {\nconst add = (a, b) => a + b;\nexport const MAX_RETRIES = 3;\nexport interface Options {\n  if (x) {\n  functionDeclarations: tools.map(t => t),', 'ts'),
    ['function loadUser@0', 'class Session@1', 'method refresh@2', 'function add@3', 'constant MAX_RETRIES@4', 'type Options@5']);
  assert.deepEqual(names('class Repo:\n    def find(self, id):\nasync def main():\nTIMEOUT = 30', 'py'), ['class Repo@0', 'function find@1', 'function main@2', 'constant TIMEOUT@3']);
  assert.deepEqual(names('func (s *Server) Handle(w http.ResponseWriter) {\ntype Server struct {', 'go'), ['function Handle@0', 'type Server@1']);
  assert.deepEqual(names('pub async fn connect(addr: &str) -> Result<()> {\npub struct Pool {\nimpl Drop for Pool {', 'rs'), ['function connect@0', 'type Pool@1', 'impl Pool@2']);
  assert.deepEqual(names('public class OrderService {\n    public List<Order> findAll(int page) {', 'java'), ['class OrderService@0', 'method findAll@1']);
  assert.deepEqual(names('function f() {}', 'txt'), [], 'an unknown file type has no symbols, and is still searchable as text');
  assert.deepEqual(names('x'.repeat(500) + ' function f() {}', 'js'), [], 'a minified line is not scanned');
});

test('chunks start where a definition starts, with its comment, and stay a readable size', () => {
  const body = (n) => Array.from({ length: n }, (_, i) => `  step${i}();`);
  const lines = ['import x from "./x";', '', ...body(18), '/** Loads a user. */', 'export function loadUser() {', ...body(20), '}', '', 'export function saveUser() {', ...body(200), '}'];
  const chunks = chunkBySymbols(lines, extractSymbols(lines, 'ts'));
  assert.deepEqual(chunks[1].symbols, ['loadUser']);
  assert.equal(lines[chunks[1].start], '/** Loads a user. */', 'the doc comment belongs to the function');
  assert.equal(lines[chunks[2].start], 'export function saveUser() {');
  assert.ok(chunks.every(c => c.end - c.start <= 95), 'a long body is split');
  assert.equal(chunks[chunks.length - 1].end, lines.length);
  // Every line is in exactly one chunk
  assert.equal(chunks.reduce((n, c) => n + (c.end - c.start), 0), lines.length);
  assert.deepEqual(chunkBySymbols([], []), []);
});

function sampleIndex() {
  const index = new CodeIndex();
  const pad = (n) => Array.from({ length: n }, (_, i) => `  // filler ${i}`).join('\n');
  index.addFile('src/net/retry.ts', `import { sleep } from './sleep';\n${pad(16)}\n/** Waits longer after each failed attempt. */\nexport function backoffDelay(attempt: number): number {\n  return Math.min(30000, 250 * 2 ** attempt);\n}\n${pad(16)}\nexport async function withRetry(run) {\n  for (let attempt = 0; attempt < 5; attempt++) { await sleep(backoffDelay(attempt)); }\n}\n`);
  index.addFile('src/net/sleep.ts', 'export function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }\n');
  index.addFile('src/ui/panel.ts', `import { withRetry } from '../net/retry';\n${pad(16)}\nexport function renderPanel() {\n  // retry retry retry: the word alone, many times, in a file that only mentions it\n  return withRetry(() => fetch('/panel'));\n}\n`);
  index.addFile('docs/notes.md', '# Notes\n\nThe delay between attempts doubles.\n');
  index.addFile('pkg/util.py', 'from .helpers import clamp\n\ndef backoff(attempt):\n    return clamp(attempt)\n');
  index.addFile('pkg/helpers.py', 'def clamp(value):\n    return max(0, value)\n');
  return index;
}

test('a description finds the definition: the chunk that defines the symbol outranks ones that mention it', () => {
  const index = sampleIndex();
  const hits = index.search('how is the retry backoff delay computed');
  assert.equal(hits[0].file, 'src/net/retry.ts');
  assert.deepEqual(hits[0].symbols, ['backoffDelay']);
  assert.ok(hits[0].matched.includes('backoff') && hits[0].matched.includes('delay'));
  // By identifier, in another naming style
  assert.equal(index.search('backoff_delay')[0].symbols[0], 'backoffDelay');
  assert.equal(index.search('renderPanel')[0].file, 'src/ui/panel.ts');
  // Under a folder only
  assert.deepEqual(index.search('retry', 8, 'src/ui').map(h => h.file), ['src/ui/panel.ts']);
  assert.deepEqual(index.search('zzzunknownzzz'), []);
  assert.deepEqual(index.search('the of and'), [], 'only stop words: nothing to search for');
});

test('at most three chunks of one file are returned, so a big file cannot crowd out the rest', () => {
  const index = new CodeIndex();
  const fn = (i) => `export function handler${i}() {\n${Array.from({ length: 18 }, () => '  processQueue();').join('\n')}\n}\n`;
  index.addFile('src/big.ts', Array.from({ length: 12 }, (_, i) => fn(i)).join('\n'));
  index.addFile('src/small.ts', 'export function processQueue() { return 1; }\n');
  const files = index.search('process queue', 8).map(h => h.file);
  assert.equal(files.filter(f => f === 'src/big.ts').length, 3);
  assert.ok(files.includes('src/small.ts'));
});

test('the index follows the files: a changed file is replaced, a removed one is gone', () => {
  const index = sampleIndex();
  assert.equal(index.fileCount, 6);
  index.addFile('src/net/sleep.ts', 'export function pause(ms: number) { return new Promise(r => setTimeout(r, ms)); }\n');
  assert.equal(index.fileCount, 6);
  assert.equal(index.search('pause')[0].file, 'src/net/sleep.ts');
  assert.deepEqual(index.search('sleep').filter(h => h.file === 'src/net/sleep.ts' && h.symbols.includes('sleep')), []);
  index.removeFile('src/ui/panel.ts');
  assert.equal(index.has('src/ui/panel.ts'), false);
  assert.deepEqual(index.search('renderPanel'), []);
  assert.ok(index.staleShare > 0, 'replaced entries are counted, so the owner knows when to rebuild');
});

test('imports say who uses a file', () => {
  assert.deepEqual(extractImports(`import a from './a';\nimport { b } from "../lib/b.js";\nconst c = require('./c');\nconst d = await import('./d');\nimport 'react';`, 'ts'), ['./a', '../lib/b.js', './c', './d', 'react']);
  assert.deepEqual(extractImports('from .helpers import clamp\nfrom ..core.db import Session\nimport os', 'py'), ['.helpers', '..core.db']);
  const index = sampleIndex();
  assert.deepEqual(index.importersOf('src/net/retry.ts'), ['src/ui/panel.ts']);
  assert.deepEqual(index.importersOf('src/net/sleep.ts'), ['src/net/retry.ts']);
  assert.deepEqual(index.importersOf('pkg/helpers.py'), ['pkg/util.py']);
  assert.deepEqual(index.importersOf('docs/notes.md'), []);
  // "./x.js" in TypeScript source means x.ts
  const ts = new CodeIndex();
  ts.addFile('src/a.ts', "import { b } from './b.js';\n");
  ts.addFile('src/b.ts', 'export const b = 1;\n');
  assert.deepEqual(ts.importersOf('src/b.ts'), ['src/a.ts']);
});

test('the result shows the lines that matter, numbered, and who uses the file', () => {
  const lines = ['/** Waits longer after each failed attempt. */', 'export function backoffDelay(attempt: number): number {', '  const base = 250;', '  return Math.min(30000, base * 2 ** attempt);', '}'];
  const hit = { file: 'src/net/retry.ts', startLine: 1, endLine: 5, score: 3, symbols: ['backoffDelay'], matched: ['backoff', 'delay'] };
  const picked = bestLines(lines, hit, tokenize('retry backoff delay attempt'), 2);
  assert.deepEqual(picked, [0, 1].includes(picked[0]) ? picked : [], 'the definition line and the best-matching line');
  assert.ok(picked.includes(1), 'the line that defines the symbol is shown');
  const text = renderSearchResults('retry backoff delay', [{ ...hit, lines: [{ number: 2, text: lines[1] }], usedBy: ['src/ui/panel.ts'] }], 412);
  assert.match(text, /^\[search_code: retry backoff delay\] 1 best match in 412 indexed files, best first\./);
  assert.match(text, /\n1\. src\/net\/retry\.ts:1-5  defines: backoffDelay\n   2\texport function backoffDelay\(attempt: number\): number \{\n   used by: src\/ui\/panel\.ts$/);
  assert.match(renderSearchResults('nothing', [], 412), /No match in 412 indexed files\. Try other words for the same idea, or search_files for exact text\./);
});

test('the search_code tool in both formats, for the agent and for subagents', () => {
  assert.deepEqual(parseToolBody('search_code', 'query: where the retry delay is computed\npath: src/net\nmax_results: 5'), [{ type: 'search_code', query: 'where the retry delay is computed', path: 'src/net', maxResults: 5 }]);
  assert.deepEqual(parseToolBody('search_code', 'query: session refresh'), [{ type: 'search_code', query: 'session refresh' }]);
  assert.deepEqual(parseToolBody('search_code', 'path: src'), []);
  assert.deepEqual(nativeToolCallToToolCall({ name: 'search_code', arguments: { query: 'retry', max_results: 3 } }), { type: 'search_code', query: 'retry', maxResults: 3 });
  assert.equal(nativeToolCallToToolCall({ name: 'search_code', arguments: {} }), null);
  assert.ok(getNativeToolDefinitions(true).some(t => t.name === 'search_code'), 'available in Ask mode: it only reads');
  assert.ok(SUBAGENT_TOOLS.has('search_code'));
  for (const prompt of [SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT]) {
    assert.match(prompt, /```search_code\nquery: <what you are looking for, in words or identifiers>\npath: <optional folder>\n```/);
    assert.match(prompt, /start with search_code \(describe it in words/);
  }
});
