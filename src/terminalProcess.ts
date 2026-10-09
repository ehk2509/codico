import * as cp from 'child_process';

const SAFE_TERMINAL_ENV_KEYS = new Set([
    'PATH', 'HOME', 'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'TERM',
    'TMP', 'TEMP', 'TMPDIR', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT',
    'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
    'LANG', 'COLORTERM', 'NO_COLOR',
    'NVM_BIN', 'NVM_DIR', 'VOLTA_HOME', 'PNPM_HOME',
    'GOPATH', 'GOROOT', 'JAVA_HOME', 'PYENV_ROOT', 'VIRTUAL_ENV',
].map(key => key.toLowerCase()));

export function buildTerminalEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(source)) {
        if (value === undefined) { continue; }
        const normalizedKey = key.toLowerCase();
        if (SAFE_TERMINAL_ENV_KEYS.has(normalizedKey) || normalizedKey.startsWith('lc_')) {
            env[key] = value;
        }
    }
    return env;
}

export interface TerminalProcessOptions {
    command: string;
    cwd?: string;
    timeoutMs: number;
    signal: AbortSignal;
    env?: NodeJS.ProcessEnv;
    onChunk?: (text: string) => void;
    maxCapturedBytes?: number;
}

export interface TerminalProcessResult {
    output: string;
    exitCode: number;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    stopped: boolean;
    error?: string;
    backgroundProcessGroup?: number;
}

export function processGroupAlive(pgid: number): boolean {
    if (process.platform === 'win32') { return false; }
    try {
        process.kill(-pgid, 0);
        return true;
    } catch {
        return false;
    }
}

export function killProcessGroup(pgid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (process.platform === 'win32') { return; }
    try { process.kill(-pgid, signal); } catch { /* already exited */ }
}

function killWindowsTree(pid: number, force: boolean): void {
    const args = ['/PID', String(pid), '/T'];
    if (force) { args.push('/F'); }
    try {
        const killer = cp.spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
        killer.unref();
    } catch { /* process already exited or taskkill unavailable */ }
}

export function runTerminalProcess(options: TerminalProcessOptions): Promise<TerminalProcessResult> {
    const {
        command,
        cwd,
        timeoutMs,
        signal,
        env = buildTerminalEnvironment(),
        onChunk,
        maxCapturedBytes = 1024 * 1024,
    } = options;

    return new Promise<TerminalProcessResult>((resolve) => {
        const shell = process.platform === 'win32'
            ? (process.env.ComSpec || 'cmd.exe')
            : (process.env.SHELL || '/bin/sh');
        const useProcessGroup = process.platform !== 'win32';

        // Let Node construct the platform-specific shell invocation. In particular,
        // this avoids cmd.exe /s /c double-quoting bugs for commands that themselves
        // contain quotes (for example node -e "...").
        const child = cp.spawn(command, {
            cwd,
            env,
            shell,
            detached: useProcessGroup,
            windowsHide: true,
        });

        let timedOut = false;
        let settled = false;
        let capturedBytes = 0;
        const outputChunks: string[] = [];
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let forceSettleTimer: ReturnType<typeof setTimeout> | undefined;
        let exitGraceTimer: ReturnType<typeof setTimeout> | undefined;

        const killTree = (force: boolean): void => {
            if (!child.pid) { return; }
            if (process.platform === 'win32') {
                killWindowsTree(child.pid, force);
            } else {
                try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already exited */ }
            }
        };

        const settle = (code: number | null, exitSignal: NodeJS.Signals | null, error?: string): void => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timeoutTimer);
            clearTimeout(killTimer);
            clearTimeout(forceSettleTimer);
            clearTimeout(exitGraceTimer);
            signal.removeEventListener('abort', onAbort);
            child.stdout?.destroy();
            child.stderr?.destroy();

            const stopped = signal.aborted;
            const exitCode = code ?? (exitSignal ? 1 : error ? 1 : 0);
            const backgroundProcessGroup = useProcessGroup && child.pid && processGroupAlive(child.pid)
                ? child.pid
                : undefined;

            resolve({
                output: outputChunks.join(''),
                exitCode,
                signal: exitSignal,
                timedOut,
                stopped,
                error,
                backgroundProcessGroup,
            });
        };

        const terminate = (): void => {
            // Windows has no POSIX-style graceful process-group signal; taskkill /F
            // is the reliable way to stop the shell and descendants as one tree.
            killTree(process.platform === 'win32');
            killTimer = setTimeout(() => killTree(true), 3_000);
            // If descendants keep stdio open or the platform never reports close,
            // settle anyway after the forced-kill window.
            forceSettleTimer = setTimeout(() => settle(null, 'SIGKILL'), 5_000);
        };

        const timeoutTimer = setTimeout(() => {
            timedOut = true;
            terminate();
        }, Math.max(1, timeoutMs));

        const onAbort = (): void => terminate();
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) { terminate(); }

        const onData = (text: string): void => {
            onChunk?.(text);
            if (capturedBytes >= maxCapturedBytes) { return; }
            const remaining = maxCapturedBytes - capturedBytes;
            const kept = Buffer.byteLength(text) <= remaining
                ? text
                : Buffer.from(text).subarray(0, remaining).toString('utf8');
            capturedBytes += Buffer.byteLength(kept);
            outputChunks.push(kept);
        };

        // Decoded per stream so a character split across chunks is not corrupted
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);

        // 'close' can wait forever when a descendant inherits the pipes. Once the
        // shell exits, give trailing output one second, then settle independently.
        child.on('exit', (code, exitSignal) => {
            exitGraceTimer = setTimeout(() => settle(code, exitSignal), 1_000);
        });
        child.on('close', (code, exitSignal) => settle(code, exitSignal));
        child.on('error', (err) => settle(null, null, err.message));
    });
}
