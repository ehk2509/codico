import * as os from 'os';
import { CliCommand, collectText, runCli } from './cliProcess';
import { ChatMessage, StreamChunk, SYSTEM_PROMPT } from './openRouterClient';
import { flattenChatHistory } from './providerConversation';

/**
 * Claude Code as a provider: requests go through the user's installed `claude` command
 * and Claude login, with no API key. Claude Code's own tools are switched off — Codico
 * stays in charge of files and commands and asks for its tools in the text (fenced) format.
 *
 * Each request is one non-interactive run (`claude -p`) that gets the conversation so far
 * and writes the next assistant turn.
 */

export const CLAUDE_CODE_PREFIX = 'claude-code/';
/** Model aliases Claude Code resolves to its current models. */
export const CLAUDE_CODE_MODELS = ['sonnet', 'opus', 'haiku', 'fable'] as const;

export type ClaudeCodeCommand = CliCommand;

/** A command line longer than this is refused on Windows; the system prompt then travels in the prompt instead. */
const MAX_SYSTEM_PROMPT_ARG = 24_000;

/** The conversation as the prompt of one run: the next assistant turn is what the model writes. */
export function claudeCodePrompt(history: ChatMessage[]): string {
    const turns = flattenChatHistory(history).filter(m => m.role === 'user' || m.role === 'assistant');
    const text = (content: unknown): string => typeof content === 'string'
        ? content
        : (content as Array<{ type: string; text?: string }>).filter(p => p.type === 'text').map(p => p.text ?? '').join('');
    if (turns.length === 1 && turns[0].role === 'user') { return text(turns[0].content); }
    const transcript = turns.map(m => `<${m.role}>\n${text(m.content)}\n</${m.role}>`).join('\n');
    return 'The conversation so far is below. Write the next assistant turn only, continuing from where it ends.\n\n' +
        `<conversation>\n${transcript}\n</conversation>`;
}

function buildArgs(model: string, system: string, effort: 'high' | 'medium' | 'low'): string[] {
    return [
        '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        // No Claude Code tools, skills or MCP servers: only the model
        '--tools', '', '--disable-slash-commands', '--strict-mcp-config',
        '--no-session-persistence',
        '--model', model, '--effort', effort,
        '--system-prompt', system,
    ];
}

function childEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    // Set when Codico itself runs under Claude Code; the child must not think it is nested
    for (const key of Object.keys(env)) { if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) { delete env[key]; } }
    return env;
}

/** One line of the CLI's stream-json output → stream chunks. */
export function parseClaudeCodeLine(line: string, state: { sawText: boolean }): StreamChunk[] {
    let json: Record<string, unknown>;
    try { json = JSON.parse(line) as Record<string, unknown>; } catch { return []; }
    if (json.type === 'stream_event') {
        const delta = (json.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } } | undefined);
        if (delta?.type !== 'content_block_delta' || !delta.delta) { return []; }
        if (delta.delta.type === 'text_delta' && delta.delta.text) { state.sawText = true; return [{ type: 'content', text: delta.delta.text }]; }
        if (delta.delta.type === 'thinking_delta' && delta.delta.thinking) { return [{ type: 'thinking', text: delta.delta.thinking }]; }
        return [];
    }
    if (json.type !== 'result') { return []; }
    const chunks: StreamChunk[] = [];
    const result = typeof json.result === 'string' ? json.result : '';
    if (json.is_error === true || (typeof json.subtype === 'string' && json.subtype !== 'success')) {
        chunks.push({ type: 'stream_error', message: `Claude Code: ${result || String(json.subtype ?? 'the request failed')}` });
    } else if (!state.sawText && result) {
        // Partial messages were not streamed: the final text is the reply
        chunks.push({ type: 'content', text: result });
    }
    const usage = json.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
    if (usage) {
        const cached = usage.cache_read_input_tokens ?? 0;
        const prompt = (usage.input_tokens ?? 0) + cached + (usage.cache_creation_input_tokens ?? 0);
        const completion = usage.output_tokens ?? 0;
        // No cost: on a Claude subscription the CLI's figure is an estimate, not a charge
        chunks.push({ type: 'usage', promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, ...(cached ? { cachedTokens: cached } : {}) });
    }
    if (json.stop_reason === 'max_tokens') { chunks.push({ type: 'finish', reason: 'length' }); }
    return chunks;
}

export function streamClaudeCode(
    cli: ClaudeCodeCommand,
    history: ChatMessage[],
    model: string,
    systemPromptPrefix?: string,
    signal?: AbortSignal,
    effort: 'high' | 'medium' | 'low' = 'medium',
    overrideSystemPrompt?: string,
): AsyncIterable<StreamChunk> {
    const base = overrideSystemPrompt ?? SYSTEM_PROMPT;
    const fullSystem = systemPromptPrefix ? `${base}\n\n${systemPromptPrefix}` : base;
    // Too long for a command line: the extra instructions go at the top of the prompt instead
    const fits = fullSystem.length <= MAX_SYSTEM_PROMPT_ARG;
    const system = fits ? fullSystem : base.slice(0, MAX_SYSTEM_PROMPT_ARG);
    const prompt = (fits ? '' : `<instructions>\n${fullSystem.slice(system.length)}\n</instructions>\n\n`) + claudeCodePrompt(history);
    const state = { sawText: false };
    return runCli({
        name: 'Claude Code', cli, args: buildArgs(model, system, effort), stdin: prompt, signal,
        // A neutral folder: the user's project CLAUDE.md, settings and hooks are for their own Claude Code sessions
        cwd: os.tmpdir(), env: childEnv(),
        parseLine: line => parseClaudeCodeLine(line, state),
        notFound: 'Claude Code was not found. Install it (or the Claude Code VS Code extension), or set "codico.claudeCodePath" to the claude command.',
        signInHint: 'If you are not signed in, run "claude" in a terminal and log in.',
    });
}

/** A one-shot request (compaction summaries): the reply text, or '' on failure. */
export function claudeCodeCompletion(cli: ClaudeCodeCommand, prompt: string, model: string, signal?: AbortSignal): Promise<string> {
    return collectText(streamClaudeCode(cli, [{ role: 'user', content: prompt }], model, undefined, signal, 'low',
        'You complete one writing task and reply with the result only.'));
}
