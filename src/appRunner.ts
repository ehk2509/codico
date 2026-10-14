import * as cp from 'child_process';
import * as http from 'http';
import * as https from 'https';
import { buildTerminalEnvironment, killProcessGroup, killWindowsTree } from './terminalProcess';

/** The address of an app Codico may start: http(s) on this machine. */
export function localAppUrl(raw: string): URL | undefined {
    let url: URL;
    try { url = new URL(raw.trim()); } catch { return undefined; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') { return undefined; }
    return ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(url.hostname) ? url : undefined;
}

/** Whether something answers at the address (any HTTP status: a 404 page is still a server). */
export function probe(url: URL, timeoutMs = 2000): Promise<boolean> {
    return new Promise(resolve => {
        const get = url.protocol === 'https:' ? https.get : http.get;
        const target = url.hostname === '0.0.0.0' ? new URL(url.href.replace('0.0.0.0', '127.0.0.1')) : url;
        const request = get(target, { timeout: timeoutMs, rejectUnauthorized: false }, response => { response.resume(); resolve(true); });
        request.on('timeout', () => { request.destroy(); resolve(false); });
        request.on('error', () => resolve(false));
    });
}

interface RunningApp { command: string; url: URL; child: cp.ChildProcess; output: string; exited?: number | null }

const MAX_LOG = 64 * 1024;
const tail = (text: string, chars = 3000) => text.length > chars ? '…' + text.slice(-chars) : text;

/**
 * Apps the agent starts to check its work in a browser: a dev server runs in the background
 * until the task ends (or the agent stops it), unlike run_terminal, which waits for a command
 * to finish. Each app is a process group of its own, so stopping it ends what it started.
 */
export class AppRunner {
    private readonly _apps = new Map<string, RunningApp>();

    /** The origins of the apps running now: the browser may open them although they are local. */
    get origins(): string[] { return [...this._apps.values()].filter(app => app.exited === undefined).map(app => app.url.origin); }

    /**
     * Starts the command and waits until the address answers.
     * @param wrap the command sandbox, when it is on
     */
    async start(options: { command: string; url: string; cwd: string | undefined; timeoutMs: number; signal: AbortSignal; wrap?: (shell: string, command: string) => { file: string; args: string[] }; wait?: (ms: number) => Promise<void> }): Promise<{ ok: boolean; text: string; origin?: string }> {
        const url = localAppUrl(options.url);
        if (!url) { return { ok: false, text: `ERROR: "${options.url}" is not an address on this machine (http://localhost:<port>/…). Only a local app can be started and checked.` }; }
        const already = this._apps.get(url.origin);
        if (already && already.exited === undefined) {
            if (already.command === options.command) { return { ok: true, origin: url.origin, text: `Already running at ${url.origin}.\nLast output:\n${tail(already.output, 1500)}` }; }
            this.stop(url.origin);
        }
        if (await probe(url)) { return { ok: false, text: `ERROR: something already answers at ${url.origin}. Stop it, or use another port.` }; }
        const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
        const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
        const wrapped = options.wrap && process.platform !== 'win32' ? options.wrap(/\/(?:ba|z|da)?sh$/.test(shell) ? shell : '/bin/sh', options.command) : undefined;
        const child = cp.spawn(wrapped ? wrapped.file : options.command, wrapped ? wrapped.args : [], {
            cwd: options.cwd, env: { ...buildTerminalEnvironment(), BROWSER: 'none', CI: '1' }, shell: wrapped ? false : shell,
            detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const app: RunningApp = { command: options.command, url, child, output: '' };
        this._apps.set(url.origin, app);
        const collect = (chunk: Buffer) => { app.output = (app.output + chunk.toString()).slice(-MAX_LOG); };
        child.stdout?.on('data', collect); child.stderr?.on('data', collect);
        child.on('exit', code => { app.exited = code; });
        child.on('error', error => { app.output += `\n${error.message}`; app.exited = -1; });

        const until = Date.now() + options.timeoutMs;
        for (;;) {
            if (options.signal.aborted) { this.stop(url.origin); return { ok: false, text: 'Stopped by the user.' }; }
            if (app.exited !== undefined) {
                this._apps.delete(url.origin);
                return { ok: false, text: `ERROR: the command ended (exit ${app.exited}) before anything answered at ${url.origin}.\nOutput:\n${tail(app.output)}` };
            }
            if (await probe(url)) { return { ok: true, origin: url.origin, text: `Running: ${url.origin} answers. It stops when the task ends, or with action "stop".\nOutput so far:\n${tail(app.output, 1500)}` }; }
            if (Date.now() >= until) {
                this.stop(url.origin);
                return { ok: false, text: `ERROR: nothing answered at ${url.href} within ${Math.round(options.timeoutMs / 1000)} s; the command was stopped. Check the address and port it prints.\nOutput:\n${tail(app.output)}` };
            }
            await wait(500);
        }
    }

    /** The app's recent output: its server log, where errors show. */
    logs(origin?: string): string {
        const apps = origin ? [this._apps.get(origin)].filter((app): app is RunningApp => !!app) : [...this._apps.values()];
        if (apps.length === 0) { return 'No app is running.'; }
        return apps.map(app => `${app.url.origin} (${app.exited === undefined ? 'running' : `ended, exit ${app.exited}`}): ${app.command}\n${tail(app.output) || '(no output)'}`).join('\n\n');
    }

    /** Stops one app, or all of them; returns how many were stopped. */
    stop(origin?: string): number {
        let stopped = 0;
        for (const [key, app] of this._apps) {
            if (origin && key !== origin) { continue; }
            if (app.exited === undefined && app.child.pid) {
                if (process.platform === 'win32') { killWindowsTree(app.child.pid, true); }
                else {
                    killProcessGroup(app.child.pid, 'SIGTERM');
                    const pid = app.child.pid;
                    setTimeout(() => killProcessGroup(pid, 'SIGKILL'), 3000).unref?.();
                }
                stopped++;
            }
            this._apps.delete(key);
        }
        return stopped;
    }
}
