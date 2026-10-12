import * as crypto from 'crypto';
import { ToolCall } from './toolParser';

/**
 * Lifecycle hooks: commands a project runs around the agent's edits and commands, declared
 * in `.codico/hooks.json` and committed with the code.
 *
 *   beforeEdit     before a file is written; a non-zero exit refuses the edit
 *   afterEdit      after a file was written; its output is shown to the agent (a formatter, a linter)
 *   beforeCommand  before a terminal command runs; a non-zero exit refuses it
 *   afterCommand   after a terminal command finished; its output is shown to the agent
 *
 * This module is the format and the rules; running the commands is in hookRunner.
 */

export const HOOK_EVENTS = ['beforeEdit', 'afterEdit', 'beforeCommand', 'afterCommand'] as const;
export type HookEvent = typeof HOOK_EVENTS[number];

export interface Hook {
    event: HookEvent;
    /** The shell command. `{file}` is replaced by the edited file's path, quoted. */
    command: string;
    /** Which files (a path glob) or which commands (`*` matches anything) the hook is for. All when absent. */
    match?: string;
    /** Shown in messages; the command when absent. */
    name?: string;
    timeoutSeconds: number;
}

export const DEFAULT_HOOK_TIMEOUT_SECONDS = 30;
export const MAX_HOOK_TIMEOUT_SECONDS = 600;
export const MAX_HOOKS = 20;
/** What of a hook's output is passed on: enough for an error list, not a build log. */
export const MAX_HOOK_OUTPUT_CHARS = 4000;

/** The hooks of a `.codico/hooks.json`, and what is wrong with the entries that were skipped. */
export function parseHooks(text: string): { hooks: Hook[]; problems: string[] } {
    let json: unknown;
    try { json = JSON.parse(text); } catch (err) { return { hooks: [], problems: [`hooks.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`] }; }
    const list = Array.isArray(json) ? json : (json as { hooks?: unknown } | null)?.hooks;
    if (!Array.isArray(list)) { return { hooks: [], problems: ['hooks.json must be { "hooks": [ … ] }'] }; }
    const hooks: Hook[] = [];
    const problems: string[] = [];
    list.forEach((raw, index) => {
        const where = `hooks[${index}]`;
        const entry = raw as Partial<Record<keyof Hook, unknown>> | null;
        if (!entry || typeof entry !== 'object') { problems.push(`${where}: must be an object`); return; }
        if (typeof entry.event !== 'string' || !(HOOK_EVENTS as readonly string[]).includes(entry.event)) {
            problems.push(`${where}: "event" must be one of ${HOOK_EVENTS.join(', ')}`); return;
        }
        if (typeof entry.command !== 'string' || !entry.command.trim()) { problems.push(`${where}: "command" is required`); return; }
        if (entry.match !== undefined && (typeof entry.match !== 'string' || !entry.match.trim())) { problems.push(`${where}: "match" must be a non-empty string`); return; }
        const timeout = entry.timeoutSeconds === undefined ? DEFAULT_HOOK_TIMEOUT_SECONDS : Number(entry.timeoutSeconds);
        if (!Number.isFinite(timeout) || timeout <= 0) { problems.push(`${where}: "timeoutSeconds" must be a positive number`); return; }
        hooks.push({
            event: entry.event as HookEvent, command: entry.command.trim(),
            ...(entry.match ? { match: (entry.match as string).trim() } : {}),
            ...(typeof entry.name === 'string' && entry.name.trim() ? { name: entry.name.trim().slice(0, 60) } : {}),
            timeoutSeconds: Math.min(MAX_HOOK_TIMEOUT_SECONDS, timeout),
        });
    });
    if (hooks.length > MAX_HOOKS) { problems.push(`only the first ${MAX_HOOKS} hooks are used (${hooks.length} given)`); }
    return { hooks: hooks.slice(0, MAX_HOOKS), problems };
}

/**
 * A `match` as a pattern. For files it is a path glob (`**` crosses folders, `*` stays in
 * one, a pattern without `/` matches the file name in any folder). For commands `*` matches
 * anything and the rest is literal.
 */
export function matcher(glob: string, kind: 'file' | 'command'): RegExp {
    const escape = (text: string): string => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    if (kind === 'command') { return new RegExp(`^${glob.trim().split('*').map(escape).join('[\\s\\S]*')}$`); }
    let pattern = '';
    for (let i = 0; i < glob.length; i++) {
        if (glob.startsWith('**/', i)) { pattern += '(?:.*/)?'; i += 2; }
        else if (glob.startsWith('**', i)) { pattern += '.*'; i += 1; }
        else if (glob[i] === '*') { pattern += '[^/]*'; }
        else if (glob[i] === '?') { pattern += '[^/]'; }
        else { pattern += escape(glob[i]); }
    }
    return new RegExp(`^${glob.includes('/') ? '' : '(?:.*/)?'}${pattern}$`);
}

