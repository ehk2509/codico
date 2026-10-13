// Loaded by VS Code as its "extension tests" entry when the `codico` command starts a
// headless run: it only asks the extension to run the task it was started for.
exports.run = async function run() {
  const vscode = require('vscode');
  const extension = vscode.extensions.getExtension('codico.codico');
  if (!extension) { throw new Error('The Codico extension did not load.'); }
  await extension.activate();
  const code = await vscode.commands.executeCommand('codico.__headlessRun');
  // The exit code travels in the output file; a non-zero one also fails this run so the editor exits with an error
  if (code) { throw new Error('codico exit ' + code); }
};
