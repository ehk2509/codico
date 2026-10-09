import { ToolCall, toolFingerprint } from './toolParser';

/** Calls whose result depends on the workspace, so it can differ after a write or a command. */
const WORKSPACE_READS = new Set<ToolCall['type']>([
    'read_file', 'list_directory', 'search_files', 'find_files', 'get_diagnostics', 'lsp_symbol',
]);
const WRITES = new Set<ToolCall['type']>(['write_file', 'edit_file']);

/**
 * Detects a model repeating the same tool call. Repeats only count while nothing has
 * changed: re-reading a file after editing it, or re-running the tests after a fix, is
 * normal work. Identical writes and edits always count, since repeating one achieves nothing.
 */
export class ToolLoopGuard {
    private readonly _counts = new Map<string, { type: ToolCall['type']; count: number }>();

    constructor(private readonly _maxIdentical = 3) {}

    /** Registers a call; `loop` is true once the same call exceeds the allowed repeats. */
    check(tool: ToolCall): { count: number; loop: boolean } {
        const key = toolFingerprint(tool);
        const count = (this._counts.get(key)?.count ?? 0) + 1;
        this._counts.set(key, { type: tool.type, count });
        return { count, loop: count > this._maxIdentical };
    }

    /** Call after a tool ran: what it may have changed makes earlier calls worth repeating. */
    ran(tool: ToolCall): void {
        const stale = WRITES.has(tool.type)
            ? (type: ToolCall['type']) => !WRITES.has(type)
            : tool.type === 'run_terminal'
                ? (type: ToolCall['type']) => WORKSPACE_READS.has(type)
                : null;
        if (!stale) { return; }
        for (const [key, entry] of this._counts) {
            if (stale(entry.type)) { this._counts.delete(key); }
        }
    }
}
