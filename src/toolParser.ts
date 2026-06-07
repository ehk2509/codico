export interface WriteFileTool {
    type: 'write_file';
    filepath: string;
    content: string;
}

export interface ReadFileTool {
    type: 'read_file';
    filepath: string;
}

export interface ListDirectoryTool {
    type: 'list_directory';
    dirpath: string;
}

export interface RunTerminalTool {
    type: 'run_terminal';
    command: string;
}

export interface SearchFilesTool {
    type: 'search_files';
    pattern: string;
    glob?: string;
    isRegex: boolean;
}

export interface EditFileTool {
    type: 'edit_file';
    filepath: string;
    oldStr: string;
    newStr: string;
}

export interface GetDiagnosticsTool {
    type: 'get_diagnostics';
    filepath?: string;
}

export interface FetchUrlTool {
    type: 'fetch_url';
    url: string;
}

export interface BrowserNavigateTool {
    type: 'browser_navigate';
    url: string;
}

export interface BrowserClickTool {
    type: 'browser_click';
    selector: string;
}

export interface BrowserTypeTool {
    type: 'browser_type';
    selector: string;
    text: string;
    submit?: boolean;
}

export interface BrowserGetTextTool {
    type: 'browser_get_text';
    selector?: string;
}

export interface BrowserScreenshotTool {
    type: 'browser_screenshot';
}

export interface BrowserCloseTool {
    type: 'browser_close';
}

export interface FindFilesTool {
    type: 'find_files';
    pattern: string;   // glob or filename fragment
    dirpath?: string;  // root dir, defaults to workspace root
}

export interface McpCallTool {
    type: 'mcp_call';
    server: string;
    tool: string;
    args: Record<string, unknown>;
}

export interface LspSymbolTool {
    type: 'lsp_symbol';
    /** Symbol name or prefix to search for across the workspace. */
    query: string;
}

export interface DebugGetVariablesTool {
    type: 'debug_get_variables';
    /** Optional frame index (0 = top of call stack). Defaults to 0. */
    frameId?: number;
}

export interface DebugGetCallstackTool {
    type: 'debug_get_callstack';
}

export interface DebugListBreakpointsTool {
    type: 'debug_list_breakpoints';
}

export interface UpdateTodoTool {
    type: 'update_todo';
    items: Array<{ status: 'pending' | 'active' | 'done' | 'failed'; text: string }>;
}

export type ToolCall =
    | WriteFileTool
    | ReadFileTool
    | ListDirectoryTool
    | RunTerminalTool
    | SearchFilesTool
    | FindFilesTool
    | EditFileTool
    | GetDiagnosticsTool
    | FetchUrlTool
    | BrowserNavigateTool
    | BrowserClickTool
    | BrowserTypeTool
    | BrowserGetTextTool
    | BrowserScreenshotTool
    | BrowserCloseTool
    | McpCallTool
    | LspSymbolTool
    | DebugGetVariablesTool
    | DebugGetCallstackTool
    | DebugListBreakpointsTool
    | UpdateTodoTool;

/**
 * Parses all tool call fenced blocks from the model's raw output.
 */
