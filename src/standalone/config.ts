/**
 * User-level CLI defaults in ~/.codico/config.json. Deliberately user-scoped only: a repository must not
 * be able to redirect your model, endpoint or permissions (a cloned project could otherwise send its code
 * to a server of its choosing).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface UserConfig {
    model?: string;
    ollamaUrl?: string;
    maxSteps?: number;
    verbose?: boolean;
}

export const CONFIG_KEYS: Record<keyof UserConfig, string> = {
    model: 'Default model ID (e.g. ollama/qwen2.5-coder:7b, direct:anthropic/claude-sonnet-5-5)',
    ollamaUrl: 'Base URL of a local Ollama / OpenAI-compatible server',
    maxSteps: 'Default max model requests per turn (1-100, default 50)',
    verbose: 'Show full tool output in the transcript (true/false)',
};

export function configFile(home = os.homedir()): string {
    return process.env.CODICO_CONFIG || path.join(home, '.codico', 'config.json');
}

function validate(key: string, value: unknown): unknown {
    switch (key) {
        case 'model': case 'ollamaUrl':
            if (typeof value !== 'string' || !value.trim()) { throw new Error(`${key} must be a non-empty string`); }
            if (key === 'ollamaUrl' && !/^https?:\/\//i.test(value)) { throw new Error('ollamaUrl must start with http:// or https://'); }
            return value.trim();
        case 'maxSteps': {
            const n = typeof value === 'number' ? value : Number(value);
            if (!Number.isInteger(n) || n < 1 || n > 100) { throw new Error('maxSteps must be an integer from 1 to 100'); }
            return n;
        }
        case 'verbose':
            if (typeof value === 'boolean') { return value; }
            if (value === 'true' || value === 'false') { return value === 'true'; }
            throw new Error('verbose must be true or false');
        default:
            throw new Error(`Unknown config key "${key}". Keys: ${Object.keys(CONFIG_KEYS).join(', ')}`);
    }
}

export function loadUserConfig(file = configFile()): { config: UserConfig; warning?: string } {
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return { config: {} }; }
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const config: UserConfig = {};
        for (const [key, value] of Object.entries(parsed ?? {})) {
            if (!(key in CONFIG_KEYS)) { continue; }
            (config as Record<string, unknown>)[key] = validate(key, value);
        }
        return { config };
    } catch (error) {
        return { config: {}, warning: `Ignoring ${file}: ${(error as Error).message}` };
    }
}

type Mode = string;

function workspacesFile(): string { return path.join(path.dirname(configFile()), 'workspaces.json'); }

function workspaceKey(cwd: string): string {
    let real = cwd;
    try { real = fs.realpathSync(cwd); } catch { /* keep as given */ }
    return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** The permission mode the user chose for this folder in an earlier chat, if any. */
export function workspaceMode(cwd: string): Mode | undefined {
    try {
        const all = JSON.parse(fs.readFileSync(workspacesFile(), 'utf8')) as Record<string, { mode?: string }>;
        const mode = all[workspaceKey(cwd)]?.mode;
        return typeof mode === 'string' && /^[a-z]{2,12}$/.test(mode) ? mode : undefined;
    } catch { return undefined; }
}

/** Remember the folder's mode (every action still asks for approval; this only sets what may be asked). */
export function rememberWorkspaceMode(cwd: string, mode: Mode): void {
    const file = workspacesFile();
    let all: Record<string, { mode: Mode; updatedAt: string }> = {};
    try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new file */ }
    all[workspaceKey(cwd)] = { mode, updatedAt: new Date().toISOString() };
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const temp = file + '.' + process.pid + '.tmp';
        fs.writeFileSync(temp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(temp, file);
    } catch { /* a convenience only */ }
}

export function setUserConfig(key: string, value: string | undefined, file = configFile()): UserConfig {
    const { config, warning } = loadUserConfig(file);
    if (warning) { throw new Error(warning); }
    if (value === undefined) { delete (config as Record<string, unknown>)[key]; }
    else { (config as Record<string, unknown>)[key] = validate(key, value); }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
    return config;
}
