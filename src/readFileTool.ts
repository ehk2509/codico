import * as vscode from 'vscode';
import { toolRelativePath } from './toolRoot';
import { ChatMessage } from './openRouterClient';
import { ReadFileTool } from './toolParser';
import { fileOutlineSymbols } from './fileOutline';
import { formatOutline, numberLines, OUTLINE_HEAD_LINES, OUTLINE_MIN_LINES, sliceFileByLines } from './fileReadWindow';
import { alreadyDeclined, knownLines, notRepeatedText, partialBody, splitWindow } from './readDedup';
import { resolveWorkspaceToolPath } from './workspaceSecurity';
import { readCurrentText } from './workspaceText';

type Report = (outcome: { label: string; success: boolean; error?: string }) => void;

/** Every way the model may have written this file's path. */
function pathNames(filepath: string, uri: vscode.Uri): Set<string> {
    const clean = (value: string) => value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    return new Set([clean(filepath), clean(toolRelativePath(uri)), clean(uri.fsPath)]);
}

/**
 * The read_file tool.
 * @param seen the conversation as the model will see it, to leave out lines it already has;
 *             null for a reader with a conversation of its own (a subagent)
 */
export async function readFileTool(tool: ReadFileTool, seen: readonly ChatMessage[] | null, report: Report): Promise<string> {
    try {
        const fileUri = (await resolveWorkspaceToolPath(tool.filepath)).uri;
        // Unsaved editor changes included: that is the file the user sees
        const content = await readCurrentText(fileUri);
        // A large file read without a range: an outline and its first lines, not page after page
        const unranged = tool.startLine === undefined && tool.endLine === undefined;
        const outline = unranged && content.split('\n').length > OUTLINE_MIN_LINES ? await fileOutlineSymbols(fileUri) : [];
        const window = outline.length >= 3 ? sliceFileByLines(content, 1, OUTLINE_HEAD_LINES) : sliceFileByLines(content, tool.startLine, tool.endLine);
        const label = window.truncated
            ? `${tool.filepath} lines ${window.startLine}–${window.endLine} of ${window.totalLines}`
            : tool.filepath;
        const continuation = window.endLine < window.totalLines
            ? `\n… (bounded read; use start_line: ${window.endLine + 1} and end_line to continue, or search_files to target a symbol)\n`
            : '';
        const outlineText = outline.length >= 3 ? `Outline of this ${window.totalLines}-line file (line ranges):\n${formatOutline(outline)}\n\nRead only the range you need with start_line/end_line.\n\n` : '';

        // Lines the model already has, unchanged, are not sent again
        let body = numberLines(window.text, window.startLine);
        let note = '';
        if (seen && window.endLine >= window.startLine) {
            const names = pathNames(tool.filepath, fileUri);
            const fileLines = content.replace(/\r\n/g, '\n').split('\n');
            const parts = splitWindow(window.startLine, window.endLine, knownLines(seen, names, fileLines));
            const asked = !alreadyDeclined(seen, names, window.startLine, window.endLine);
            if (asked && parts.length === 1 && parts[0].known) {
                report({ label: `${label} — already read, unchanged`, success: true });
                return notRepeatedText(tool.filepath, window.startLine, window.endLine, window.totalLines);
            }
            if (asked && parts.some(part => part.known)) {
                const partial = partialBody(parts, fileLines);
                body = partial.text;
                note = `; lines ${partial.omitted} are left out because they are already in this conversation, unchanged`;
            }
        }
        report({ label, success: true });
        // Numbered like `cat -n`: the numbers are what start_line/end_line and the next search need
        return `[read_file: ${tool.filepath} lines ${window.startLine}–${window.endLine} of ${window.totalLines}; each line is shown as <number><tab><text>, and the number is not part of the file${note}]\n${outlineText}\`\`\`\n${body}\n\`\`\`${continuation}`;
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        report({ label: tool.filepath, success: false, error: message });
        return `[read_file: ${tool.filepath}] ERROR: ${message}`;
    }
}
