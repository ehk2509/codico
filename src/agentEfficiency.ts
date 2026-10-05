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

/**
 * Prevents an agent from spending a whole turn broadening its search after it
 * already has enough evidence to try a minimal fix. This is guidance, not a hard
 * stop: a genuinely blocked task may keep exploring.
 */
export function explorationGuidance(streak: number): string | null {
    if (streak < 6 || (streak > 6 && streak % 3 !== 0)) { return null; }
    return '[System Guidance] You have made ' + streak +
        ' read-only exploration calls without changing code. Stop broadening the search. ' +
        'If the current evidence supports a fix, make the smallest edit now and then verify it. ' +
        'Only continue exploring if one specific unanswered question blocks the edit.';
}
