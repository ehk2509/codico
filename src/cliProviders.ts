import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CHATGPT_PREFIX, chatgptCompletion, streamChatGPT } from './chatgptClient';
import { CLAUDE_CODE_PREFIX, claudeCodeCompletion, streamClaudeCode } from './claudeCodeClient';
import { claudeCodeCommand } from './claudeCodePath';
import { CliCommand } from './cliProcess';
import { ChatMessage, StreamChunk } from './openRouterClient';

/**
 * Providers that run through a command the user has installed and signed in to
 * (Claude Code, ChatGPT through Codex): no API key, and tools in the text (fenced) format.
 */

/** True for a model that runs through one of those commands. */
export function isCliModel(model: string): boolean {
    return model.startsWith(CLAUDE_CODE_PREFIX) || model.startsWith(CHATGPT_PREFIX);
}

function onPath(names: string[]): string | undefined {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        for (const name of names) {
            const candidate = path.join(dir, name);
            if (dir && fs.existsSync(candidate)) { return candidate; }
        }
    }
    return undefined;
}

/**
 * Where the `codex` command is: the "codico.codexPath" setting, else the PATH, else the
 * binary bundled with OpenAI's VS Code extension.
 */
export function codexCommand(): CliCommand {
    const configured = vscode.workspace.getConfiguration('codico').get<string>('codexPath', '').trim();
    if (configured) { return { command: configured }; }
    const windows = process.platform === 'win32';
    const found = onPath(windows ? ['codex.exe', 'codex.cmd'] : ['codex']);
    if (found?.endsWith('.cmd')) {
        // npm's launcher script cannot be started directly: run the script it launches
        const script = path.join(path.dirname(found), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        if (fs.existsSync(script)) { return { command: onPath(['node.exe']) ?? 'node', baseArgs: [script] }; }
    } else if (found) {
        return { command: found };
    }
    const extension = vscode.extensions.getExtension('openai.chatgpt');
    const bin = extension ? path.join(extension.extensionPath, 'bin') : '';
    if (bin && fs.existsSync(bin)) {
        for (const platform of fs.readdirSync(bin)) {
            const candidate = path.join(bin, platform, windows ? 'codex.exe' : 'codex');
            if (fs.existsSync(candidate)) { return { command: candidate }; }
        }
    }
    // Not found anywhere: starting "codex" fails with a message saying how to install or configure it
    return { command: 'codex' };
}

/** Whether each provider's command was found (a bare command name means it was not). */
export function cliProvidersInstalled(): Record<string, boolean> {
    const found = (command: string): boolean => path.isAbsolute(command) && fs.existsSync(command);
    return { 'claude-code': found(claudeCodeCommand().command), chatgpt: found(codexCommand().command) };
}

export function streamCliModel(
    model: string,
    history: ChatMessage[],
    systemPromptPrefix?: string,
    signal?: AbortSignal,
    effort: 'high' | 'medium' | 'low' = 'medium',
    overrideSystemPrompt?: string,
): AsyncIterable<StreamChunk> {
    return model.startsWith(CHATGPT_PREFIX)
        ? streamChatGPT(codexCommand(), history, model.slice(CHATGPT_PREFIX.length), systemPromptPrefix, signal, effort, overrideSystemPrompt)
        : streamClaudeCode(claudeCodeCommand(), history, model.slice(CLAUDE_CODE_PREFIX.length), systemPromptPrefix, signal, effort, overrideSystemPrompt);
}

/** A one-shot request (compaction summaries): the reply text, or '' on failure. */
export function cliModelCompletion(model: string, prompt: string, signal?: AbortSignal): Promise<string> {
    return model.startsWith(CHATGPT_PREFIX)
        ? chatgptCompletion(codexCommand(), prompt, model.slice(CHATGPT_PREFIX.length), signal)
        : claudeCodeCompletion(claudeCodeCommand(), prompt, model.slice(CLAUDE_CODE_PREFIX.length), signal);
}