export function parseToolCalls(rawContent: string): ToolCall[] {
    const tools: ToolCall[] = [];
    const blockRegex = /```(write_file|read_file|list_directory|run_terminal|search_files|find_files|edit_file|get_diagnostics|fetch_url|browser_navigate|browser_click|browser_type|browser_get_text|browser_screenshot|browser_close|mcp_call|lsp_symbol|debug_get_variables|debug_get_callstack|debug_list_breakpoints|update_todo)\r?\n([\s\S]*?)\n```/g;
    let match: RegExpExecArray | null;

    while ((match = blockRegex.exec(rawContent)) !== null) {
        const toolType = match[1];
        const body = match[2];

        switch (toolType) {
            case 'write_file': {
                const tool = parseWriteFileBlock(body);
                if (tool) { tools.push(tool); }
                break;
            }
            case 'read_file': {
                const fp = extractField(body, 'filepath');
                if (fp) { tools.push({ type: 'read_file', filepath: fp }); }
                break;
            }
            case 'list_directory': {
                const dp = extractField(body, 'dirpath') ?? '.';
                tools.push({ type: 'list_directory', dirpath: dp });
                break;
            }
            case 'run_terminal': {
                const cmd = extractMultilineField(body, 'command');
                if (cmd) { tools.push({ type: 'run_terminal', command: cmd }); }
                break;
            }
            case 'search_files': {
                const pattern = extractField(body, 'pattern');
                if (pattern) {
                    const glob = extractField(body, 'glob');
                    const regexRaw = extractField(body, 'regex');
                    const isRegex = regexRaw === 'true';
                    tools.push({ type: 'search_files', pattern, glob, isRegex });
                }
                break;
            }
            case 'find_files': {
                const pattern = extractField(body, 'pattern');
                if (pattern) {
                    const dirpath = extractField(body, 'dirpath');
                    tools.push({ type: 'find_files', pattern, dirpath });
                }
                break;
            }
            case 'edit_file': {
                const tool = parseEditFileBlock(body);
                if (tool) { tools.push(tool); }
                break;
            }
            case 'get_diagnostics': {
                const fp = extractField(body, 'filepath');
                tools.push({ type: 'get_diagnostics', filepath: fp });
                break;
            }
            case 'fetch_url': {
                const url = extractField(body, 'url');
                if (url) { tools.push({ type: 'fetch_url', url }); }
                break;
            }
            case 'browser_navigate': {
                const url = extractField(body, 'url');
                if (url) { tools.push({ type: 'browser_navigate', url }); }
                break;
            }
            case 'browser_click': {
                const selector = extractField(body, 'selector');
                if (selector) { tools.push({ type: 'browser_click', selector }); }
                break;
            }
            case 'browser_type': {
                const selector = extractField(body, 'selector');
                const text = extractFieldAllowEmpty(body, 'text');
                if (selector && text != null) {
                    const submitRaw = extractField(body, 'submit');
                    tools.push({ type: 'browser_type', selector, text, submit: submitRaw === 'true' });
                }
                break;
            }
            case 'browser_get_text': {
                const selector = extractField(body, 'selector');
                tools.push({ type: 'browser_get_text', selector });
                break;
            }
            case 'browser_screenshot': {
                tools.push({ type: 'browser_screenshot' });
                break;
            }
            case 'browser_close': {
                tools.push({ type: 'browser_close' });
                break;
            }
            case 'mcp_call': {
                const tool = parseMcpCallBlock(body);
                if (tool) { tools.push(tool); }
                break;
            }
            case 'lsp_symbol': {
                const query = extractField(body, 'query');
                if (query) { tools.push({ type: 'lsp_symbol', query }); }
                break;
            }
            case 'debug_get_variables': {
                const frameIdRaw = extractField(body, 'frame_id');
                const frameId = frameIdRaw ? parseInt(frameIdRaw, 10) : undefined;
                tools.push({ type: 'debug_get_variables', frameId: Number.isNaN(frameId) ? undefined : frameId });
                break;
            }
            case 'debug_get_callstack': {
                tools.push({ type: 'debug_get_callstack' });
                break;
            }
            case 'debug_list_breakpoints': {
                tools.push({ type: 'debug_list_breakpoints' });
                break;
            }
            case 'update_todo': {
                const items: UpdateTodoTool['items'] = [];
                for (const line of body.split('\n')) {
                    const trimmed = line.trim();
                    const doneMatch = /^-\s+\[x\]\s+(.+)/i.exec(trimmed);
                    const activeMatch = /^-\s+\[~\]\s+(.+)/.exec(trimmed);
                    const failMatch = /^-\s+\[!\]\s+(.+)/.exec(trimmed);
                    const pendingMatch = /^-\s+\[\s\]\s+(.+)/.exec(trimmed);
                    if (doneMatch)    { items.push({ status: 'done',    text: doneMatch[1].trim() }); }
                    else if (activeMatch) { items.push({ status: 'active', text: activeMatch[1].trim() }); }
                    else if (failMatch)   { items.push({ status: 'failed', text: failMatch[1].trim() }); }
                    else if (pendingMatch){ items.push({ status: 'pending',text: pendingMatch[1].trim() }); }
                }
                if (items.length > 0) { tools.push({ type: 'update_todo', items }); }
                break;
            }
        }
    }

    return tools;
}

function extractField(body: string, key: string): string | undefined {
    for (const line of body.split(/\r?\n/)) {
        if (line.startsWith(`${key}:`)) {
            const val = line.slice(key.length + 1).trim();
            return val || undefined;
        }
    }
    return undefined;
}

function extractFieldAllowEmpty(body: string, key: string): string | undefined {
    for (const line of body.split(/\r?\n/)) {
        if (line.startsWith(`${key}:`)) {
            return line.slice(key.length + 1).trim();
        }
    }
    return undefined;
}

// Matches a "fieldname: value" header line — used to stop multiline field collection.
const FIELD_HEADER_RE = /^[a-z_]+:/;

function extractMultilineField(body: string, key: string): string | undefined {
    const lines = body.split(/\r?\n/);
    let inField = false;
    const result: string[] = [];

    for (const line of lines) {
        if (!inField) {
            if (line.startsWith(`${key}:`)) {
                inField = true;
                const inline = line.slice(key.length + 1).trim();
                if (inline) { result.push(inline); }
            }
        } else {
            // Stop when we hit another field header (but not the starting key itself)
            if (FIELD_HEADER_RE.test(line) && !line.startsWith(`${key}:`)) { break; }
            result.push(line);
        }
    }

    while (result.length > 0 && result[result.length - 1].trim() === '') {
        result.pop();
    }
    return result.length > 0 ? result.join('\n') : undefined;
}

