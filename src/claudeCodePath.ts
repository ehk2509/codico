import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ClaudeCodeCommand } from './claudeCodeClient';

/**
 * Where the `claude` command is: the "codico.claudeCodePath" setting, else the PATH, else the
 * binary bundled with the Claude Code VS Code extension (installing that extension is enough).
 */
export function claudeCodeCommand(): ClaudeCodeCommand {
    const configured = vscode.workspace.getConfiguration('codico').get<string>('claudeCodePath', '').trim();
    if (configured) { return { command: configured }; }
    const names = process.platform === 'win32' ? ['claude.exe'] : ['claude'];
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        for (const name of names) {
            const candidate = path.join(dir, name);
            if (dir && fs.existsSync(candidate)) { return { command: candidate }; }
        }
    }
    const extension = vscode.extensions.getExtension('anthropic.claude-code');
    const bundled = extension ? path.join(extension.extensionPath, 'resources', 'native-binary', names[0]) : '';
    // Not found anywhere: starting "claude" fails with a message saying how to install or configure it
    return { command: bundled && fs.existsSync(bundled) ? bundled : 'claude' };
}
