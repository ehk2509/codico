import {
    ToolCall,
    UpdateTodoTool,
} from './toolParser';

export type JsonSchema = Record<string, unknown>;

export interface NativeToolDefinition {
    name: ToolCall['type'];
    description: string;
    inputSchema: JsonSchema;
}

export interface NativeToolCall {
    id?: string;
    name: string;
    arguments: Record<string, unknown>;
}

const noArgs: JsonSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false,
};

const ALL_TOOLS: NativeToolDefinition[] = [
    {
        name: 'read_file',
        description: 'Read a workspace file by relative path. Prefer start_line/end_line around search matches for large files.',
        inputSchema: {
            type: 'object',
            properties: {
                filepath: { type: 'string', description: 'Workspace-relative file path.' },
                start_line: { type: 'integer', minimum: 1, description: 'Optional 1-based first line.' },
                end_line: { type: 'integer', minimum: 1, description: 'Optional 1-based last line. Reads are capped to a safe window.' },
            },
            required: ['filepath'],
            additionalProperties: false,
        },
    },
    {
        name: 'list_directory',
        description: 'List files and directories under a workspace-relative directory.',
        inputSchema: {
            type: 'object',
            properties: { dirpath: { type: 'string', description: 'Workspace-relative directory, or "." for the root.' } },
            required: ['dirpath'],
            additionalProperties: false,
        },
    },
    {
        name: 'write_file',
        description: 'Write the complete contents of a workspace file.',
        inputSchema: {
            type: 'object',
            properties: {
                filepath: { type: 'string', description: 'Workspace-relative file path.' },
                content: { type: 'string', description: 'Complete file contents.' },
            },
            required: ['filepath', 'content'],
            additionalProperties: false,
        },
    },
    {
        name: 'edit_file',
        description: 'Replace one exact string occurrence in a workspace file.',
        inputSchema: {
            type: 'object',
            properties: {
                filepath: { type: 'string' },
                old_str: { type: 'string', description: 'Exact existing text to replace.' },
                new_str: { type: 'string', description: 'Replacement text.' },
            },
            required: ['filepath', 'old_str', 'new_str'],
            additionalProperties: false,
        },
    },
    {
        name: 'run_terminal',
        description: 'Run a shell command in the workspace.',
        inputSchema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
            additionalProperties: false,
        },
    },
    {
        name: 'search_files',
        description: 'Search text or a regular expression across workspace files.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string' },
                glob: { type: 'string', description: 'Optional include glob such as **/*.ts.' },
                regex: { type: 'boolean' },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
    },
    {
        name: 'find_files',
        description: 'Find files by name or glob under an optional directory.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string' },
                dirpath: { type: 'string' },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
    },
    {
        name: 'get_diagnostics',
        description: 'Read VS Code diagnostics for one file or the workspace.',
        inputSchema: {
            type: 'object',
            properties: { filepath: { type: 'string' } },
            additionalProperties: false,
        },
    },
    {
        name: 'fetch_url',
        description: 'Fetch readable text from a public HTTP or HTTPS URL.',
        inputSchema: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
            additionalProperties: false,
        },
    },
    {
        name: 'browser_navigate',
        description: 'Navigate the controlled browser to a URL.',
        inputSchema: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
            additionalProperties: false,
        },
    },
    {
        name: 'browser_click',
        description: 'Click a browser element by CSS selector or visible text.',
        inputSchema: {
            type: 'object',
            properties: { selector: { type: 'string' } },
            required: ['selector'],
            additionalProperties: false,
        },
    },
    {
        name: 'browser_type',
        description: 'Type text into a browser element.',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string' },
                text: { type: 'string' },
                submit: { type: 'boolean' },
            },
            required: ['selector', 'text'],
            additionalProperties: false,
        },
    },
    {
        name: 'browser_get_text',
        description: 'Read text from the current browser page.',
        inputSchema: {
            type: 'object',
            properties: { selector: { type: 'string' } },
            additionalProperties: false,
        },
    },
    { name: 'browser_screenshot', description: 'Capture the current browser page.', inputSchema: noArgs },
    { name: 'browser_close', description: 'Close the controlled browser.', inputSchema: noArgs },
    {
        name: 'mcp_call',
        description: 'Call a connected MCP server tool.',
        inputSchema: {
            type: 'object',
            properties: {
                server: { type: 'string' },
                tool: { type: 'string' },
                args: { type: 'object', additionalProperties: true },
            },
            required: ['server', 'tool'],
            additionalProperties: false,
        },
    },
    {
        name: 'lsp_symbol',
        description: 'Resolve a workspace symbol using VS Code language services.',
        inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
        },
    },
    {
        name: 'debug_get_variables',
        description: 'Read variables from an active VS Code debug frame.',
        inputSchema: {
            type: 'object',
            properties: { frame_id: { type: 'number' } },
            additionalProperties: false,
        },
    },
    { name: 'debug_get_callstack', description: 'Read the active debug call stack.', inputSchema: noArgs },
    { name: 'debug_list_breakpoints', description: 'List VS Code breakpoints.', inputSchema: noArgs },
    {
        name: 'update_todo',
        description: 'Update the visible task checklist for a multi-step job.',
        inputSchema: {
            type: 'object',
            properties: {
                items: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            status: { type: 'string', enum: ['pending', 'active', 'done', 'failed'] },
                            text: { type: 'string' },
                        },
                        required: ['status', 'text'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['items'],
            additionalProperties: false,
        },
    },
];