function parseWriteFileBlock(body: string): WriteFileTool | null {
    const lines = body.split(/\r?\n/);
    let filepath = '';
    const contentLines: string[] = [];
    let inContent = false;

    for (const line of lines) {
        if (!inContent) {
            if (line.startsWith('filepath:')) {
                filepath = line.slice('filepath:'.length).trim();
            } else if (line.startsWith('content:')) {
                inContent = true;
                const inline = line.slice('content:'.length).trim();
                if (inline) { contentLines.push(inline); }
            }
        } else {
            contentLines.push(line);
        }
    }

    if (!filepath || !inContent) { return null; }

    // Strip only extra trailing blank lines — preserve a single trailing newline.
    while (contentLines.length > 1 && contentLines[contentLines.length - 1].trim() === '' && contentLines[contentLines.length - 2].trim() === '') {
        contentLines.pop();
    }

    return { type: 'write_file', filepath, content: contentLines.join('\n') };
}

function parseEditFileBlock(body: string): EditFileTool | null {
    const lines = body.split(/\r?\n/);
    let filepath = '';
    const oldStrLines: string[] = [];
    const newStrLines: string[] = [];
    type State = 'header' | 'old' | 'new';
    let state: State = 'header';

    for (const line of lines) {
        if (state === 'header') {
            if (line.startsWith('filepath:')) {
                filepath = line.slice('filepath:'.length).trim();
            } else if (line.startsWith('old_str:')) {
                state = 'old';
                const inline = line.slice('old_str:'.length).trim();
                if (inline) { oldStrLines.push(inline); }
            }
        } else if (state === 'old') {
            // Only treat a line as the new_str: marker when it is exactly the field header
            // (i.e. nothing after "new_str:" or just whitespace). A content line like
            // "new_str: foo" that happens to start with "new_str:" would be ambiguous,
            // but requiring the value to be empty distinguishes field headers from content.
            if (line === 'new_str:' || line === 'new_str: ') {
                state = 'new';
            } else if (/^new_str:\s/.test(line)) {
                // "new_str: <inline value>" — treat as the marker with inline content
                state = 'new';
                const inline = line.slice('new_str:'.length).trim();
                if (inline) { newStrLines.push(inline); }
            } else {
                oldStrLines.push(line);
            }
        } else {
            newStrLines.push(line);
        }
    }

    // Strip only extra trailing blank lines — preserve a single trailing newline.
    while (oldStrLines.length > 1 && oldStrLines[oldStrLines.length - 1].trim() === '' && oldStrLines[oldStrLines.length - 2].trim() === '') { oldStrLines.pop(); }
    while (newStrLines.length > 1 && newStrLines[newStrLines.length - 1].trim() === '' && newStrLines[newStrLines.length - 2].trim() === '') { newStrLines.pop(); }

    if (!filepath || oldStrLines.length === 0) { return null; }

    return {
        type: 'edit_file',
        filepath,
        oldStr: oldStrLines.join('\n'),
        newStr: newStrLines.join('\n'),
    };
}

/**
 * Parse an mcp_call block body:
 *   server: <name>
 *   tool: <tool-name>
 *   param1: value1
 *   param2: ["json","array"]
 */
function parseMcpCallBlock(body: string): McpCallTool | null {
    let server = '';
    let tool = '';
    const args: Record<string, unknown> = {};

    const lines = body.split('\n');
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) { i++; continue; }
        const key = line.slice(0, colonIdx).trim();
        const raw = line.slice(colonIdx + 1).trim();
        if (!key) { i++; continue; }

        if (key === 'server') { server = raw; i++; continue; }
        if (key === 'tool')   { tool   = raw; i++; continue; }

        if (!raw) { i++; continue; }

        const firstChar = raw[0];
        // Multi-line JSON: accumulate continuation lines until the JSON parses
        if (firstChar === '[' || firstChar === '{') {
            let accumulated = raw;
            let j = i + 1;
            let parsed: unknown | undefined;
            // Try single-line first
            try { parsed = JSON.parse(accumulated); } catch { /* keep accumulating */ }
            while (parsed === undefined && j < lines.length) {
                accumulated += '\n' + lines[j];
                j++;
                try { parsed = JSON.parse(accumulated); } catch { /* continue */ }
            }
            if (parsed !== undefined) {
                args[key] = parsed;
                i = j;
            } else {
                args[key] = raw; // give up, store raw
                i++;
            }
            continue;
        }

        // Scalar values
        try {
            if (firstChar === '"') {
                args[key] = JSON.parse(raw);
            } else if (raw === 'true')  { args[key] = true; }
            else if (raw === 'false') { args[key] = false; }
            else if (raw !== '' && !isNaN(Number(raw))) { args[key] = Number(raw); }
            else { args[key] = raw; }
        } catch {
            args[key] = raw;
        }
        i++;
    }

    if (!server || !tool) { return null; }
    return { type: 'mcp_call', server, tool, args };
}
