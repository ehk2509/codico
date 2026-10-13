import * as vscode from 'vscode';
import { changeMemory, MEMORY_FILE, memoryPromptSection } from './projectMemory';
import { RememberTool } from './toolParser';
import { readCurrentText } from './workspaceText';

const memoryUri = () => { const root = vscode.workspace.workspaceFolders?.[0]?.uri; return root ? vscode.Uri.joinPath(root, ...MEMORY_FILE.split('/')) : undefined; };
const enabled = () => vscode.workspace.isTrusted && vscode.workspace.getConfiguration('codico').get<boolean>('memory', true);

async function currentMemory(): Promise<string> {
    const uri = memoryUri();
    if (!uri) { return ''; }
    try { return await readCurrentText(uri); } catch { return ''; }
}

/** The notes of earlier sessions, for the system prompt of this turn. Empty in an untrusted folder or when memory is off. */
export async function projectMemorySection(): Promise<string> {
    return enabled() ? memoryPromptSection(await currentMemory()) : '';
}

/**
 * The remember tool. The note goes into the memory file through the ordinary file-write
 * path, so it is shown, approved, undoable and checkpointed like any other change.
 * @param write writes the whole memory file and returns the write tool's result text
 */
export async function rememberTool(tool: RememberTool, write: (content: string) => Promise<string>): Promise<string> {
    if (!enabled()) { return '[remember] Project memory is turned off (the codico.memory setting) or this folder is not trusted. Carry on without saving the note.'; }
    if (!memoryUri()) { return '[remember] No workspace folder is open, so there is nowhere to keep notes.'; }
    const change = changeMemory(await currentMemory(), tool);
    if (!change.ok) { return `[remember] Not saved. ${change.error}`; }
    const written = await write(change.content);
    if (/\] Written successfully/.test(written)) { return `[remember] ${change.said} (${MEMORY_FILE})`; }
    if (/Queued as edit proposal/.test(written)) { return `[remember] ${change.said.replace(/\.$/, '')}, as a proposed change to ${MEMORY_FILE} that the user will review.`; }
    if (/Denied/.test(written)) { return '[remember] Not saved: the user declined. Do not try to save this note again.'; }
    return `[remember] Not saved. ${written}`;
}

/** Read .codico-instructions.md (or its .github equivalents) from the first workspace folder. */
export async function loadRepoInstructions(): Promise<string | null> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) { return null; }
    const parts: string[] = [];
    for (const uri of [vscode.Uri.joinPath(root, '.codico-instructions.md'), vscode.Uri.joinPath(root, '.github', 'codico-instructions.md'), vscode.Uri.joinPath(root, '.github', 'copilot-instructions.md')]) {
        try { parts.push(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).trim()); } catch { /* the file does not exist: try the next */ }
    }
    return parts.length > 0 ? parts.join('\n\n') : null;
}

/** "Codico: Open Project Memory": the file, created with its heading when it does not exist yet. */
export async function openProjectMemory(): Promise<void> {
    const uri = memoryUri();
    if (!uri) { void vscode.window.showWarningMessage('Codico: open a folder first; project memory is a file in the project.'); return; }
    try { await vscode.workspace.fs.stat(uri); } catch {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(changeMemoryStarter()));
    }
    await vscode.window.showTextDocument(uri);
}

function changeMemoryStarter(): string {
    const started = changeMemory('', { note: 'Replace this line with something Codico should know about the project in every session.', topic: 'Conventions' });
    return started.ok ? started.content : '';
}
