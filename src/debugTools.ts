/**
 * The `debug` tool: the agent drives a debugging session — starts the program or the tests
 * under the debugger, sets breakpoints, steps, reads the runtime state where it stops,
 * evaluates expressions, and runs it again after a fix. This file is the formats and the
 * wording of what it reports; the session itself is driven in debugController.
 */

export type DebugAction = 'start' | 'breakpoint' | 'continue' | 'step' | 'pause' | 'inspect' | 'evaluate' | 'rerun' | 'stop';
export const DEBUG_ACTIONS: readonly DebugAction[] = ['start', 'breakpoint', 'continue', 'step', 'pause', 'inspect', 'evaluate', 'rerun', 'stop'];

export interface DebugTool {
    type: 'debug';
    action: DebugAction;
    /** start: a configuration of launch.json, by name. */
    config?: string;
    /** start: a program to run under the debugger (.js/.ts with Node, .py with debugpy), with its arguments. */
    program?: string;
    args?: string[];
    /** start: a command run in the JavaScript debug terminal (npm test, node --test …): every Node process it starts is debugged. */
    command?: string;
    /** start: stop where an exception is thrown — all (also caught ones: a failing test's) or only uncaught ones. */
    exceptions?: 'all' | 'uncaught' | 'none';
    /** breakpoint: where, and when or what. */
    file?: string;
    line?: number;
    condition?: string;
    logMessage?: string;
    remove?: boolean;
    /** step: over (the default), into or out. */
    step?: 'over' | 'into' | 'out';
    /** evaluate: the expression, in the frame where the program stopped. */
    expression?: string;
    /** How long to wait for the program to stop or end (start, continue, step). */
    timeoutSeconds?: number;
}

export const DEFAULT_DEBUG_WAIT_SECONDS = 60;
export const MAX_DEBUG_WAIT_SECONDS = 600;

const str = (args: Record<string, unknown>, key: string) => typeof args[key] === 'string' && (args[key] as string).trim() ? (args[key] as string).trim() : undefined;

/** The call from the model's arguments (native calls, or the fields of the fenced form). */
export function debugToolFromArgs(args: Record<string, unknown>): DebugTool | null {
    const action = str(args, 'action')?.toLowerCase() as DebugAction | undefined;
    if (!action || !DEBUG_ACTIONS.includes(action)) { return null; }
    const line = typeof args.line === 'number' ? args.line : Number(str(args, 'line'));
    const seconds = typeof args.timeout_seconds === 'number' ? args.timeout_seconds : Number(str(args, 'timeout_seconds'));
    const list = Array.isArray(args.args) ? (args.args as unknown[]).filter((a): a is string => typeof a === 'string') : str(args, 'args')?.split(/\s+/);
    const exceptions = str(args, 'exceptions')?.toLowerCase();
    const step = str(args, 'step')?.toLowerCase();
    const tool: DebugTool = {
        type: 'debug', action,
        ...(str(args, 'config') ? { config: str(args, 'config') } : {}),
        ...(str(args, 'program') ? { program: str(args, 'program') } : {}),
        ...(list?.length ? { args: list } : {}),
        ...(str(args, 'command') ? { command: str(args, 'command') } : {}),
        ...(exceptions === 'all' || exceptions === 'uncaught' || exceptions === 'none' ? { exceptions } : {}),
        ...(str(args, 'file') ? { file: str(args, 'file') } : {}),
        ...(Number.isInteger(line) && line > 0 ? { line } : {}),
        ...(str(args, 'condition') ? { condition: str(args, 'condition') } : {}),
        ...(str(args, 'log_message') ? { logMessage: str(args, 'log_message') } : {}),
        ...(args.remove === true || str(args, 'remove') === 'true' ? { remove: true } : {}),
        ...(step === 'over' || step === 'into' || step === 'out' ? { step } : {}),
        ...(str(args, 'expression') ? { expression: str(args, 'expression') } : {}),
        ...(Number.isFinite(seconds) && seconds > 0 ? { timeoutSeconds: seconds } : {}),
    };
    if (action === 'start' && !tool.config && !tool.program && !tool.command) { return null; }
    if (action === 'breakpoint' && (!tool.file || !tool.line)) { return null; }
    if (action === 'evaluate' && !tool.expression) { return null; }
    return tool;
}

/** The fenced form: "key: value" lines ("args" separated by spaces). */
export function parseDebugFence(body: string): DebugTool | null {
    const args: Record<string, unknown> = {};
    for (const line of body.split(/\r?\n/)) {
        const match = /^\s*([a-z_]+)\s*:\s*(.*?)\s*$/.exec(line);
        if (match) { args[match[1]] = match[2]; }
    }
    return debugToolFromArgs(args);
}

