/** `codico doctor`: checks the environment the CLI needs and says how to fix what is missing. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseDirectModelId } from '../directProviderClient';
import { KEY_FOR_PROVIDER } from './agent';
import { locate } from './cliProviders';
import { configFile, loadUserConfig } from './config';
import { Paint, SYMBOLS } from './tui/ansi';
import { ollamaModels } from './models';
export { ollamaModels };

export interface DoctorCheck { name: string; status: 'ok' | 'warn' | 'fail'; detail: string }

export function cliVersion(): string {
    for (const candidate of [path.join(__dirname, '..', 'package.json'), path.join(__dirname, '..', '..', 'package.json')]) {
        try {
            const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
            if (pkg.version && /codico/.test(pkg.name ?? '')) { return pkg.version; }
        } catch { /* try next */ }
    }
    return 'dev';
}


export async function runDoctor(model: string, ollamaUrl: string, cwd: string): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const major = Number(process.versions.node.split('.')[0]);
    checks.push({ name: 'Node.js', status: major >= 20 ? 'ok' : 'fail', detail: `v${process.versions.node}${major >= 20 ? '' : ' (20 or newer required)'}` });
    checks.push({ name: 'Platform', status: 'ok', detail: `${process.platform} ${process.arch}` });
    checks.push({ name: 'Workspace', status: fs.existsSync(cwd) ? 'ok' : 'fail', detail: cwd });
    const { warning } = loadUserConfig();
    checks.push({ name: 'Config', status: warning ? 'warn' : 'ok', detail: warning ?? configFile() + (fs.existsSync(configFile()) ? '' : ' (not created; defaults in use)') });
    const git = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    checks.push({ name: 'git', status: git.status === 0 ? 'ok' : 'warn', detail: git.status === 0 ? git.stdout.trim() : 'not found (/diff and checkpoints need git)' });

    // The selected model's provider.
    if (model.startsWith('ollama/')) {
        const found = await ollamaModels(ollamaUrl);
        if (found instanceof Error) {
            checks.push({ name: 'Model', status: 'fail', detail: `${model}: Ollama not reachable at ${ollamaUrl} (${found.message}). Start it with "ollama serve".` });
        } else {
            const name = model.slice(7);
            const has = found.some(m => m === name || m === name + ':latest');
            checks.push({ name: 'Model', status: has ? 'ok' : 'fail', detail: has ? `${model} via ${ollamaUrl}` : `${name} is not pulled. Run "ollama pull ${name}". Installed: ${found.slice(0, 8).join(', ') || 'none'}` });
        }
    } else if (model.startsWith('claude-code/') || model.startsWith('chatgpt/')) {
        const cli = model.startsWith('claude-code/') ? locate('claude', 'CODICO_CLAUDE_PATH', '@anthropic-ai/claude-code', 'cli.js') : locate('codex', 'CODICO_CODEX_PATH', '@openai/codex', 'bin/codex.js');
        const found = path.isAbsolute(cli.command) && fs.existsSync(cli.command);
        checks.push({ name: 'Model', status: found ? 'ok' : 'fail', detail: found ? `${model} via ${cli.baseArgs?.[0] ?? cli.command}` : `${model}: ${cli.command} CLI not found on PATH` });
    } else {
        const direct = parseDirectModelId(model);
        const keyName = direct ? KEY_FOR_PROVIDER[direct.providerId] : 'OPENROUTER_API_KEY';
        if (!keyName) { checks.push({ name: 'Model', status: 'fail', detail: `${model}: unsupported provider` }); }
        else { checks.push({ name: 'Model', status: process.env[keyName] ? 'ok' : 'fail', detail: process.env[keyName] ? `${model} (${keyName} set)` : `${model}: set ${keyName}` }); }
    }
    const keys = ['OPENROUTER_API_KEY', ...Object.values(KEY_FOR_PROVIDER)].filter(k => process.env[k]);
    checks.push({ name: 'API keys', status: 'ok', detail: keys.length ? keys.join(', ') : 'none set (local Ollama or CLI logins only)' });
    let playwright = false;
    try { require.resolve('playwright-core'); playwright = true; } catch { /* optional */ }
    checks.push({ name: 'Browser tools', status: playwright ? 'ok' : 'warn', detail: playwright ? 'playwright-core available (--allow-browser)' : 'playwright-core not installed; --allow-browser unavailable' });
    return checks;
}

export function formatDoctor(checks: DoctorCheck[], paint: Paint): string {
    const icon = { ok: paint.green(SYMBOLS.check), warn: paint.yellow('!'), fail: paint.red(SYMBOLS.cross) };
    const width = Math.max(...checks.map(c => c.name.length));
    const lines = checks.map(c => `  ${icon[c.status]} ${paint.bold(c.name.padEnd(width))}  ${c.status === 'ok' ? paint.gray(c.detail) : c.detail}`);
    const failed = checks.filter(c => c.status === 'fail').length;
    lines.push('', failed ? paint.red(`${failed} problem${failed === 1 ? '' : 's'} found.`) : paint.green('Everything needed is in place.'));
    return lines.join('\n') + '\n';
}
