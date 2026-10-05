import * as vscode from 'vscode';
import * as fs from 'fs';
import * as nodeCrypto from 'crypto';

function getNonce(): string {
    return nodeCrypto.randomBytes(24).toString('base64url');
}

/**
 * Loads, validates and renders packaged webview assets.
 * This keeps filesystem/template/CSP concerns out of the agent orchestration class.
 */
export class WebviewAssets {
    private _validModelIds: Set<string> | null = null;
    private _cachedModelsJson: string | null = null;
    private _cachedHtml: string | null = null;

    constructor(private readonly extensionUri: vscode.Uri) {}

    public async preload(): Promise<void> {
        const media = this.extensionUri.fsPath + '/media';
        try {
            this._cachedModelsJson = await fs.promises.readFile(media + '/models.json', 'utf8');
            const groups = JSON.parse(this._cachedModelsJson) as Array<{
                models?: Array<{ id?: string }>;
            }>;
            this._validModelIds = new Set(
                groups
                    .flatMap(group => group.models ?? [])
                    .map(model => model.id)
                    .filter((id): id is string => Boolean(id))
            );
        } catch {
            // Missing/invalid models.json should not brick the extension.
            this._validModelIds = null;
        }

        try {
            this._cachedHtml = await fs.promises.readFile(media + '/chat.html', 'utf8');
        } catch {
            this._cachedHtml = null;
        }
    }

    public isValidModelId(id: string): boolean {
        if (!this._validModelIds || this._validModelIds.size === 0) { return true; }
        return this._validModelIds.has(id);
    }

    public buildHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const media = this.extensionUri.fsPath + '/media';
        const rawHtml = this._cachedHtml ?? fs.readFileSync(media + '/chat.html', 'utf8');
        const rawModelsJson = this._cachedModelsJson ?? fs.readFileSync(media + '/models.json', 'utf8');

        let html = rawHtml.split('{{NONCE}}').join(nonce);
        const safeModelsJson = rawModelsJson.replace(/<\/script>/gi, '<\\/script>');
        html = html.replace('{{MODELS_JSON}}', () => safeModelsJson);
        html = html.replace('{{CSP_SOURCE}}', webview.cspSource);

        const chatCssUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css')
        ).toString();
        html = html.replace('{{CHAT_CSS_URI}}', chatCssUri);

        const markdownUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'markdown.js')
        ).toString();
        html = html.replace('{{MARKDOWN_JS_URI}}', markdownUri);

        const streamNoticesUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'streamNotices.js')
        ).toString();
        html = html.replace('{{STREAM_NOTICES_JS_URI}}', streamNoticesUri);
        return html;
    }
}
