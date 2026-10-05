const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const workspace = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (!workspace) {
    throw new Error('Usage: node eval/vscode/runTask.js <workspace>');
  }

  await runTests({
    version: '1.120.0',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.resolve(__dirname, 'suite'),
    launchArgs: [
      workspace,
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
