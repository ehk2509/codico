import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEFAULT_DEBUG_WAIT_SECONDS, DebugTool, endText, Frame, MAX_DEBUG_WAIT_SECONDS, readOnlyExpression, StopReport, stopText } from './debugTools';
import { resolveWorkspaceToolPath } from './workspaceSecurity';

/** What one call needs from the turn: asking to run code, and the Stop button. */
export interface DebugCall {
    signal: AbortSignal;
    /** Asked like a terminal command: starting a program and evaluating an expression run code. */
    askToRun(what: string): Promise<boolean>;
}

interface Stop { session: vscode.DebugSession; threadId: number; reason: string; description?: string; text?: string }

/** A debugging run started by Codico: its first session and the child sessions it makes (one per Node process). */
interface Run { name: string; config: vscode.DebugConfiguration; folder?: vscode.WorkspaceFolder; sessions: Map<string, vscode.DebugSession>; ended: boolean; exitCode?: number; exceptions: 'all' | 'uncaught' | 'none' }

const OUTPUT_LINES = 60;
let counter = 0;

/**
 * Drives debugging sessions for the agent through VS Code's debugger, whatever the language
 * (any debugger installed in the editor): follows every session it starts, keeps where each
 * stopped, the program's output and how it ended, and answers each step with a report of the
 * new stop — or of the end.
 */
