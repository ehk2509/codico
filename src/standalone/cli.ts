/** Cross-platform CLI entry point used by bin/codico.js. */
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { StandaloneAgent, StandaloneEvent } from './agent';
import type { CliPermission } from './nodeWorkspace';

export const HELP = `Codico standalone coding agent (Windows, macOS, Linux; Node.js 20+)

Usage:
  codico                         Interactive session (no VS Code required)
  codico chat [options]          Interactive session
  codico agent "<task>" [options]  Run one task and exit

Options:
  --cwd <directory>              Project root (default: current directory)
  --model <id>                   ollama/model, direct:provider/model, or OpenRouter model
  --ollama-url <url>             Ollama/OpenAI-compatible local endpoint (default: http://localhost:11434)
  --allow-edits                  Permit file edits after individual confirmation
  --allow-commands               Permit edits and shell commands after individual confirmation
  --yes                          Skip individual confirmations for explicitly permitted actions
  --max-steps <n>                Max model requests per user turn (default: 20)
  --json                         Print newline-delimited JSON events (agent mode only)
  -h, --help                     Show help

Examples:
  codico chat --model ollama/qwen2.5-coder:7b
  codico agent "Review src" --model direct:deepseek/deepseek-flash
  codico agent "Fix tests" --model direct:anthropic/claude-sonnet-4-5-20251001 --allow-commands

Keys: OPENROUTER_API_KEY or provider-specific API keys, e.g. DEEPSEEK_API_KEY.
Read-only by default. In noninteractive sessions, mutations require both --allow-edits/--allow-commands and --yes.
Legacy editor-backed 'codico run' and 'codico automate' remain unchanged.
`;

export interface CliOptions {
    mode: 'chat' | 'agent';
    prompt: string;
    cwd: string;
    model: string;
    permissions: CliPermission;
    yes: boolean;
    maxSteps: number;
    ollamaUrl: string;
    json: boolean;
    help: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
    const args = [...argv];
    const mode = args[0] === 'agent' ? 'agent' : 'chat';
    if (args[0] === 'agent' || args[0] === 'chat') { args.shift(); }
    const opts: CliOptions = {
        mode, prompt: '', cwd: process.cwd(), model: process.env.CODICO_MODEL || 'ollama/qwen2.5-coder:7b',
        permissions: 'read', yes: false, maxSteps: 20, ollamaUrl: 'http://localhost:11434', json: false, help: false,
    };
    const parts: string[] = [];
    const value = (arg: string, i: number) => {
        if (!args[i + 1] || args[i + 1].startsWith('--')) { throw new Error(`${arg} requires a value`); }
        return args[i + 1];
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        switch (a) {
            case '-h': case '--help': opts.help = true; break;
            case '--cwd': opts.cwd = path.resolve(value(a, i++)); break;
            case '--model': opts.model = value(a, i++); break;
            case '--ollama-url': opts.ollamaUrl = value(a, i++); break;
            case '--allow-edits': if (opts.permissions === 'read') { opts.permissions = 'edits'; } break;
            case '--allow-commands': opts.permissions = 'all'; break;
            case '--yes': opts.yes = true; break;
            case '--json': opts.json = true; break;
            case '--max-steps': {
                const n = Number(value(a, i++));
                if (!Number.isInteger(n) || n < 1 || n > 100) { throw new Error('--max-steps must be 1 to 100'); }
                opts.maxSteps = n; break;
            }
            default:
                if (a.startsWith('-')) { throw new Error(`Unknown option ${a}`); }
                parts.push(a);
        }
    }
    if (mode === 'chat' && parts.length) { throw new Error('Unexpected task text. Use "codico agent <task>" for one-off tasks.'); }
    opts.prompt = parts.join(' ').trim();
    if (mode === 'agent' && !opts.help && !opts.prompt) { throw new Error('codico agent requires a task'); }
    if (mode === 'chat' && opts.json) { throw new Error('--json is only supported with codico agent'); }
    return opts;
}

export async function main(argv: string[]): Promise<number> {
    let opts: CliOptions;
    try { opts = parseCliArgs(argv); }
    catch (error) { stderr.write(`codico: ${(error as Error).message}\n\n${HELP}`); return 64; }
    if (opts.help) { stdout.write(HELP); return 0; }
    const terminal = readline.createInterface({ input: stdin, output: stdout, terminal: !!stdin.isTTY });
    const approve = async (kind: 'write' | 'command', description: string): Promise<boolean> => {
        if (opts.yes) { return true; }
        if (!stdin.isTTY) { return false; }
        const answer = await terminal.question(`\nCodico requests permission to ${description}\nAllow ${kind}? [y/N] `);
        return /^(y|yes)$/i.test(answer.trim());
    };
    const event = (e: StandaloneEvent): void => {
        if (opts.json) { stdout.write(JSON.stringify(e) + '\n'); return; }
        if (e.type === 'text') { stdout.write(`\n${e.text}\n`); }
        else if (e.type === 'toolStart') { stderr.write(`  ▸ ${e.tool} ${e.text ?? ''}\n`); }
        else if (e.type === 'toolResult' && !e.ok) { stderr.write(`  ✗ ${e.tool}: ${(e.text ?? '').slice(0, 300)}\n`); }
    };
    const makeAgent = () => new StandaloneAgent({
        cwd: opts.cwd, model: opts.model, permissions: opts.permissions, maxSteps: opts.maxSteps,
        ollamaUrl: opts.ollamaUrl, approve, onEvent: event,
    });
    let agent: StandaloneAgent;
    try { agent = makeAgent(); }
    catch (error) { stderr.write(`codico: ${(error as Error).message}\n`); terminal.close(); return 1; }
    const run = async (prompt: string): Promise<void> => {
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.on('SIGINT', stop);
        try { await agent.run(prompt, controller.signal); }
        finally { process.removeListener('SIGINT', stop); }
    };
    try {
        if (opts.mode === 'agent') {
            await run(opts.prompt);
            return 0;
        }
        if (!stdin.isTTY) { stderr.write('codico: interactive chat requires a TTY. Use codico agent "<task>" for scripts.\n'); return 64; }
        stdout.write(`Codico CLI · ${opts.model} · ${agent.workspace.cwd}\nType /help for commands, /exit to quit.\n`);
        for (;;) {
            const prompt = (await terminal.question('codico> ')).trim();
            if (!prompt) { continue; }
            if (prompt === '/exit' || prompt === '/quit') { break; }
            if (prompt === '/help') { stdout.write('/exit  /clear  /model <id>  /help\n'); continue; }
            if (prompt === '/clear') { agent = makeAgent(); stdout.write('Conversation cleared.\n'); continue; }
            if (prompt.startsWith('/model ')) {
                opts.model = prompt.slice('/model '.length).trim();
                agent = makeAgent();
                stdout.write(`Model: ${opts.model} (new conversation)\n`); continue;
            }
            try { await run(prompt); }
            catch (error) { stderr.write(`codico: ${(error as Error).message}\n`); }
        }
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (opts.json) { stdout.write(JSON.stringify({ type: 'error', message }) + '\n'); }
        else { stderr.write(`codico: ${message}\n`); }
        return 1;
    } finally {
        terminal.close();
    }
}
