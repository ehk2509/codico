import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as https from 'https';

export function runGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.execFile('git', args, { cwd, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
            if (err) { reject(new Error(stderr || err.message)); }
            else { resolve(stdout); }
        });
    });
}

export function fetchCommitMessage(apiKey: string, model: string, diff: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const systemMsg = 'You are a commit message generator. Given a git diff, produce a concise conventional commit message. Format: type(scope): description — max 72 chars. Output ONLY the commit message, nothing else.';
        const userMsg = `Git diff:\n\n${diff.slice(0, 8000)}`;

        const body = JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemMsg },
                { role: 'user', content: userMsg },
            ],
            max_tokens: 100,
            temperature: 0.3,
        });

        const req = https.request(
            {
                hostname: 'openrouter.ai',
                path: '/api/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'vscode-codico',
                    'X-Title': 'Codico',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve((json?.choices?.[0]?.message?.content ?? '').trim());
                    } catch {
                        resolve('');
                    }
                });
            }
        );

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

export async function generateCommitMessage(context: vscode.ExtensionContext): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('Codico: No workspace folder open.');
        return;
    }

    const apiKey = await context.secrets.get('openRouterApiKey');
    if (!apiKey) {
        vscode.window.showErrorMessage('Codico: No API key set. Run "Codico: Set OpenRouter API Key".');
        return;
    }

    const cwd = folders[0].uri.fsPath;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Codico: Generating commit message…',
            cancellable: false,
        },
        async () => {
            let diff = '';

            try {
                diff = await runGit(['diff', '--staged'], cwd);
            } catch {
                // Not a git repo or no staged changes
            }

            // Fall back to unstaged diff
            if (!diff.trim()) {
                try {
                    diff = await runGit(['diff', 'HEAD'], cwd);
                } catch {
                    // Might be initial commit — try diff of all tracked files
                }
            }

            if (!diff.trim()) {
                vscode.window.showInformationMessage('Codico: No staged or uncommitted changes found.');
                return;
            }

            try {
                const config = vscode.workspace.getConfiguration('codico');
                const model = config.get<string>('model', 'deepseek/deepseek-v4-flash');

                const commitMsg = await fetchCommitMessage(apiKey, model, diff);
                if (!commitMsg) {
                    vscode.window.showWarningMessage('Codico: Could not generate a commit message.');
                    return;
                }

                // Write to Git SCM input box via the built-in Git extension API
                const gitExt = vscode.extensions.getExtension<{ getAPI(v: number): GitAPI }>('vscode.git');
                if (gitExt) {
                    const gitApi = gitExt.isActive ? gitExt.exports.getAPI(1) : (await gitExt.activate()).getAPI(1);
                    const repo = gitApi.repositories[0];
                    if (repo) {
                        repo.inputBox.value = commitMsg;
                        vscode.window.showInformationMessage(`Codico: Commit message written to SCM input.`);
                        return;
                    }
                }

                // Fallback: copy to clipboard
                await vscode.env.clipboard.writeText(commitMsg);
                vscode.window.showInformationMessage(`Codico: Commit message copied to clipboard:\n${commitMsg}`);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Codico: Error generating commit message: ${message}`);
            }
        }
    );
}

// Minimal type stubs for the VS Code Git extension API
interface GitAPI {
    repositories: Repository[];
}
interface Repository {
    inputBox: { value: string };
}
