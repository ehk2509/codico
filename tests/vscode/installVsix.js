const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} = require('@vscode/test-electron');

async function main() {
  const vsix = path.resolve(process.argv[2] || 'codico.vsix');
  assert.equal(fs.existsSync(vsix), true, `VSIX not found: ${vsix}`);

  const vscodeExecutablePath = await downloadAndUnzipVSCode('1.120.0');
  const [cliPath, ...baseArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codico-vsix-smoke-'));

  const install = cp.spawnSync(
    cliPath,
    [...baseArgs, '--user-data-dir', userDataDir, '--install-extension', vsix, '--force'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (install.status !== 0) {
    throw new Error(`VSIX install failed:\n${install.stdout}\n${install.stderr}`);
  }

  const listed = cp.spawnSync(
    cliPath,
    [...baseArgs, '--user-data-dir', userDataDir, '--list-extensions'],
    { encoding: 'utf8' },
  );
  if (listed.status !== 0) {
    throw new Error(`VS Code --list-extensions failed:\n${listed.stdout}\n${listed.stderr}`);
  }

  const extensions = listed.stdout.split(/\r?\n/).map(v => v.trim().toLowerCase());
  assert.equal(extensions.includes('codico.codico'), true, listed.stdout);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
