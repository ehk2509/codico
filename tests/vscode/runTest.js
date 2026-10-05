const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '../..');
  await runTests({
    version: '1.120.0',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.resolve(__dirname, 'suite'),
    launchArgs: [
      path.resolve(__dirname, 'fixture'),
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
