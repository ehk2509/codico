import type { ToolCall } from './toolParser';
import type { NativeToolDefinition } from './nativeTools';
import { nativeToolsForAgentPhase } from './nativeTools';
import { systemPromptForAgentPhase } from './agentPhasePrompt';
import { buildTaskAcceptanceContract } from './taskAcceptance';
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
 * Stateful turn-level exploration and verification policy.
 * Discovery is bounded; after a mutation the agent gets one focused local
 * reread at most, then must revise or verify rather than keep rereading.
 */
export class ExplorationController {
    private streak = 0;
    private readonly targetVisits = new Map<string, number>();
    private _locked = false;
    private _verificationPending = false;
    private _verificationFile?: string;
    private _verificationAuditSeen = false;
    private _verificationAuditReads = 0;
    private _requiresBehaviorVerification = false;
    private readonly taskContract: string;

    constructor(rawTask = '') {
        this.taskContract = buildTaskAcceptanceContract(rawTask);
    }

    public get locked(): boolean { return this._locked; }
    public get verificationPending(): boolean { return this._verificationPending; }
    public get verificationFile(): string | undefined { return this._verificationFile; }
    public get verificationReadAllowed(): boolean {
        return this._verificationPending && this._verificationAuditReads < 1;
    }

    public systemPrompt(chatMode: boolean): string | undefined {
        return systemPromptForAgentPhase(
            chatMode,
            this._locked,
            this._verificationPending,
            this._verificationFile,
            this.taskContract,
            this.verificationReadAllowed,
        );
    }

    public nativeTools(tools: NativeToolDefinition[]): NativeToolDefinition[] {
        return nativeToolsForAgentPhase(
            tools,
            this._locked,
            this._verificationPending,
            this._verificationFile,
            this.verificationReadAllowed,
        );
    }

    public before(tool: ToolCall, readOnlyMode: boolean): ExplorationCheck {
        if (readOnlyMode) { return { isExploration: false }; }

        if (this._verificationPending && isExplorationTool(tool)) {
            if (tool.type === 'get_diagnostics') { return { isExploration: false }; }

            if (tool.type === 'read_file' &&
                (!this._verificationFile || tool.filepath === this._verificationFile)) {
                if (!this.verificationReadAllowed) {
                    return {
                        isExploration: true,
                        block: '[System] The post-edit local read budget is exhausted. Do not read this file again. ' +
                            'Use the evidence already gathered to revise the edit, or run a focused test/build/diagnostics check now.',
                    };
                }

                this._verificationAuditReads++;
                this._verificationAuditSeen = true;
                return {
                    isExploration: true,
                    guidance: '[System Verification] This is the one post-edit audit read. Check the requested change AND every ' +
                        'preservation/negative constraint from the original task. Enumerate the normal success/completion/terminal paths ' +
                        'that must stay unchanged. After this read, do not read again: revise the edit or run a focused verification command.',
                };
            }

            return {
                isExploration: true,
                block: '[System] Post-edit local verification is active. Do not broaden into sibling source files. ' +
                    (this._verificationFile
                        ? `Audit ${this._verificationFile}, then revise it or run a narrow verification command.`
                        : 'Audit the edited component, then revise it or run a narrow verification command.'),
            };
        }

        if (!isExplorationTool(tool)) { return { isExploration: false }; }

        if (this._locked) {
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
            return { isExploration: true, block: decision.block };
        }

        this.streak = nextStreak;
        if (target) { this.targetVisits.set(target, targetVisits); }
        return { isExploration: true, guidance: decision.guidance };
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
            this._verificationAuditReads = 0;
            this._requiresBehaviorVerification = this._verificationAuditSeen;
            this.targetVisits.clear();

            return '[System Follow-through] Code changed. Verify the full task acceptance contract before broadening. ' +
                (this._verificationAuditSeen
                    ? 'Review the attached Local invariant audit; check every listed normal success/completion/terminal path. '
                    : 'You may re-read the edited file once for a focused local audit. ') +
                'Check every preservation/negative constraint from the original request, then revise the edit if needed or run the narrowest verification command.';
        }

        if (!this._verificationPending) { return undefined; }

        if (tool.type === 'run_terminal' && !isExploratoryTerminalCommand(tool.command)) {
            if (!/\bExit:\s*0\b/.test(result)) {
                return '[System Verification] Verification failed. Revise the edited file using the evidence from this failure, then verify again.';
            }
            if (!this._verificationAuditSeen) {
                return '[System Verification] The command passed, but the local invariant audit is still pending. ' +
                    'Use the single allowed reread of the edited file, check normal success/completion paths and the original preservation constraints, then verify again.';
            }
            this.finishVerification();
            return '[System Verification] Acceptance audit and verification command completed. Broader follow-through is available again if needed.';
        }

        if (tool.type === 'get_diagnostics' && !this._requiresBehaviorVerification) {
            const clean = !/\bERROR\b|🔴\s*ERROR/i.test(result);
            if (clean && this._verificationAuditSeen) {
                this.finishVerification();
                return '[System Verification] Local audit and diagnostics completed. Broader follow-through is available again if needed.';
            }
            if (!this._verificationAuditSeen) {
                return '[System Verification] Diagnostics are not enough yet. Use the single allowed reread to check the edited component against the original acceptance constraints.';
            }
        }

        return undefined;
    }

    private finishVerification(): void {
        this._verificationPending = false;
        this._verificationFile = undefined;
        this._verificationAuditSeen = false;
        this._verificationAuditReads = 0;
        this._requiresBehaviorVerification = false;
    }
}
