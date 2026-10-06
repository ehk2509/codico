const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const workspace = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (!workspace) {
    throw new Error('Usage: node eval/vscode/runTask.js <workspace>');
  }

  const instanceDir = process.env.CODICO_EVAL_INSTANCE_DIR ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'codico-eval-host-'));
  const userDataDir = path.join(instanceDir, 'user-data');
  const extensionsDir = path.join(instanceDir, 'extensions');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });

  await runTests({
    version: '1.120.0',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.resolve(__dirname, 'suite'),
    launchArgs: [
      workspace,
      '--user-data-dir', userDataDir,
      '--extensions-dir', extensionsDir,
      '--disable-extensions',
      '--disable-gpu',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
