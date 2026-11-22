/** Run already-authenticated Claude Code and Codex CLI providers outside VS Code. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { streamClaudeCode } from '../claudeCodeClient';
import { streamChatGPT } from '../chatgptClient';
import type { ChatMessage, StreamChunk } from '../openRouterClient';
import type { CliCommand } from '../cliProcess';

function locate(binary:string, envVar:string, packageName:string, script:string):CliCommand {
    const configured=process.env[envVar];
    if (configured) { return {command:configured}; }
    const win=process.platform==='win32';
    for (const folder of (process.env.PATH??'').split(path.delimiter)) {
        if (!folder) { continue; }
        for (const suffix of win?['.exe','.cmd',''] : ['']) {
            const found=path.join(folder,binary+suffix);
            if (!fs.existsSync(found)) { continue; }
            if (suffix!=='.cmd') { return {command:found}; }
            const js=path.join(folder,'node_modules',...packageName.split('/'),...script.split('/'));
            if (fs.existsSync(js)) { return {command:process.execPath,baseArgs:[js]}; }
        }
    }
    return {command:binary};
}

export function streamAuthenticatedCli(
    model:string,history:ChatMessage[],prompt:string,signal:AbortSignal
):AsyncIterable<StreamChunk> {
    if (model.startsWith('claude-code/')) {
        const cli=locate('claude','CODICO_CLAUDE_PATH','@anthropic-ai/claude-code','cli.js');
        return streamClaudeCode(cli,history,model.slice('claude-code/'.length),undefined,signal,'medium',prompt);
    }
    if (model.startsWith('chatgpt/')) {
        const cli=locate('codex','CODICO_CODEX_PATH','@openai/codex','bin/codex.js');
        return streamChatGPT(cli,history,model.slice('chatgpt/'.length),undefined,signal,'medium',prompt);
    }
    throw new Error('Unsupported CLI provider: '+model);
}
