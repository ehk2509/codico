const fs = require('node:fs');
const vscode = require('vscode');

function required(name) {
  const value = process.env[name];
  if (!value) { throw new Error(`Missing evaluation environment variable: ${name}`); }
  return value;
}

async function run() {
  const outputPath = required('CODICO_EVAL_OUTPUT');
  const prompt = required('CODICO_EVAL_PROMPT');
  const apiKey = required('CODICO_EVAL_API_KEY');
  const model = process.env.CODICO_EVAL_MODEL || 'deepseek/deepseek-v4-flash';
  const maxIterations = Number(process.env.CODICO_EVAL_MAX_ITERATIONS || '30');

  try {
    const extension = vscode.extensions.getExtension('codico.codico');
    if (!extension) { throw new Error('Codico extension is not discoverable in the evaluation host.'); }
    await extension.activate();

    const commands = new Set(await vscode.commands.getCommands(true));
    for (const command of ['codico.__evalConfigure', 'codico.__evalRunTask']) {
      if (!commands.has(command)) {
        throw new Error(`Evaluation command is not registered: ${command}`);
      }
    }

    await vscode.commands.executeCommand('codico.__evalConfigure', {
      openRouterApiKey: apiKey,
      model,
      maxIterations,
    });
    await vscode.commands.executeCommand('codico.openChat');
    await new Promise(resolve => setTimeout(resolve, 500));

    const metrics = await vscode.commands.executeCommand('codico.__evalRunTask', prompt);
    fs.writeFileSync(outputPath, JSON.stringify({ ok: true, model, metrics }, null, 2));
  } catch (error) {
    fs.writeFileSync(outputPath, JSON.stringify({
      ok: false,
      model,
      error: error instanceof Error ? error.stack || error.message : String(error),
    }, null, 2));
    throw error;
  }
}

module.exports = { run };
