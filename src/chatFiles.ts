/** Files the chat panel hands to the extension: dropped onto it, or clicked as links. */
import * as path from 'path';
import * as vscode from 'vscode';
import { isWorkspaceUriAllowed, resolveWorkspaceToolPath } from './workspaceSecurity';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CHARS = 20_000;
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/**
 * Reads a file dropped onto the chat (from the Explorer or the OS) as a context attachment,
 * in the same form as "Attach file". Workspace files excluded by .codicoignore are refused.
 */
export async function readDroppedFile(rawUri: string): Promise<{ label: string; text: string } | { image: string; name: string } | { error: string }> {
    let uri: vscode.Uri;
    try { uri = vscode.Uri.parse(rawUri, true); } catch { return { error: `Cannot attach "${rawUri}": not a file.` }; }
    const name = path.basename(uri.path) || rawUri;
    if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') { return { error: `Cannot attach ${name}: not a local file.` }; }
    if (vscode.workspace.getWorkspaceFolder(uri) && !await isWorkspaceUriAllowed(uri)) {
        return { error: `Cannot attach ${name}: excluded by .codicoignore.` };
    }
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.Directory) { return { error: `Cannot attach ${name}: it is a folder.` }; }
        // An image is attached as an image, like a pasted one
        const imageType = IMAGE_TYPES[path.extname(name).slice(1).toLowerCase()];
        if (imageType) {
            if (stat.size > MAX_IMAGE_BYTES) { return { error: `Cannot attach ${name}: larger than 5 MB.` }; }
            const data = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('base64');
            return { image: `data:${imageType};base64,${data}`, name };
        }
        if (stat.size > MAX_FILE_BYTES) { return { error: `Cannot attach ${name}: larger than 1 MB.` }; }
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.includes(0)) { return { error: `Cannot attach ${name}: it is not a text file.` }; }
        const raw = new TextDecoder().decode(bytes);
        const label = vscode.workspace.getWorkspaceFolder(uri) ? vscode.workspace.asRelativePath(uri) : name;
        const lang = path.extname(name).slice(1);
        const text = `File: ${label}\n\`\`\`${lang}\n${raw.slice(0, MAX_CHARS)}\n\`\`\`${raw.length > MAX_CHARS ? '\n… (truncated)' : ''}`;
        return { label, text };
    } catch (err) {
        return { error: `Cannot attach ${name}: ${err instanceof Error ? err.message : String(err)}` };
    }
}

/** Opens a file path mentioned in the chat (a link in a reply or a tool step), at its line if given. */
export async function openFileLink(rawPath: string, line?: number): Promise<string | undefined> {
    try {
        const { uri } = await resolveWorkspaceToolPath(rawPath);
        await vscode.workspace.fs.stat(uri);
        const at = line && line > 0 ? new vscode.Position(line - 1, 0) : undefined;
        await vscode.window.showTextDocument(uri, { preview: true, selection: at ? new vscode.Range(at, at) : undefined });
        return undefined;
    } catch {
        return `Cannot open ${rawPath}: not found in the workspace.`;
    }
}
