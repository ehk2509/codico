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
  const maxIterations = Number(process.env.CODICO_EVAL_MAX_ITERATIONS || '16');
  const maxTotalTokens = Number(process.env.CODICO_EVAL_MAX_TOTAL_TOKENS || '400000');
  const accoEnabled = process.env.CODICO_EVAL_ACCO_ENABLED === '1';
  const accoBaseUrl = process.env.CODICO_EVAL_ACCO_BASE_URL || 'http://127.0.0.1:8770';

  try {
    const extension = vscode.extensions.getExtension('codico.codico');
    if (!extension) { throw new Error('Codico extension is not discoverable in the evaluation host.'); }
    await extension.activate();

    const commands = new Set(await vscode.commands.getCommands(true));
    for (const command of ['codico.__evalConfigure', 'codico.__evalRunTask', 'codico.__evalSnapshot']) {
      if (!commands.has(command)) {
        throw new Error(`Evaluation command is not registered: ${command}`);
      }
    }

    await vscode.commands.executeCommand('codico.__evalConfigure', {
      openRouterApiKey: apiKey,
      model,
      maxIterations,
      maxTotalTokens,
      accoEnabled,
      accoBaseUrl,
    });
    await vscode.commands.executeCommand('codico.openChat');
    await new Promise(resolve => setTimeout(resolve, 500));

    const writeJsonAtomic = (payload) => {
      const tempPath = outputPath + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
      fs.renameSync(tempPath, outputPath);
    };

    let checkpointBusy = false;
    const writeCheckpoint = async () => {
      if (checkpointBusy) { return; }
      checkpointBusy = true;
      try {
        const metrics = await vscode.commands.executeCommand('codico.__evalSnapshot');
        writeJsonAtomic({ ok: false, partial: true, model, metrics });
      } catch {
        // Best-effort only. The final result/error below remains authoritative.
      } finally {
        checkpointBusy = false;
      }
    };

    await writeCheckpoint();
    const checkpointTimer = setInterval(() => { void writeCheckpoint(); }, 2000);
    try {
      const metrics = await vscode.commands.executeCommand('codico.__evalRunTask', prompt);
      writeJsonAtomic({ ok: true, partial: false, model, metrics });
    } finally {
      clearInterval(checkpointTimer);
    }
  } catch (error) {
    const tempPath = outputPath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify({
      ok: false,
      partial: false,
      model,
      error: error instanceof Error ? error.stack || error.message : String(error),
    }, null, 2));
    fs.renameSync(tempPath, outputPath);
    throw error;
  }
}

module.exports = { run };
