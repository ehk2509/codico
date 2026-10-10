import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeCodePrompt } from './claudeCodeClient';
import { CliCommand, collectText, runCli } from './cliProcess';
import { ChatMessage, StreamChunk, SYSTEM_PROMPT } from './openRouterClient';

/**
 * ChatGPT as a provider: requests go through OpenAI's `codex` command and the user's
 * ChatGPT login (`codex login`), with no API key. Codex's own tools are switched off —
 * Codico stays in charge of files and commands and asks for its tools in the text (fenced)
 * format.
 *
 * Each request is one non-interactive run (`codex exec --json`) that gets the conversation
 * so far and writes the next assistant turn. Codex prints a reply when it is complete, so
 * the text arrives in one piece rather than word by word.
 */

export const CHATGPT_PREFIX = 'chatgpt/';

/**
 * Codex features that give the model tools, extra instructions or side effects of its own.
 * Only the ones the installed version knows are switched off: it refuses unknown names.
 */
const FEATURES_OFF = [
    'shell_tool', 'unified_exec', 'view_image', 'goals', 'tool_search', 'apps', 'plugins', 'multi_agent',
    'skill_search', 'tool_suggest', 'hooks', 'image_generation', 'browser_use', 'computer_use', 'memories',
];

const knownFeatures = new Map<string, Promise<string[]>>();

/** The feature names this `codex` knows (first column of `codex features list`), asked once per command. */
export function codexFeatures(cli: CliCommand): Promise<string[]> {
    const key = [cli.command, ...(cli.baseArgs ?? [])].join('\n');
    let known = knownFeatures.get(key);
    if (!known) {
        known = new Promise<string[]>(resolve => {
            cp.execFile(cli.command, [...(cli.baseArgs ?? []), 'features', 'list'], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
                if (err) { knownFeatures.delete(key); resolve([]); return; }
                resolve(String(stdout).split('\n').map(line => /^([a-z0-9_.]+)\s+\S/.exec(line)?.[1] ?? '').filter(Boolean));
            });
        });
        knownFeatures.set(key, known);
    }
    return known;
}

/** A TOML string value for `-c key=value`. */
const toml = (value: string): string => JSON.stringify(value);

export function codexArgs(model: string, effort: 'high' | 'medium' | 'low', instructionsFile: string, features: string[]): string[] {
    return [
        'exec', '--json', '--skip-git-repo-check', '--ephemeral',
        // The user's own Codex settings, rules and project notes are for their Codex sessions
        '--ignore-user-config', '--ignore-rules', '-c', 'project_doc_max_bytes=0',
        // Nothing can be written or run: Codico does that, with the user's approvals
        '-s', 'read-only', '-c', 'web_search="disabled"', '-c', 'skills.include_instructions=false',
        ...FEATURES_OFF.filter(name => features.includes(name)).flatMap(name => ['--disable', name]),
        '-m', model, '-c', `model_reasoning_effort=${toml(effort)}`,
        // Codico's system prompt replaces Codex's own
        '-c', `model_instructions_file=${toml(instructionsFile)}`,
        '-', // the prompt is read from stdin
    ];
}

/** Codex still offers the model these two tools of its own; they do nothing in a read-only run. */
const NO_CODEX_TOOLS = 'Never call the apply_patch or request_user_input tools: they do nothing here. Use only the fenced-code-block tool formats described above.';

const SIGN_IN_HINT = 'If you are not signed in, run "codex login" in a terminal and sign in with ChatGPT.';

/** One line of `codex exec --json` → stream chunks. */
export function parseCodexLine(line: string, state: { sawText: boolean; lastError: string }): StreamChunk[] {
    let json: Record<string, unknown>;
    try { json = JSON.parse(line) as Record<string, unknown>; } catch { return []; } // log lines are not JSON
    if (json.type === 'item.completed') {
        const item = json.item as { type?: string; text?: string } | undefined;
        if (!item?.text) { return []; }
        if (item.type === 'reasoning') { return [{ type: 'thinking', text: `${item.text}\n` }]; }
        if (item.type !== 'agent_message') { return []; }
        const text = state.sawText ? `\n\n${item.text}` : item.text;
        state.sawText = true;
        return [{ type: 'content', text }];
    }
    if (json.type === 'error') {
        // Also printed for each retry ("Reconnecting... 2/5"): only the turn's end decides
        state.lastError = typeof json.message === 'string' ? json.message : state.lastError;
        return [];
    }
    if (json.type === 'turn.failed') {
        const message = (json.error as { message?: string } | undefined)?.message || state.lastError || 'the request failed';
        return [{ type: 'stream_error', message: `ChatGPT: ${message}${/401|unauthori[sz]ed|not logged in|sign in/i.test(message) ? `. ${SIGN_IN_HINT}` : ''}` }];
    }
    if (json.type !== 'turn.completed') { return []; }
    const usage = json.usage as { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } | undefined;
    if (!usage) { return []; }
    const prompt = usage.input_tokens ?? 0;
    const completion = usage.output_tokens ?? 0;
    const cached = usage.cached_input_tokens ?? 0;
    // No cost: a ChatGPT plan is not billed per request
    return [{ type: 'usage', promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, ...(cached ? { cachedTokens: cached } : {}) }];
}

function childEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    // An API key in the environment would be used (and billed) instead of the ChatGPT login
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    return env;
}

export async function* streamChatGPT(
    cli: CliCommand,
    history: ChatMessage[],
    model: string,
    systemPromptPrefix?: string,
    signal?: AbortSignal,
    effort: 'high' | 'medium' | 'low' = 'medium',
    overrideSystemPrompt?: string,
): AsyncGenerator<StreamChunk> {
    const base = overrideSystemPrompt ?? `${SYSTEM_PROMPT}\n\n${NO_CODEX_TOOLS}`;
    const system = systemPromptPrefix ? `${base}\n\n${systemPromptPrefix}` : base;
    const features = await codexFeatures(cli);
    // A folder of its own: Codex is told its working directory, and it must not be the user's project
    const dir = path.join(os.tmpdir(), 'codico-chatgpt');
    const instructionsFile = path.join(dir, `instructions-${crypto.randomBytes(6).toString('hex')}.md`);
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(instructionsFile, system, { mode: 0o600 });
    } catch (err) {
        throw new Error(`Could not prepare the ChatGPT request: ${err instanceof Error ? err.message : String(err)}`);
    }
    const state = { sawText: false, lastError: '' };
    try {
        yield* runCli({
            name: 'ChatGPT', cli, args: codexArgs(model, effort, instructionsFile, features), stdin: claudeCodePrompt(history), signal,
            cwd: dir, env: childEnv(),
            parseLine: line => parseCodexLine(line, state),
            notFound: 'The codex command was not found. Install it ("npm install -g @openai/codex"), run "codex login", or set "codico.codexPath" to the codex command.',
            signInHint: SIGN_IN_HINT,
        });
    } finally {
        fs.rm(instructionsFile, { force: true }, () => { /* a leftover file in the temp folder is harmless */ });
    }
}

/** A one-shot request (compaction summaries): the reply text, or '' on failure. */
export function chatgptCompletion(cli: CliCommand, prompt: string, model: string, signal?: AbortSignal): Promise<string> {
    return collectText(streamChatGPT(cli, [{ role: 'user', content: prompt }], model, undefined, signal, 'low',
        'You complete one writing task and reply with the result only.'));
}
