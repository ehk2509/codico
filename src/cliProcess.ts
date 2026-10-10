import * as cp from 'child_process';
import { StreamChunk } from './openRouterClient';

/** How to start a CLI. Tests pass a script run by Node instead of the real command. */
export interface CliCommand {
    command: string;
    /** Arguments placed before Codico's own (e.g. the script path, for tests). */
    baseArgs?: string[];
}

/** One non-interactive run of a provider's CLI (Claude Code, Codex). */
export interface CliRun {
    /** The provider's name, for error messages. */
    name: string;
    cli: CliCommand;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    /** The prompt: it goes in on stdin, as it can be far longer than a command line allows. */
    stdin: string;
    signal?: AbortSignal;
    /** One line of the CLI's output → stream chunks. */
    parseLine(line: string): StreamChunk[];
    /** Shown when the command does not exist. */
    notFound: string;
    /** Added to the error when the CLI exits with a failure (usually: not signed in). */
    signInHint: string;
}

/** Runs the CLI and yields what it prints as stream chunks. */
export function runCli(run: CliRun): AsyncIterable<StreamChunk> {
    const queue: Array<StreamChunk | null | Error> = [];
    let wake: (() => void) | null = null;
    let ended = false;
    let failed = false;
    const push = (item: StreamChunk | null | Error): void => {
        if (ended) { return; }
        if (item === null || item instanceof Error) { ended = true; }
        else if (item.type === 'stream_error') { failed = true; }
        queue.push(item);
        wake?.(); wake = null;
    };
    const iterable = iterate(queue, w => { wake = w; });

    if (run.signal?.aborted) { push(null); return iterable; }
    let child: cp.ChildProcess;
    try {
        child = cp.spawn(run.cli.command, [...(run.cli.baseArgs ?? []), ...run.args], {
            cwd: run.cwd, env: run.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
    } catch (err) {
        push(new Error(`Could not start ${run.name}: ${err instanceof Error ? err.message : String(err)}`));
        return iterable;
    }
    let buffer = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (data: string) => {
        buffer += data;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) { if (line.trim()) { run.parseLine(line).forEach(push); } }
    });
    child.stderr?.on('data', (data: string) => { stderr = (stderr + data).slice(-2000); });
    child.on('error', (err: NodeJS.ErrnoException) => {
        push(new Error(err.code === 'ENOENT' ? run.notFound : `Could not start ${run.name}: ${err.message}`));
    });
    child.on('close', (code) => {
        if (buffer.trim()) { run.parseLine(buffer).forEach(push); }
        // A failure the output did not already explain
        if (code !== 0 && !run.signal?.aborted && !ended && !failed) {
            const reason = stderr.trim().split('\n').pop() || `it exited with code ${code}`;
            push({ type: 'stream_error', message: `${run.name}: ${reason}. ${run.signInHint}` });
        }
        push(null);
    });
    child.stdin?.on('error', () => { /* the process exited early; 'close' reports why */ });
    child.stdin?.end(run.stdin);
    run.signal?.addEventListener('abort', () => { child.kill(); push(null); }, { once: true });
    return iterable;
}

function iterate(queue: Array<StreamChunk | null | Error>, wait: (wake: () => void) => void): AsyncIterable<StreamChunk> {
    return {
        [Symbol.asyncIterator]() {
            return {
                async next(): Promise<IteratorResult<StreamChunk>> {
                    while (queue.length === 0) { await new Promise<void>(resolve => wait(resolve)); }
                    const item = queue.shift()!;
                    if (item === null) { return { value: undefined as unknown as StreamChunk, done: true }; }
                    if (item instanceof Error) { throw item; }
                    return { value: item, done: false };
                },
            };
        },
    };
}

/** The text a run replies with, or '' on failure (one-shot jobs such as compaction summaries). */
export async function collectText(stream: AsyncIterable<StreamChunk>): Promise<string> {
    let text = '';
    try {
        for await (const chunk of stream) { if (chunk.type === 'content') { text += chunk.text; } }
    } catch { return ''; }
    return text;
}
