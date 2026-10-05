import type { ToolCall } from './toolParser';
import {
    explorationDecision,
    explorationTarget,
    isExplorationTool,
    isExploratoryTerminalCommand,
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
    private _verificationPending = false;
    private _verificationFile?: string;
    private _verificationAuditSeen = false;
    private _verificationReads = 0;

    public get locked(): boolean { return this._locked; }
    public get verificationPending(): boolean { return this._verificationPending; }
    public get verificationFile(): string | undefined { return this._verificationFile; }

    public before(tool: ToolCall, readOnlyMode: boolean): ExplorationCheck {
        if (readOnlyMode) { return { isExploration: false }; }

        if (this._verificationPending && isExplorationTool(tool)) {
            if (tool.type === 'get_diagnostics') { return { isExploration: false }; }
            if (tool.type === 'read_file' &&
                (!this._verificationFile || tool.filepath === this._verificationFile)) {
                if (this._verificationReads >= 2) {
                    return {
                        isExploration: true,
                        block: '[System] You already re-read the edited file twice during local verification. ' +
                            'Use the invariant evidence you have: revise the same file or run the narrowest test/build/diagnostics now.',
                    };
                }
                this._verificationReads++;
                this._verificationAuditSeen = true;
                return {
                    isExploration: true,
                    guidance: '[System Verification] Audit the edited component locally before broadening: ' +
                        'identify the new failure/guard condition and every existing normal success, completion, or terminal path. ' +
                        'Confirm the new state cannot fire on those normal paths; if it can, revise the same file before moving on.',
                };
            }
            return {
                isExploration: true,
                block: '[System] Post-edit local verification is active. Do not broaden into sibling source files yet. ' +
                    (this._verificationFile
                        ? `Re-read ${this._verificationFile}, audit its failure and normal success/terminal paths, then run a narrow verification command.`
                        : 'Re-read the edited component, audit failure and normal success/terminal paths, then run a narrow verification command.'),
            };
        }

        if (!isExplorationTool(tool)) { return { isExploration: false }; }

        if (this._locked) {
            // Diagnostics are verification, not additional source discovery.
            if (tool.type === 'get_diagnostics') { return { isExploration: false }; }
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
        return (this._locked || this._verificationPending) &&
            tool.type === 'run_terminal' &&
            isExploratoryTerminalCommand(tool.command);
    }

    public after(tool: ToolCall, result = ''): string | undefined {
        if (tool.type === 'write_file' || tool.type === 'edit_file') {
            this.streak = 0;
            this._locked = false;
            this._verificationPending = true;
            this._verificationFile = tool.filepath;
            this._verificationAuditSeen = result.includes('[Local invariant audit]');
            this._verificationReads = 0;
            this.targetVisits.clear();
            return this._verificationAuditSeen
                ? '[System Follow-through] Code changed. Review the attached Local invariant audit first: check every listed normal ' +
                    'success/completion/terminal path against your new guard, revise this same file if needed, then run the narrowest verification command.'
                : '[System Follow-through] Code changed. Verify locally before broadening. Re-read the edited file and audit both the new ' +
                    'failure/guard path and every existing normal success, completion, or terminal path. Then run the narrowest verification command.';
        }

        if (this._verificationPending && tool.type === 'run_terminal' &&
            !isExploratoryTerminalCommand(tool.command) && /\bExit:\s*0\b/.test(result)) {
            if (!this._verificationAuditSeen) {
                return '[System Verification] The verification command passed, but local invariant review is still pending. ' +
                    'Re-read the edited file and confirm the new guard/state cannot trigger on normal success or terminal paths before broadening.';
            }
            this._verificationPending = false;
            this._verificationFile = undefined;
            this._verificationAuditSeen = false;
            this._verificationReads = 0;
            return '[System Verification] Local invariant audit and verification command completed. ' +
                'Broader follow-through is available again if the task still requires it.';
        }

        return undefined;
    }
}