const READ_ONLY = new Set<ToolCall['type']>([
    'read_file',
    'list_directory',
    'search_files',
    'find_files',
    'get_diagnostics',
    'fetch_url',
    'lsp_symbol',
]);

export function getNativeToolDefinitions(readOnly = false): NativeToolDefinition[] {
    return ALL_TOOLS.filter(tool => !readOnly || READ_ONLY.has(tool.name));
}

/**
 * Phase policies are advisory. Fixed exploration/read counts must not remove
 * capabilities that may be required for correctness.
 */
const ACTION_PRIORITY: ToolCall['type'][] = [
    'edit_file',
    'write_file',
    'run_terminal',
    'get_diagnostics',
    'read_file',
    'search_files',
    'find_files',
    'list_directory',
];

const ACTION_DISCOVERY = new Set<ToolCall['type']>([
    'read_file',
    'search_files',
    'find_files',
    'list_directory',
    'fetch_url',
    'lsp_symbol',
    'browser_get_text',
]);

/**
 * Action phase keeps every capability but makes the native-tool surface reflect
 * the phase: mutation/verification tools come first, while discovery tools are
 * explicitly described as a narrow escape hatch for one missing fact.
 */
export function restrictNativeToolsForAction(
    tools: NativeToolDefinition[]
): NativeToolDefinition[] {
    const rank = new Map(ACTION_PRIORITY.map((name, index) => [name, index]));

    return tools
        .map(tool => {
            if (ACTION_DISCOVERY.has(tool.name)) {
                return {
                    ...tool,
                    description: `Action phase escape hatch: use ${tool.name} only when one concrete missing fact prevents a safe edit. Do not repeat evidence already inspected; close that fact, then edit immediately. ${tool.description}`,
                };
            }

            if (tool.name === 'edit_file') {
                return {
                    ...tool,
                    description: 'Preferred action-phase tool. Make the smallest exact code change supported by the evidence already gathered.',
                };
            }

            if (tool.name === 'write_file') {
                return {
                    ...tool,
                    description: 'Action-phase mutation tool for complete-file rewrites when a precise edit_file replacement is not appropriate.',
                };
            }

            if (tool.name === 'run_terminal') {
                return {
                    ...tool,
                    description: 'Run the narrowest test/build/diagnostics command after a code change. Before editing, use terminal inspection only for one concrete missing fact.',
                };
            }

            return tool;
        })
        .sort((a, b) => (rank.get(a.name) ?? 100) - (rank.get(b.name) ?? 100));
}

