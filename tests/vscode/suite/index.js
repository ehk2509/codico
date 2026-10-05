const assert = require('node:assert/strict');
const vscode = require('vscode');

async function run() {
  const extension = vscode.extensions.getExtension('codico.codico');
  assert.ok(extension, 'Codico extension must be discoverable in the Extension Host');

  await extension.activate();
  assert.equal(extension.isActive, true, 'Codico extension must activate successfully');

  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of [
    'codico.openChat',
    'codico.inlineChat',
    'codico.indexWorkspace',
    'codico.generateCommitMessage',
  ]) {
    assert.equal(commands.has(command), true, `Expected command to be registered: ${command}`);
  }

  const config = vscode.workspace.getConfiguration('codico');
  assert.equal(config.get('nativeToolCalling'), true);
  assert.equal(config.get('browserAllowPrivateNetwork'), false);
  assert.equal(config.get('autoIndex'), false);
}

module.exports = { run };
