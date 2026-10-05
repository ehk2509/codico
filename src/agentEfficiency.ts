import type { ToolCall } from './toolParser';

const EXPLORATION_TOOLS = new Set<ToolCall['type']>([
    'read_file',
    'list_directory',
    'search_files',
    'find_files',
    'get_diagnostics',
    'fetch_url',
    'lsp_symbol',
    'browser_get_text',
]);

export function isExplorationTool(tool: ToolCall): boolean {
    return EXPLORATION_TOOLS.has(tool.type);
}

export function isMutationTool(tool: ToolCall): boolean {
    return tool.type === 'write_file' || tool.type === 'edit_file';
}

export function explorationTarget(tool: ToolCall): string | null {
    switch (tool.type) {
        case 'read_file': return `read_file:${tool.filepath}`;
        case 'list_directory': return `list_directory:${tool.dirpath}`;
        case 'get_diagnostics': return `get_diagnostics:${tool.filepath ?? 'workspace'}`;
        case 'lsp_symbol': return `lsp_symbol:${tool.query}`;
        case 'fetch_url': return `fetch_url:${tool.url}`;
        case 'browser_get_text': return `browser_get_text:${tool.selector ?? 'page'}`;
        case 'search_files': return `search_files:${tool.pattern}:${tool.glob ?? ''}`;
        case 'find_files': return `find_files:${tool.pattern}:${tool.dirpath ?? ''}`;
        default: return null;
    }
}

export interface ExplorationDecision {
    guidance?: string;
    block?: string;
    lock?: boolean;
}

/**
 * Read-count heuristics provide pressure, not permission boundaries.
 * Never force a blind edit merely because a counter was reached.
 */
export function explorationDecision(streak: number, targetVisits: number): ExplorationDecision {
    if (targetVisits >= 3) {
        return {
            guidance: '[System Guidance] You have inspected this target repeatedly. Do not repeat the same read/search unless new evidence justifies it. ' +
                'Either act, inspect a different dependency that closes a concrete gap, or verify.',
        };
    }

    if (streak === 6 || streak === 10 || streak === 14) {
        return {
            guidance: '[System Guidance] You have made ' + streak +
                ' read-only exploration calls without changing code. Prefer a small evidence-backed edit when ready, ' +
                'but keep exploring if a specific unresolved dependency, caller, invariant, or test still blocks a safe fix.',
        };
    }

    return {};
}

export function explorationGuidance(streak: number): string | null {
    return explorationDecision(streak, 0).guidance ?? null;
}

const EXPLORATORY_TERMINAL_RE = /^\s*(?:(?:git\s+(?:grep|show|log|status|diff))|(?:rg|grep|find|fd|ls|cat|head|tail|less|more|sed|awk|wc)\b)/i;

export function isExploratoryTerminalCommand(command: string): boolean {
    return EXPLORATORY_TERMINAL_RE.test(command);
}