/** What a tool call means for hooks: its two events and what `match` is tested against. Null for tools hooks do not cover. */
export function hookSubject(tool: ToolCall): { before: HookEvent; after: HookEvent; kind: 'file' | 'command'; subject: string } | null {
    if (tool.type === 'write_file' || tool.type === 'edit_file') { return { before: 'beforeEdit', after: 'afterEdit', kind: 'file', subject: tool.filepath.replace(/\\/g, '/').replace(/^\.\//, '') }; }
    if (tool.type === 'run_terminal') { return { before: 'beforeCommand', after: 'afterCommand', kind: 'command', subject: tool.command.trim() }; }
    return null;
}

export function hooksFor(hooks: Hook[], event: HookEvent, kind: 'file' | 'command', subject: string): Hook[] {
    return hooks.filter(hook => hook.event === event && (!hook.match || matcher(hook.match, kind).test(subject)));
}

/** Identifies a hook by exactly what would run: a changed command is a different hook and is asked about again. */
export function hookFingerprint(hook: Hook): string {
    return crypto.createHash('sha256').update(JSON.stringify([hook.event, hook.command, hook.match ?? '', hook.timeoutSeconds])).digest('hex');
}

/** A path as one shell word. */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
    return platform === 'win32' ? `"${value.replace(/["%!^]/g, '')}"` : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command line of a hook for one tool call. */
export function hookCommandLine(hook: Hook, file: string, platform: NodeJS.Platform = process.platform): string {
    return hook.command.replace(/\{file\}/g, shellQuote(file, platform));
}

/** What the hook can read: the event and the tool call, as environment variables and (in full) as a JSON file. */
export function hookInput(hook: Hook, tool: ToolCall, extra: { exitCode?: number; output?: string } = {}): { env: Record<string, string>; json: Record<string, unknown> } {
    const subject = hookSubject(tool);
    const file = subject?.kind === 'file' ? subject.subject : '';
    const command = tool.type === 'run_terminal' ? tool.command : '';
    const json: Record<string, unknown> = { event: hook.event, tool: tool.type };
    if (file) { json.file = file; }
    if (tool.type === 'write_file') { json.content = tool.content; }
    if (tool.type === 'edit_file') { json.oldText = tool.oldStr; json.newText = tool.newStr; }
    if (command) { json.command = command; }
    if (extra.exitCode !== undefined) { json.exitCode = extra.exitCode; }
    if (extra.output !== undefined) { json.output = extra.output; }
    return {
        json,
        env: {
            CODICO_HOOK_EVENT: hook.event, CODICO_HOOK_TOOL: tool.type, CODICO_HOOK_FILE: file, CODICO_HOOK_COMMAND: command,
            ...(extra.exitCode !== undefined ? { CODICO_HOOK_EXIT_CODE: String(extra.exitCode) } : {}),
        },
    };
}

/** Whether a tool call did what it was asked, from its result text: an edit that was refused or failed has no "after". */
export function toolOutcome(tool: ToolCall, result: string): { succeeded: boolean; exitCode?: number } {
    if (tool.type === 'edit_file') { return { succeeded: /\] Edit applied successfully/.test(result) }; }
    if (tool.type === 'write_file') { return { succeeded: /\] Written successfully/.test(result) }; }
    if (tool.type === 'run_terminal') {
        const exit = /^\[run_terminal: [\s\S]*?\]\nExit: (-?\d+)/.exec(result);
        return exit ? { succeeded: true, exitCode: Number(exit[1]) } : { succeeded: false };
    }
    return { succeeded: false };
}

function clip(output: string): string {
    const text = output.trim();
    return text.length <= MAX_HOOK_OUTPUT_CHARS ? text : `${text.slice(0, MAX_HOOK_OUTPUT_CHARS)}\n… (${(text.length - MAX_HOOK_OUTPUT_CHARS).toLocaleString('en-US')} more characters)`;
}

export const hookLabel = (hook: Hook): string => hook.name ?? (hook.command.length > 60 ? `${hook.command.slice(0, 60)}…` : hook.command);

/** The tool result when a "before" hook refuses the call. */
export function refusalText(tool: ToolCall, hook: Hook, how: { exitCode: number; timedOut: boolean; output: string }): string {
    const what = tool.type === 'run_terminal' ? 'the command was not run' : `${(tool as { filepath?: string }).filepath ?? 'the file'} was not changed`;
    const why = how.timedOut ? `it did not finish within ${hook.timeoutSeconds} seconds` : `it exited with code ${how.exitCode}`;
    const output = clip(how.output);
    return `[${tool.type}] Refused by the project's ${hook.event} hook "${hookLabel(hook)}": ${why}, so ${what}.` +
        (output ? `\nThe hook said:\n${output}` : '') +
        '\nThis is a rule of the project, not an error to retry: change what you are doing so that it passes, or tell the user why it cannot.';
}

/** What an "after" hook adds to the tool result; nothing when it passed in silence. */
export function reportText(hook: Hook, how: { exitCode: number; timedOut: boolean; output: string }): string {
    const output = clip(how.output);
    if (how.exitCode === 0 && !how.timedOut && !output) { return ''; }
    const status = how.timedOut ? `did not finish within ${hook.timeoutSeconds} seconds` : how.exitCode === 0 ? 'passed' : `failed (exit ${how.exitCode})`;
    return `\n\n[Project ${hook.event} hook "${hookLabel(hook)}" ${status}]${output ? `\n${output}` : ''}`;
}

/** A starting `.codico/hooks.json`, written by the "New Hooks File" command. */
export const HOOKS_TEMPLATE = JSON.stringify({
    hooks: [
        { event: 'afterEdit', match: '**/*.ts', name: 'lint the file', command: 'npx eslint --no-warn-ignored {file}', timeoutSeconds: 60 },
        { event: 'beforeEdit', match: 'migrations/**', name: 'migrations are append-only', command: 'node scripts/check-migration.js' },
        { event: 'beforeCommand', match: 'git push*', name: 'no pushing from the agent', command: 'exit 1' },
    ],
}, null, 2) + '\n';
