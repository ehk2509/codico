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
  fs.writeFileSync(path.join(ws, 'fixtures/notes.txt'), 'NOTES-MARKER\n');
  fs.writeFileSync(path.join(ws, 'fixtures/secret.txt'), 'SECRET-TOKEN-12345\n');
  fs.writeFileSync(path.join(ws, '.codicoignore'), 'fixtures/secret.txt\n');
  fs.writeFileSync(path.join(ws, 'live/keep-me.txt'), 'keep\n');
  fs.writeFileSync(path.join(ws, 'fixtures/approve-edit.txt'), 'alpha=1\nbeta=2\n');
  fs.writeFileSync(path.join(ws, 'fixtures/approve-write.txt'), 'original\n');
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

  process.env.LIVE_WORK_DIR = work;
  const server = await start(0);
  const results = path.join(work, 'results.json');
  try {
    await runTests({
      version: '1.120.0',
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite'),
      extensionTestsEnv: { CODICO_EVAL_MODE: '1', CODICO_TEST_OPENROUTER_URL: `http://127.0.0.1:${server.address().port}/api/v1/chat/completions`, LIVE_PORT: String(server.address().port), LIVE_OUT: results, LIVE_ONLY: process.env.LIVE_ONLY || '' },
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
