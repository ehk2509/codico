const SAFE_PARENT_ENV_KEYS = new Set([
    'PATH', 'HOME', 'USER', 'USERNAME', 'USERPROFILE', 'SHELL',
    'TMP', 'TEMP', 'TMPDIR', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'APPDATA', 'LOCALAPPDATA', 'LANG', 'TERM', 'COLORTERM',
]);

/**
 * MCP servers receive only ordinary runtime variables by default. Secrets
 * inherited by VS Code are excluded unless explicitly supplied in server env.
 */
export function buildMcpEnvironment(
    extra: Record<string, string> = {},
    parent: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(parent)) {
        if (value === undefined) { continue; }
        if (SAFE_PARENT_ENV_KEYS.has(key) || key.startsWith('LC_')) {
            env[key] = value;
        }
    }
    for (const [key, value] of Object.entries(extra)) {
        env[key] = value;
    }
    return env;
}
