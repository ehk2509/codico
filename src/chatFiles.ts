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

const BEFORE_SCHEME = 'codico-before';
const beforeContents = new Map<string, string>();

/** Serves the "before" side of the change diffs opened from the chat. */
export function registerChangeDiffProvider(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, {
        provideTextDocumentContent: uri => beforeContents.get(uri.query) ?? '',
    }));
}

/** Opens VS Code's diff editor: the file before Codico's change against the file now. */
export async function openChangeDiff(file: vscode.Uri, before: Uint8Array | null): Promise<void> {
    const key = String(beforeContents.size + 1);
    beforeContents.set(key, before ? new TextDecoder().decode(before) : '');
    const name = path.basename(file.path);
    const beforeUri = vscode.Uri.from({ scheme: BEFORE_SCHEME, path: `/${name}`, query: key });
    await vscode.commands.executeCommand('vscode.diff', beforeUri, file, `${name} (before Codico \u2194 now)`, { preview: true });
}

/** A code block's "Insert": puts the code at the cursor of the editor in use, replacing the selection. */
export async function insertCodeAtCursor(code: string): Promise<string | undefined> {
    // The chat panel has the focus, so the "active" editor may be unset: fall back to a visible one
    const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors.find(candidate => candidate.document.uri.scheme !== 'output');
    if (!editor) { return 'Open a file in the editor first: there is nowhere to insert the code.'; }
    const done = await editor.edit(edit => { editor.selections.forEach(selection => edit.replace(selection, code)); });
    if (!done) { return `The code could not be inserted into ${vscode.workspace.asRelativePath(editor.document.uri)} (the file may be read-only).`; }
    await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
    return undefined;
}

/** A code block's "New file": opens the code in an untitled editor, in its language when VS Code knows it. */
export async function openCodeInNewFile(code: string, language: string): Promise<void> {
    const known = await vscode.languages.getLanguages();
    const aliases: Record<string, string> = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', yml: 'yaml', md: 'markdown', 'c++': 'cpp', 'c#': 'csharp', rs: 'rust', rb: 'ruby', kt: 'kotlin' };
    const id = aliases[language.toLowerCase()] ?? language.toLowerCase();
    const document = await vscode.workspace.openTextDocument({ content: code, language: known.includes(id) ? id : undefined });
    await vscode.window.showTextDocument(document);
}

/** A thread's "Export": asks whether to save the Markdown to a file or copy it. */
export async function exportMarkdown(markdown: string, fileName: string): Promise<void> {
    const save = 'Save as a Markdown file';
    const copy = 'Copy to the clipboard';
    const choice = await vscode.window.showQuickPick([save, copy], { title: 'Export conversation', placeHolder: fileName });
    if (choice === copy) {
        await vscode.env.clipboard.writeText(markdown);
        void vscode.window.showInformationMessage('Codico: the conversation was copied as Markdown.');
    } else if (choice === save) {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        const target = await vscode.window.showSaveDialog({ defaultUri: folder ? vscode.Uri.joinPath(folder, fileName) : vscode.Uri.file(fileName), filters: { Markdown: ['md'] } });
        if (!target) { return; }
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(markdown));
        await vscode.window.showTextDocument(target);
    }
}