export function restrictNativeToolsForVerification(
    tools: NativeToolDefinition[],
    filepath?: string,
    readNeeded = true,
): NativeToolDefinition[] {
    const priority: ToolCall['type'][] = readNeeded
        ? ['read_file', 'edit_file', 'run_terminal', 'get_diagnostics', 'search_files', 'find_files', 'list_directory']
        : ['run_terminal', 'edit_file', 'read_file', 'get_diagnostics', 'search_files', 'find_files', 'list_directory'];
    const rank = new Map(priority.map((name, index) => [name, index]));

    return tools
        .map(tool => {
            if (tool.name === 'read_file') {
                return {
                    ...tool,
                    description: readNeeded
                        ? filepath
                            ? `Verification priority: re-read edited file ${filepath} and reconcile its changed control flow with normal success/completion/terminal/cancellation paths. Dependency reads remain available when needed.`
                            : 'Verification priority: re-read the edited control flow and reconcile its invariants.'
                        : 'Verification discovery: read only a concrete unresolved range/dependency. The edited control-flow audit is already complete.',
                };
            }

            if (tool.name === 'edit_file') {
                return {
                    ...tool,
                    description: filepath
                        ? `Verification mutation: revise ${filepath} first if its acceptance or preservation invariant is wrong. Avoid mutating sibling files until this edit is verified.`
                        : 'Verification mutation: revise the current edited component before broadening.',
                };
            }

            if (tool.name === 'write_file') {
                return {
                    ...tool,
                    description: 'Verification mutation for a necessary complete-file rewrite. Keep focus on the current edited component until verified.',
                };
            }

            if (tool.name === 'run_terminal') {
                return {
                    ...tool,
                    description: readNeeded
                        ? 'Verification command. For lifecycle/state edits, first audit the edited control flow; then run the narrowest behavior-level test. Static builds alone do not prove terminal semantics.'
                        : 'Preferred verification tool. Run the narrowest behavior-level test for lifecycle/state edits; diagnostics/build/lint are static evidence only.',
                };
            }

            if (tool.name === 'get_diagnostics') {
                return {
                    ...tool,
                    description: 'Static verification only. Useful for compile/type errors, but it does not prove runtime lifecycle or terminal-state behavior.',
                };
            }

            return tool;
        })
        .sort((a, b) => (rank.get(a.name) ?? 100) - (rank.get(b.name) ?? 100));
}

export function nativeToolsForAgentPhase(
    tools: NativeToolDefinition[],
    explorationLocked: boolean,
    verificationPending: boolean,
    verificationFile?: string,
    verificationReadAllowed = true,
): NativeToolDefinition[] {
    if (verificationPending) {
        return restrictNativeToolsForVerification(tools, verificationFile, verificationReadAllowed);
    }

    if (explorationLocked) { return restrictNativeToolsForAction(tools); }
    return tools;
}

function positiveIntArg(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key];
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringArg(args: Record<string, unknown>, key: string, allowEmpty = false): string | undefined {
    const value = args[key];
    if (typeof value !== 'string') { return undefined; }
    if (!allowEmpty && value.length === 0) { return undefined; }
    return value;
}