export class DebugController implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[] = [];
    private _run: Run | undefined;
    private _stop: Stop | undefined;
    private _output: string[] = [];
    /** Sessions whose exception settings were sent (once each). */
    private readonly _exceptionsSet = new Set<string>();
    /** Woken on every stop and end. */
    private _waiters: Array<() => void> = [];

    constructor() {
        this._disposables.push(
            vscode.debug.registerDebugAdapterTrackerFactory('*', { createDebugAdapterTracker: session => ({
                onDidSendMessage: message => this._message(session, message),
                // VS Code sends its own exception settings (by default: none) once the adapter is ready; ours go right after,
                // before the program is let go (configurationDone), so that they are the ones in force
                onWillReceiveMessage: (message: { type?: string; command?: string }) => {
                    const run = this._run;
                    if (message.type !== 'request' || message.command !== 'setExceptionBreakpoints' || !run || run.exceptions === 'none' || this._exceptionsSet.has(session.id)) { return; }
                    if (!(this._ours(session) || session.name === run.name)) { return; }
                    this._exceptionsSet.add(session.id);
                    void session.customRequest('setExceptionBreakpoints', { filters: run.exceptions === 'all' ? ['all', 'uncaught'] : ['uncaught'] }).then(undefined, () => undefined);
                },
            }) }),
            vscode.debug.onDidStartDebugSession(session => {
                const run = this._run;
                // The run's first session has its name; the ones it starts (a Node process each) have it as an ancestor
                if (run && !run.ended && (session.name === run.name || (session.parentSession && run.sessions.has(session.parentSession.id)))) { run.sessions.set(session.id, session); }
            }),
            vscode.debug.onDidTerminateDebugSession(session => {
                const run = this._run;
                if (!run || !run.sessions.has(session.id)) { return; }
                run.sessions.delete(session.id);
                if (this._stop?.session.id === session.id) { this._stop = undefined; }
                if (run.sessions.size === 0) { run.ended = true; this._wake(); }
            }),
        );
    }

    dispose(): void { for (const d of this._disposables) { d.dispose(); } }

    private _wake(): void { const waiters = this._waiters; this._waiters = []; for (const wake of waiters) { wake(); } }

    private _ours(session: vscode.DebugSession): boolean { return !!this._run?.sessions.has(session.id); }

    private _message(session: vscode.DebugSession, message: { type?: string; event?: string; body?: Record<string, unknown> }): void {
        if (message.type !== 'event') { return; }
        const run = this._run;
        const ours = this._ours(session) || session.name === run?.name;
        if (!ours) { return; }
        switch (message.event) {
            case 'stopped':
                this._stop = { session, threadId: Number(message.body?.threadId ?? 1), reason: String(message.body?.reason ?? 'stopped'), description: message.body?.description as string | undefined, text: message.body?.text as string | undefined };
                this._wake();
                break;
            case 'continued':
                if (this._stop?.session.id === session.id) { this._stop = undefined; }
                break;
            case 'output': {
                const category = String(message.body?.category ?? 'console');
                if (category === 'telemetry') { break; }
                const text = String(message.body?.output ?? '');
                this._output.push(...text.replace(/\n$/, '').split('\n'));
                if (this._output.length > OUTPUT_LINES) { this._output.splice(0, this._output.length - OUTPUT_LINES); }
                break;
            }
            case 'exited':
                if (run && typeof message.body?.exitCode === 'number' && (run.exitCode === undefined || message.body.exitCode !== 0)) { run.exitCode = message.body.exitCode; }
                break;
        }
    }

    /** Waits until the program stops or ends, the time runs out, or the user presses Stop. */
    private async _settle(seconds: number | undefined, signal: AbortSignal): Promise<string> {
        const limit = Math.min(seconds ?? DEFAULT_DEBUG_WAIT_SECONDS, MAX_DEBUG_WAIT_SECONDS) * 1000;
        const started = Date.now();
        while (!this._stop && this._run && !this._run.ended && !signal.aborted && Date.now() - started < limit) {
            await new Promise<void>(resolve => { this._waiters.push(resolve); setTimeout(resolve, 500); });
        }
        if (this._stop) { return stopText(await this._report(this._stop)); }
        if (!this._run || this._run.ended) { return endText(this._run?.exitCode, this._output); }
        if (signal.aborted) { return 'Stopped waiting (the user stopped the task); the program goes on running.'; }
        return `Still running after ${Math.round(limit / 1000)} s without stopping. Use "pause" to see where it is, or "stop".${this._output.length ? `\nRecent output:\n${this._output.slice(-10).map(l => `  ${l}`).join('\n')}` : ''}`;
    }

    /** Reads the runtime state where the program stopped. */
    private async _report(stop: Stop): Promise<StopReport> {
        const request = <T>(command: string, args: Record<string, unknown>) => stop.session.customRequest(command, args) as Thenable<T>;
        const report: StopReport = { reason: stop.reason, description: stop.description ?? stop.text, frames: [], scopes: [], output: [...this._output] };
        try {
            const trace = await request<{ stackFrames: Array<{ id: number; name: string; line: number; column?: number; source?: { path?: string; name?: string } }> }>('stackTrace', { threadId: stop.threadId, startFrame: 0, levels: 15 });
            const frames = trace.stackFrames ?? [];
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            report.frames = frames.map((f): Frame => ({ name: f.name, line: f.line, column: f.column, file: f.source?.path ? (f.source.path.startsWith(root) ? path.relative(root, f.source.path).split(path.sep).join('/') : f.source.path) : f.source?.name }));
            const top = frames[0];
            if (top?.source?.path && fs.existsSync(top.source.path)) {
                const lines = fs.readFileSync(top.source.path, 'utf8').split('\n');
                report.source = lines.slice(Math.max(0, top.line - 5), top.line + 4).map((text, i): [number, string] => [Math.max(1, top.line - 4) + i, text]);
            }
            if (top) {
                const scopes = (await request<{ scopes: Array<{ name: string; variablesReference: number; expensive: boolean }> }>('scopes', { frameId: top.id })).scopes ?? [];
                for (const scope of scopes.filter(s => !s.expensive && !/^global/i.test(s.name)).slice(0, 3)) {
                    const vars = (await request<{ variables: Array<{ name: string; value: string; type?: string }> }>('variables', { variablesReference: scope.variablesReference })).variables ?? [];
                    report.scopes.push({ name: scope.name, variables: vars.filter(v => !/^__|^this$/.test(v.name) || v.name === 'this').map(v => ({ name: v.name, value: v.value, type: v.type })) });
                }
            }
            if (stop.reason === 'exception') {
                const info = await request<{ exceptionId?: string; description?: string; details?: { message?: string; typeName?: string; stackTrace?: string } }>('exceptionInfo', { threadId: stop.threadId }).then(r => r, () => undefined);
                if (info) { report.exception = [info.details?.typeName ?? info.exceptionId, info.description ?? info.details?.message].filter(Boolean).join(': '); }
            }
        } catch (error) { report.description = `${report.description ?? ''} (the state could not all be read: ${error instanceof Error ? error.message : String(error)})`.trim(); }
        return report;
    }

    /** The launch configuration for a start: a named one of launch.json, a program, or a command in the JavaScript debug terminal. */
    private async _configuration(tool: DebugTool, folder: vscode.WorkspaceFolder | undefined): Promise<vscode.DebugConfiguration | string> {
        const skipFiles = ['<node_internals>/**', '**/node_modules/**'];
        if (tool.config) {
            const configs = vscode.workspace.getConfiguration('launch', folder?.uri).get<vscode.DebugConfiguration[]>('configurations', []);
            const found = configs.find(c => c.name === tool.config);
            return found ? { ...found } : `no launch configuration "${tool.config}"${configs.length ? `; launch.json has: ${configs.map(c => c.name).join(', ')}` : ' (launch.json has none)'}`;
        }
        if (tool.command) { return { type: 'node-terminal', request: 'launch', name: '', command: tool.command, cwd: folder?.uri.fsPath, skipFiles }; }
        const program = (await resolveWorkspaceToolPath(tool.program!)).uri.fsPath;
        if (/\.(?:py)$/.test(program)) { return { type: 'debugpy', request: 'launch', name: '', program, args: tool.args ?? [], cwd: folder?.uri.fsPath, console: 'internalConsole', justMyCode: true }; }
        if (/\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/.test(program)) { return { type: 'node', request: 'launch', name: '', program, args: tool.args ?? [], cwd: folder?.uri.fsPath, skipFiles, console: 'internalConsole' }; }
        return `no debugger is chosen for ${path.basename(program)}: give a launch.json configuration (config) instead`;
    }

    async run(tool: DebugTool, call: DebugCall): Promise<string> {
        const tag = `[debug ${tool.action}]`;
        try {
            switch (tool.action) {
                case 'breakpoint': return `${tag} ${await this._breakpoint(tool)}`;
                case 'start': case 'rerun': return `${tag} ${await this._start(tool, call)}`;
                case 'inspect': return `${tag} ${this._stop ? stopText(await this._report(this._stop)) : this._run && !this._run.ended ? 'The program is running, not stopped. Use "pause".' : endText(this._run?.exitCode, this._output)}`;
                case 'stop': {
                    if (!this._run || this._run.ended) { return `${tag} No debugging session of Codico is running.`; }
                    await this._end();
                    return `${tag} Stopped.`;
                }
                case 'continue': case 'step': case 'pause': {
                    const run = this._run;
                    if (!run || run.ended) { return `${tag} ERROR: no debugging session is running. Start one first.`; }
                    if (tool.action !== 'pause' && !this._stop) { return `${tag} ERROR: the program is running, not stopped. Use "pause", or wait for a breakpoint.`; }
                    if (tool.action === 'pause') {
                        if (this._stop) { return `${tag} It is stopped already.\n${stopText(await this._report(this._stop))}`; }
                        // The newest process of the run (a command's first session only starts the others)
                        const session = [...run.sessions.values()].pop();
                        if (!session) { return `${tag} ERROR: no session to pause.`; }
                        const threads = (await session.customRequest('threads') as { threads: Array<{ id: number }> }).threads ?? [];
                        await session.customRequest('pause', { threadId: threads[0]?.id ?? 1 });
                    } else {
                        const stop = this._stop!;
                        this._stop = undefined;
                        const command = tool.action === 'continue' ? 'continue' : { over: 'next', into: 'stepIn', out: 'stepOut' }[tool.step ?? 'over'];
                        await stop.session.customRequest(command, { threadId: stop.threadId });
                    }
                    return `${tag} ${await this._settle(tool.timeoutSeconds, call.signal)}`;
                }
                case 'evaluate': {
                    if (!this._stop) { return `${tag} ERROR: evaluate works where the program is stopped; it is not stopped now.`; }
                    const expression = tool.expression!;
                    // Reading a value is free; anything that could change files or state is asked for, like a command
                    if (!readOnlyExpression(expression) && !await call.askToRun(`debugger: evaluate ${expression}`)) { return `${tag} Not evaluated: the user declined (it is not a plain read).`; }
                    const trace = await this._stop.session.customRequest('stackTrace', { threadId: this._stop.threadId, startFrame: 0, levels: 1 }) as { stackFrames: Array<{ id: number }> };
                    const result = await this._stop.session.customRequest('evaluate', { expression, frameId: trace.stackFrames?.[0]?.id, context: 'repl' }) as { result: string; type?: string };
                    return `${tag} ${expression} = ${result.result}${result.type ? ` (${result.type})` : ''}`;
                }
            }
        } catch (error) {
            return `${tag} ERROR: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    /** Ends Codico's run: its sessions only, never one the user started. */
    private async _end(): Promise<void> {
        const run = this._run;
        if (!run) { return; }
        for (const session of [...run.sessions.values()].filter(s => !s.parentSession || !run.sessions.has(s.parentSession.id))) { await vscode.debug.stopDebugging(session); }
        for (let i = 0; i < 20 && !run.ended; i++) { await new Promise(resolve => setTimeout(resolve, 100)); }
        run.ended = true; this._stop = undefined;
    }

    private async _breakpoint(tool: DebugTool): Promise<string> {
        const target = await resolveWorkspaceToolPath(tool.file!);
        const line = tool.line! - 1;
        const here = vscode.debug.breakpoints.filter((b): b is vscode.SourceBreakpoint => b instanceof vscode.SourceBreakpoint && b.location.uri.fsPath === target.uri.fsPath && b.location.range.start.line === line);
        if (tool.remove) {
            if (!here.length) { return `No breakpoint at ${tool.file}:${tool.line}.`; }
            vscode.debug.removeBreakpoints(here);
            return `Removed the breakpoint at ${tool.file}:${tool.line}.`;
        }
        if (here.length) { vscode.debug.removeBreakpoints(here); }
        vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(target.uri, new vscode.Position(line, 0)), true, tool.condition, undefined, tool.logMessage)]);
        const text = fs.existsSync(target.uri.fsPath) ? fs.readFileSync(target.uri.fsPath, 'utf8').split('\n')[line] : undefined;
        return `${tool.logMessage ? 'Logpoint' : 'Breakpoint'} at ${tool.file}:${tool.line}${tool.condition ? ` when ${tool.condition}` : ''}${text !== undefined ? `: ${text.trim().slice(0, 160)}` : ''}.`;
    }

    private async _start(tool: DebugTool, call: DebugCall): Promise<string> {
        let config: vscode.DebugConfiguration; let folder: vscode.WorkspaceFolder | undefined; let exceptions: Run['exceptions'];
        if (tool.action === 'rerun') {
            if (!this._run) { return 'ERROR: nothing to run again: start a session first.'; }
            ({ config, folder, exceptions } = this._run);
        } else {
            folder = vscode.workspace.workspaceFolders?.[0];
            const made = await this._configuration(tool, folder);
            if (typeof made === 'string') { return `ERROR: ${made}.`; }
            config = made; exceptions = tool.exceptions ?? 'all';
        }
        const what = config.command ? `${config.command}` : config.program ? `${path.basename(String(config.program))} ${(config.args as string[] | undefined ?? []).join(' ')}`.trim() : `launch configuration "${config.name}"`;
        if (!await call.askToRun(`debugger: run ${what}`)) { return 'Not started: the user declined.'; }
        if (this._run && !this._run.ended) { await this._end(); }
        const name = `Codico debug ${++counter}`;
        this._run = { name, config: { ...config, name }, folder, sessions: new Map(), ended: false, exceptions };
        this._stop = undefined; this._output = [];
        const started = await vscode.debug.startDebugging(folder, this._run.config, { suppressDebugToolbar: false });
        if (!started) { this._run.ended = true; return `ERROR: the debugger did not start for "${what}" (is a debugger for ${config.type} installed?).`; }
        return `Started ${what} under the debugger (exceptions: ${exceptions}).\n${await this._settle(tool.timeoutSeconds, call.signal)}`;
    }
}
