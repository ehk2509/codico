// Live agent suite: runs the real Codico agent loop inside a real VS Code against a
// local fake model server (no API key, no cost) and checks what actually happened —
// files on disk, tool results, request counts and timings.
//
//   npm install --no-save @vscode/test-electron@2.5.2
//   npm run compile && node tests/vscode-live/run.js     (Linux/macOS; CI uses xvfb-run)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
const { start } = require('./fakeServer');

// When launched from inside VS Code (e.g. its integrated terminal) these would make
// the test instance run as plain Node or attach to the running editor.
for (const key of Object.keys(process.env)) {
  if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')) { delete process.env[key]; }
}

async function main() {
  const root = path.resolve(__dirname, '../..');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-live-'));
  const ws = path.join(work, 'ws');
  fs.mkdirSync(path.join(ws, 'fixtures'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'live'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'fixtures/config.txt'), 'host=localhost\nport=80\n');
  // What the stand-in model runs when asked to verify a change
  fs.writeFileSync(path.join(ws, 'fixtures/LIVE-VERIFY.test.js'), "require('node:test')('LIVE-VERIFY ok', () => {});\n");
  fs.writeFileSync(path.join(ws, 'fixtures/notes.txt'), 'NOTES-MARKER\n');
  fs.writeFileSync(path.join(ws, 'fixtures/secret.txt'), 'SECRET-TOKEN-12345\n');
  fs.writeFileSync(path.join(ws, '.codicoignore'), 'fixtures/secret.txt\n');
  fs.writeFileSync(path.join(ws, 'live/keep-me.txt'), 'keep\n');
  fs.writeFileSync(path.join(ws, 'fixtures/numbered.txt'), 'alpha=1\nbeta=2\ngamma=3\n');
  // For the code search: a definition, a file that imports it, and a file that only mentions the words
  fs.mkdirSync(path.join(ws, 'shop'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'shop/shipping.ts'), '/** Price of sending an order. */\nexport function shippingCost(order: { weight: number }): number {\n  return 4 + order.weight * 0.5;\n}\n');
  fs.writeFileSync(path.join(ws, 'shop/checkout.ts'), "import { shippingCost } from './shipping';\n\nexport function total(order: { weight: number; price: number }): number {\n  return order.price + shippingCost(order);\n}\n");
  fs.writeFileSync(path.join(ws, 'shop/notes.md'), 'Orders are shipped on Mondays.\n');
  // Read only by subagents: their content must never reach the main conversation
  fs.writeFileSync(path.join(ws, 'fixtures/sub-native.txt'), 'SUB-NATIVE-CONTENT\n');
  fs.writeFileSync(path.join(ws, 'fixtures/sub-fenced.txt'), 'SUB-FENCED-CONTENT\n');
  // For the change report: a file to edit and a test that reads it
  fs.writeFileSync(path.join(ws, 'fixtures/pp.txt'), 'value=1\n');
  fs.writeFileSync(path.join(ws, 'fixtures/pp.test.js'), "const test = require('node:test'); const assert = require('node:assert'); const fs = require('node:fs');\ntest('value is 2', () => { assert.match(fs.readFileSync(__dirname + '/pp.txt', 'utf8'), /value=2/); });\n");
  // The project's own skills and agents (one file is unusable and must be skipped)
  fs.mkdirSync(path.join(ws, '.codico/skills/shout'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.codico/skills/Bad Name'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.codico/agents'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.codico/skills/shout/SKILL.md'), '---\nname: shout\ndescription: Use when asked to shout\n---\n\nSKILL-BODY-MARKER: answer in capital letters.\n');
  fs.writeFileSync(path.join(ws, '.codico/skills/Bad Name/SKILL.md'), 'BAD-SKILL-MARKER\n');
  fs.writeFileSync(path.join(ws, '.codico/agents/pirate.md'), '---\ndescription: Talks like a pirate\n---\n\nAGENT-BODY-MARKER: talk like a pirate.\n');
  fs.writeFileSync(path.join(ws, 'fixtures/approve-edit.txt'), 'alpha=1\nbeta=2\n');
  fs.writeFileSync(path.join(ws, 'fixtures/rewind.txt'), 'v1\n');
  fs.writeFileSync(path.join(ws, 'fixtures/long.txt'), Array.from({ length: 60 }, (_, i) => `row ${i + 1} of the long file`).join('\n'));
  fs.writeFileSync(path.join(ws, 'fixtures/hunks.txt'), 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9');
  fs.writeFileSync(path.join(ws, 'fixtures/rewind-kept.txt'), 'k1\n');
  // Project hooks, each for one narrow target so no other scenario meets them
  fs.mkdirSync(path.join(ws, 'hooked'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'hooked/locked.txt'), 'locked=1\n');
  fs.writeFileSync(path.join(ws, 'hooked/app.cfg'), 'mode=a\n');
  fs.writeFileSync(path.join(ws, 'hooked/check.js'), "const fs = require('node:fs'); const input = JSON.parse(fs.readFileSync(process.env.CODICO_HOOK_INPUT, 'utf8'));\nconsole.log('HOOK-AFTER ' + process.argv[2] + ' now ' + fs.readFileSync(process.argv[2], 'utf8').trim() + ' via ' + input.tool);\nprocess.exit(1);\n");
  fs.writeFileSync(path.join(ws, '.codico/hooks.json'), JSON.stringify({ hooks: [
    { event: 'beforeEdit', match: 'hooked/locked.txt', name: 'locked files', command: 'node -e "console.log(\'HOOK-SAYS this file is locked\'); process.exit(1)"' },
    { event: 'afterEdit', match: 'hooked/*.cfg', name: 'config check', command: 'node hooked/check.js {file}' },
    { event: 'beforeCommand', match: '*hook-forbidden*', command: 'node -e "process.exit(2)"' },
  ] }));
  fs.writeFileSync(path.join(ws, 'fixtures/approve-write.txt'), 'original\n');
  // A program with a bug, for the debugger: an item without a quantity makes the total NaN
  fs.mkdirSync(path.join(ws, 'debugme'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'debugme/calc.js'), 'function total(items) {\n  let sum = 0;\n  for (const item of items) {\n    sum += item.price * item.qty;\n  }\n  return sum;\n}\nmodule.exports = { total };\n');
  fs.writeFileSync(path.join(ws, 'debugme/run.js'), "const { total } = require('./calc');\nconst t = total([{ price: 2, qty: 3 }, { price: 5 }]);\nif (Number.isNaN(t)) { throw new Error('total is NaN'); }\nconsole.log('TOTAL ' + t);\n");
  // A small web app with a bug, for end-to-end verification: "Add" shows "Count: 01" instead of "Count: 1"
  fs.mkdirSync(path.join(ws, 'webapp'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'webapp/server.js'), "const http = require('http'), fs = require('fs'), path = require('path');\nhttp.createServer((q, s) => { const f = q.url === '/app.js' ? 'app.js' : 'index.html'; s.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : 'text/html'); s.end(fs.readFileSync(path.join(__dirname, f))); }).listen(Number(process.argv[2]), '127.0.0.1', () => console.log('webapp ready on ' + process.argv[2]));\n");
  fs.writeFileSync(path.join(ws, 'webapp/index.html'), '<!doctype html><html><body><h1>Counter</h1><p id="count">Count: 0</p><button id="add">Add</button><script src="/app.js"></script></body></html>\n');
  fs.writeFileSync(path.join(ws, 'webapp/app.js'), "let count = '0';\nconsole.error('WEBAPP-CONSOLE-ERROR: legacy counter in use');\ndocument.getElementById('add').onclick = () => { count = count + 1; document.getElementById('count').textContent = 'Count: ' + count; };\n");
  fs.writeFileSync(path.join(ws, 'fixtures/dirty.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(ws, 'fixtures/undo.txt'), 'v1\n');
  fs.writeFileSync(path.join(ws, 'fixtures/abs.txt'), 'v1\n');
  fs.writeFileSync(path.join(ws, 'fixtures/reread.txt'), 'n=0\n');
  fs.writeFileSync(path.join(ws, 'fixtures/diffme.txt'), 'before\n');
  // 700 lines in 14 sections: large enough for an outline
  fs.writeFileSync(path.join(ws, 'fixtures/big.md'), Array.from({ length: 14 }, (_, i) => `## Section ${i + 1}\n\n` + Array.from({ length: 48 }, (_, j) => `Line ${j + 1} of section ${i + 1}.`).join('\n') + '\n').join('\n'));
  // Outside the workspace, reachable only through symbolic links inside it
  fs.mkdirSync(path.join(work, 'outside'));
  fs.writeFileSync(path.join(work, 'outside/secret.txt'), 'OUTSIDE-SECRET\n');
  fs.symlinkSync(path.join(work, 'outside'), path.join(ws, 'fixtures/link'));
  fs.symlinkSync(path.join(work, 'outside/dangling-target.txt'), path.join(ws, 'fixtures/dangling'));

  // A stand-in `claude` command for the Claude Code provider (the real one is not installed in CI)
  const fakeClaude = path.join(work, 'fake-claude');
  fs.writeFileSync(fakeClaude, `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, 'tests/fixtures/fakeClaude.js')}" "$@"\n`, { mode: 0o755 });
  const fakeCodex = path.join(work, 'fake-codex');
  fs.writeFileSync(fakeCodex, `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, 'tests/fixtures/fakeCodex.js')}" "$@"\n`, { mode: 0o755 });
  process.env.LIVE_WORK_DIR = work;
  // A port nothing holds, for the web app of the verification scenario
  process.env.LIVE_APP_PORT = String(await new Promise(resolve => { const probe = require('node:net').createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); }));
  const server = await start(0);
  const results = path.join(work, 'results.json');
  try {
    await runTests({
      version: '1.120.0',
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite'),
      extensionTestsEnv: { CODICO_EVAL_MODE: '1', CODICO_TEST_OPENROUTER_URL: `http://127.0.0.1:${server.address().port}/api/v1/chat/completions`, CODICO_TEST_DIRECT_URL: `http://127.0.0.1:${server.address().port}/deepseek/v1/chat/completions`, LIVE_FAKE_CLAUDE: fakeClaude, FAKE_CLAUDE_LOG: path.join(work, 'fake-claude.jsonl'), LIVE_FAKE_CODEX: fakeCodex, FAKE_CODEX_LOG: path.join(work, 'fake-codex.jsonl'), LIVE_PORT: String(server.address().port), LIVE_APP_PORT: process.env.LIVE_APP_PORT, CODICO_TEST_ARCHIVE_URL: `http://127.0.0.1:${server.address().port}/market/archive`, CODICO_TEST_GITHUB_URL: `http://127.0.0.1:${server.address().port}`, CODICO_TEST_GITHUB_TOKEN: 'test-github-token', LIVE_OUT: results, LIVE_ONLY: process.env.LIVE_ONLY || '' },
      launchArgs: [ws, '--disable-extensions', '--skip-welcome', '--skip-release-notes',
        '--user-data-dir', path.join(work, 'user-data'), '--extensions-dir', path.join(work, 'extensions')],
    });
  } finally {
    server.close();
  }

  const rows = fs.existsSync(results) ? JSON.parse(fs.readFileSync(results, 'utf8')) : [];
  for (const r of rows) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(13)} ${String(r.ms).padStart(6)} ms ${String(r.requests).padStart(4)} req | ${r.why}`);
  }
  const failed = rows.filter(r => !r.ok).length;
  if (rows.length === 0 || failed > 0) {
    // Kept for debugging a failure
    console.log(`${rows.length - failed}/${rows.length} live scenarios passed (work dir: ${work})`);
    process.exitCode = 1;
  } else {
    // Each run leaves ~110 MB (a VS Code profile); /tmp is often a small in-memory filesystem
    console.log(`${rows.length}/${rows.length} live scenarios passed`);
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