export function nativeToolCallToToolCall(call: NativeToolCall): ToolCall | null {
    const args = call.arguments ?? {};
    switch (call.name) {
        case 'read_file': {
            const filepath = stringArg(args, 'filepath');
            return filepath ? {
                type: 'read_file',
                filepath,
                startLine: positiveIntArg(args, 'start_line'),
                endLine: positiveIntArg(args, 'end_line'),
            } : null;
        }
        case 'list_directory': {
            const dirpath = stringArg(args, 'dirpath') ?? '.';
            return { type: 'list_directory', dirpath };
        }
        case 'write_file': {
            const filepath = stringArg(args, 'filepath');
            const content = stringArg(args, 'content', true);
            return filepath !== undefined && content !== undefined ? { type: 'write_file', filepath, content } : null;
        }
        case 'edit_file': {
            const filepath = stringArg(args, 'filepath');
            const oldStr = stringArg(args, 'old_str', true);
            const newStr = stringArg(args, 'new_str', true);
            return filepath !== undefined && oldStr !== undefined && newStr !== undefined
                ? { type: 'edit_file', filepath, oldStr, newStr }
                : null;
        }
        case 'run_terminal': {
            const command = stringArg(args, 'command');
            return command ? { type: 'run_terminal', command } : null;
        }
        case 'search_files': {
            const pattern = stringArg(args, 'pattern');
            if (!pattern) { return null; }
            const glob = stringArg(args, 'glob');
            return { type: 'search_files', pattern, glob, isRegex: args.regex === true };
        }
        case 'find_files': {
            const pattern = stringArg(args, 'pattern');
            if (!pattern) { return null; }
            return { type: 'find_files', pattern, dirpath: stringArg(args, 'dirpath') };
        }
        case 'get_diagnostics':
            return { type: 'get_diagnostics', filepath: stringArg(args, 'filepath') };
        case 'fetch_url': {
            const url = stringArg(args, 'url');
            return url ? { type: 'fetch_url', url } : null;
        }
        case 'browser_navigate': {
            const url = stringArg(args, 'url');
            return url ? { type: 'browser_navigate', url } : null;
        }
        case 'browser_click': {
            const selector = stringArg(args, 'selector');
            return selector ? { type: 'browser_click', selector } : null;
        }
        case 'browser_type': {
            const selector = stringArg(args, 'selector');
            const text = stringArg(args, 'text', true);
            return selector !== undefined && text !== undefined
                ? { type: 'browser_type', selector, text, submit: args.submit === true }
                : null;
        }
        case 'browser_get_text':
            return { type: 'browser_get_text', selector: stringArg(args, 'selector') };
        case 'browser_screenshot':
            return { type: 'browser_screenshot' };
        case 'browser_close':
            return { type: 'browser_close' };
        case 'mcp_call': {
            const server = stringArg(args, 'server');
            const tool = stringArg(args, 'tool');
            const rawArgs = args.args;
            return server && tool
                ? { type: 'mcp_call', server, tool, args: rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {} }
                : null;
        }
        case 'lsp_symbol': {
            const query = stringArg(args, 'query');
            return query ? { type: 'lsp_symbol', query } : null;
        }
        case 'debug_get_variables': {
            const raw = args.frame_id;
            return { type: 'debug_get_variables', frameId: typeof raw === 'number' && Number.isInteger(raw) ? raw : undefined };
        }
        case 'debug_get_callstack':
            return { type: 'debug_get_callstack' };
        case 'debug_list_breakpoints':
            return { type: 'debug_list_breakpoints' };
        case 'update_todo': {
            if (!Array.isArray(args.items)) { return null; }
            const allowed = new Set<UpdateTodoTool['items'][number]['status']>(['pending', 'active', 'done', 'failed']);
            const items: UpdateTodoTool['items'] = [];
            for (const item of args.items) {
                if (!item || typeof item !== 'object') { continue; }
                const status = (item as { status?: unknown }).status;
                const text = (item as { text?: unknown }).text;
                if (typeof status === 'string' && allowed.has(status as UpdateTodoTool['items'][number]['status']) && typeof text === 'string' && text.trim()) {
                    items.push({ status: status as UpdateTodoTool['items'][number]['status'], text: text.trim() });
                }
            }
            return items.length > 0 ? { type: 'update_todo', items } : null;
        }
        default:
            return null;
    }
}

interface OpenAIDeltaToolCall {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
}

export class OpenAIToolCallAccumulator {
    private readonly _calls = new Map<number, { id?: string; name: string; args: string; emitted: boolean }>();

    add(delta: OpenAIDeltaToolCall): void {
        const index = delta.index ?? 0;
        const current = this._calls.get(index) ?? { name: '', args: '', emitted: false };
        if (delta.id) { current.id = delta.id; }
        if (delta.function?.name) { current.name += delta.function.name; }
        if (delta.function?.arguments) { current.args += delta.function.arguments; }
        this._calls.set(index, current);
    }

    get hasPending(): boolean {
        return [...this._calls.values()].some(call => !call.emitted && Boolean(call.name));
    }

    pendingNames(): string[] {
        return [...this._calls.values()].filter(call => !call.emitted && call.name).map(call => call.name);
    }

    flushReady(): NativeToolCall[] {
        const ready: NativeToolCall[] = [];
        for (const [, call] of [...this._calls.entries()].sort((a, b) => a[0] - b[0])) {
            if (call.emitted || !call.name) { continue; }
            try {
                const parsed = call.args.trim() ? JSON.parse(call.args) : {};
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { continue; }
                call.emitted = true;
                ready.push({ id: call.id, name: call.name, arguments: parsed as Record<string, unknown> });
            } catch {
                // Arguments can still be partial while streaming; leave it pending.
            }
        }
        return ready;
    }
}

export const NATIVE_TOOL_PROMPT = `
Provider-native function/tool calling is enabled for this request.
Use native tool calls instead of writing fenced tool blocks whenever you need a tool.
The fenced formats in the base prompt are compatibility fallback documentation only.
Do not describe a tool call without issuing it. Continue autonomously after each tool result.
`;
