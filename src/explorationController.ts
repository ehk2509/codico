import type { ToolCall } from './toolParser';
import {
    explorationDecision,
    explorationTarget,
    isExplorationTool,
    isExploratoryTerminalCommand,
    isMutationTool,
} from './agentEfficiency';

export interface ExplorationCheck {
    isExploration: boolean;
    guidance?: string;
    block?: string;
}

/**
 * Stateful turn-level exploration policy. It keeps discovery useful early in a
 * task, but once enough evidence has been gathered it forces a transition to
 * edit/verify actions. Read-only Ask mode bypasses the hard policy entirely.
 */
export class ExplorationController {
    private streak = 0;
    private readonly targetVisits = new Map<string, number>();
    private _locked = false;

    public get locked(): boolean { return this._locked; }

    public before(tool: ToolCall, readOnlyMode: boolean): ExplorationCheck {
        if (readOnlyMode || !isExplorationTool(tool)) {
            return { isExploration: false };
        }

        if (this._locked) {
            return {
                isExploration: true,
                block: '[System] Discovery tools remain disabled until you change code. Use edit_file/write_file now, then verify the result.',
            };
        }

        const target = explorationTarget(tool);
        const targetVisits = target
            ? (this.targetVisits.get(target) ?? 0) + 1
            : 1;
        const nextStreak = this.streak + 1;
        const decision = explorationDecision(nextStreak, targetVisits);

        if (decision.block) {
            if (decision.lock) { this._locked = true; }
            return {
                isExploration: true,
                block: decision.block,
            };
        }

        this.streak = nextStreak;
        if (target) { this.targetVisits.set(target, targetVisits); }
        return {
            isExploration: true,
            guidance: decision.guidance,
        };
    }

    public blocksTerminal(tool: ToolCall): boolean {
        return this._locked &&
            tool.type === 'run_terminal' &&
            isExploratoryTerminalCommand(tool.command);
    }

    public after(tool: ToolCall): void {
        if (!isMutationTool(tool)) { return; }
        this.streak = 0;
        this._locked = false;
        this.targetVisits.clear();
    }
}
