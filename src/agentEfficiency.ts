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

const ACTION_PHASE_AT = 8;

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
 * Exploration starts permissive, then switches to a strong action-preferred
 * phase. The phase switch changes guidance only: it never removes discovery
 * capabilities, so a genuinely missing fact can still be inspected.
 */
export function explorationDecision(streak: number, targetVisits: number): ExplorationDecision {
    const actionPhase = streak >= ACTION_PHASE_AT;

    if (targetVisits >= 3) {
        return {
            lock: actionPhase || undefined,
            guidance: actionPhase
                ? '[System Action] You have enough evidence to stop open-ended exploration and have revisited this target repeatedly. ' +
                    'Make the smallest evidence-backed code change in your next response unless you can name one concrete missing fact required for correctness; if so, inspect only that fact and then act.'
                : '[System Guidance] You have inspected this target repeatedly. Do not repeat the same read/search unless new evidence justifies it. ' +
                    'Either act, inspect a different dependency that closes a concrete gap, or verify.',
        };
    }

    if (actionPhase) {
        return {
            lock: true,
            guidance: '[System Action] You have enough evidence to stop open-ended exploration. ' +
                'Make the smallest evidence-backed code change in your next response unless one concrete missing fact is required for correctness. ' +
                'Discovery remains available only to close that specific fact; after inspecting it, act.',
        };
    }

    if (streak === 6) {
        return {
            guidance: '[System Guidance] You have made 6 read-only exploration calls without changing code. ' +
                'Prefer a small evidence-backed edit when ready, but keep exploring if a specific unresolved dependency, caller, invariant, or test still blocks a safe fix.',
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

const BEHAVIORAL_VERIFICATION_RE = /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnode\s+--test\b|\b(?:pytest|py\.test|jest|vitest|mocha|ava|tap|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|rspec|phpunit)\b)/i;

/**
 * Stateful/lifecycle edits need evidence that exercises behavior. Compilation,
 * linting and diagnostics are useful but cannot prove terminal-state semantics.
 */
export function isBehavioralVerificationCommand(command: string): boolean {
    return BEHAVIORAL_VERIFICATION_RE.test(command);
}
