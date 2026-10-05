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
 * Exploration is useful until it stops producing decisions. After repeated
 * read/search calls with no mutation, move the agent from diagnosis to action.
 * The hard cap applies only to exploration tools; edit/write and terminal
 * verification remain available, so a focused fix can still proceed safely.
 */
export function explorationDecision(
    streak: number,
    targetVisits: number,
): ExplorationDecision {
    if (targetVisits >= 3) {
        return {
            block: '[System] Exploration blocked: you have already inspected this target repeatedly without changing code. ' +
                'Use the evidence you have. Make the smallest plausible edit now, or run a verification command if that is the specific missing evidence.',
        };
    }
    if (streak >= 12) {
        return {
            lock: true,
            block: '[System] Exploration budget exhausted for this turn after ' + streak +
                ' read/search calls without a code change. Discovery tools are now disabled until you change code. ' +
                'Make the smallest plausible edit now, then verify it. If you truly cannot edit, state the single concrete blocker.',
        };
    }
    if (streak === 6 || streak === 9) {
        return {
            guidance: '[System Guidance] You have made ' + streak +
                ' read-only exploration calls without changing code. Stop broadening the search. ' +
                'If the current evidence supports a fix, make the smallest edit now and then verify it.',
        };
    }
    return {};
}

// Backward-compatible helper used by existing callers/tests.
export function explorationGuidance(streak: number): string | null {
    return explorationDecision(streak, 0).guidance ?? null;
}


const EXPLORATORY_TERMINAL_RE = /^\s*(?:(?:git\s+(?:grep|show|log|status|diff))|(?:rg|grep|find|fd|ls|cat|head|tail|less|more|sed|awk|wc)\b)/i;

/**
 * Prevent run_terminal from becoming a backdoor source reader after native
 * discovery tools have been withdrawn. Test/build/lint commands remain allowed.
 */
export function isExploratoryTerminalCommand(command: string): boolean {
    return EXPLORATORY_TERMINAL_RE.test(command);
}