/**
 * An expression that only reads: names, property access, indexing, literals and operators —
 * no calls, assignments, increments, `new`, `delete` or `await`. Such an expression is
 * evaluated without asking; any other could change files or state, and is asked for.
 */
export function readOnlyExpression(expression: string): boolean {
    // A template literal can hold any code in ${…}: never a plain read
    if (expression.includes('`')) { return false; }
    const text = expression.replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, '""');
    if (/\(/.test(text.replace(/^\s*\(|\)\s*$/g, ''))) { return false; }
    if (/(?:^|[^=!<>])=(?!=)|\+\+|--|\b(?:new|delete|await|import|require|eval|function|class|yield|void|typeof\s*\()\b|=>|;/.test(text)) { return false; }
    return text.trim().length > 0 && text.length <= 300;
}

export function debugLabel(tool: DebugTool): string {
    switch (tool.action) {
        case 'start': return tool.config ? `start ${tool.config}` : tool.command ? `start ${tool.command}` : `start ${tool.program} ${(tool.args ?? []).join(' ')}`.trim();
        case 'breakpoint': return `${tool.remove ? 'remove ' : ''}breakpoint ${tool.file}:${tool.line}`;
        case 'step': return `step ${tool.step ?? 'over'}`;
        case 'evaluate': return `evaluate ${tool.expression}`.slice(0, 80);
        default: return tool.action;
    }
}

export interface Frame { name: string; file?: string; line: number; column?: number }
export interface Variable { name: string; value: string; type?: string }

/** Where the program stopped, as the agent reads it. */
export interface StopReport {
    reason: string;
    description?: string;
    /** The exception's type and message, when it stopped on one. */
    exception?: string;
    frames: Frame[];
    /** The lines around the top frame's line: [line number, text]. */
    source?: Array<[number, string]>;
    scopes: Array<{ name: string; variables: Variable[] }>;
    output: string[];
}

const short = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;

/** The report of a stop: reason, place with its source, call stack, variables, recent output. */
export function stopText(report: StopReport): string {
    const top = report.frames[0];
    const lines = [`Stopped (${report.reason}${report.description && report.description !== report.reason ? `: ${report.description}` : ''})${top ? ` in ${top.name} at ${top.file ?? '?'}:${top.line}` : ''}.`];
    if (report.exception) { lines.push(`Exception: ${short(report.exception, 600)}`); }
    if (report.source?.length) { lines.push('', ...report.source.map(([n, text]) => `${n === top?.line ? '→' : ' '}${String(n).padStart(5)}  ${short(text, 200)}`)); }
    if (report.frames.length) { lines.push('', 'Call stack:', ...report.frames.slice(0, 12).map((f, i) => `  ${i}. ${f.name} — ${f.file ?? '?'}:${f.line}`)); }
    for (const scope of report.scopes) {
        if (!scope.variables.length) { continue; }
        lines.push('', `${scope.name}:`, ...scope.variables.slice(0, 30).map(v => `  ${v.name}${v.type ? ` (${v.type})` : ''} = ${short(v.value, 200)}`));
        if (scope.variables.length > 30) { lines.push(`  … ${scope.variables.length - 30} more`); }
    }
    if (report.output.length) { lines.push('', 'Recent output:', ...report.output.slice(-15).map(l => `  ${short(l, 200)}`)); }
    return lines.join('\n');
}

/** The program ended: how, and its last output. */
export function endText(exitCode: number | undefined, output: string[]): string {
    return `The program ended${exitCode === undefined ? '' : ` with exit code ${exitCode}`}.${output.length ? `\nLast output:\n${output.slice(-25).map(l => `  ${short(l, 200)}`).join('\n')}` : ''}`;
}

export const DEBUG_DESCRIPTION = 'Drive a debugging session (real runtime state instead of guessing from source). Actions: ' +
    '"start" (config = a launch.json configuration, or program [+ args] run with the debugger, or command = a command such as "npm test" whose Node processes are all debugged; ' +
    'exceptions = all (default: stop where a failing test throws) | uncaught | none) waits until it stops and reports where, the call stack and the variables; ' +
    '"breakpoint" (file, line, condition, log_message, remove) — set them before start, or while paused; "continue", "step" (step = over | into | out) and "pause" wait for the next stop; ' +
    '"inspect" reports the current stop again; "evaluate" (expression) in the stopped frame; "rerun" starts the last session again (after a fix); "stop" ends it.';
