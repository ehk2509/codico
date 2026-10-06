import type { ToolCall } from './toolParser';

function clip(value: string, max = 160): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length <= max ? normalized : normalized.slice(0, max - 1) + '…';
}

/** Safe, compact benchmark label: enough to diagnose routing without storing bodies/secrets. */
export function evaluationToolTarget(tool: ToolCall): string {
    switch (tool.type) {
        case 'read_file': {
            const range = tool.startLine != null || tool.endLine != null
                ? `:${tool.startLine ?? 1}-${tool.endLine ?? '*'}`
                : '';
            return `${tool.filepath}${range}`;
        }
        case 'write_file':
        case 'edit_file':
            return tool.filepath;
        case 'list_directory':
            return tool.dirpath;
        case 'run_terminal':
            return clip(tool.command);
        case 'search_files':
            return clip(`${tool.pattern}${tool.glob ? ` @ ${tool.glob}` : ''}`);
        case 'find_files':
            return clip(`${tool.pattern}${tool.dirpath ? ` @ ${tool.dirpath}` : ''}`);
        case 'get_diagnostics':
            return tool.filepath ?? 'workspace';
        case 'fetch_url':
        case 'browser_navigate':
            return clip(tool.url);
        case 'browser_click':
        case 'browser_get_text':
            return clip(tool.selector ?? 'page');
        case 'browser_type':
            return clip(tool.selector);
        case 'mcp_call':
            return clip(`${tool.server}:${tool.tool}`);
        case 'lsp_symbol':
            return clip(tool.query);
        case 'debug_get_variables':
            return `frame ${tool.frameId ?? 0}`;
        case 'debug_get_callstack':
        case 'debug_list_breakpoints':
        case 'browser_screenshot':
        case 'browser_close':
            return tool.type;
        case 'update_todo':
            return `${tool.items.length} items`;
    }
}
