import type { ToolCall } from './toolParser';
import type { NativeToolDefinition } from './nativeTools';
import { nativeToolsForAgentPhase } from './nativeTools';
import { systemPromptForAgentPhase } from './agentPhasePrompt';
import { buildTaskAcceptanceContract } from './taskAcceptance';
import { explorationDecision, explorationTarget, isExplorationTool, isExploratoryTerminalCommand } from './agentEfficiency';

export interface ExplorationCheck { isExploration: boolean; guidance?: string; block?: string; }

/**
 * Exploration pressure is advisory, never a capability lock. A read-count
 * heuristic cannot prove that enough evidence exists for a safe mutation.
 */
export class ExplorationController {
    private streak = 0;
    private readonly targetVisits = new Map<string, number>();
    private _locked = false;
    private _verificationPending = false;
    private _verificationFile?: string;
    private _verificationAuditSeen = false;
    private _verificationAuditReads = 0;
    private readonly taskContract: string;

    constructor(rawTask = '') { this.taskContract = buildTaskAcceptanceContract(rawTask); }
    public get locked(): boolean { return this._locked; }
    public get verificationPending(): boolean { return this._verificationPending; }
    public get verificationFile(): string | undefined { return this._verificationFile; }
    public get verificationReadAllowed(): boolean { return this._verificationPending; }

    public completionGuidance(): string | undefined {
        if (!this._verificationPending) { return undefined; }
        return '[System Verification] You changed code but have not completed the task acceptance check. ' +
            'Before finishing, verify the changed behavior and every preservation/negative constraint. ' +
            'Run the narrowest relevant test/build/diagnostics command. If a caller, consumer, sibling implementation, or shared abstraction must be inspected to make that check meaningful, inspect it first.';
    }

    public systemPrompt(chatMode: boolean): string | undefined {
        return systemPromptForAgentPhase(chatMode, this._locked, this._verificationPending, this._verificationFile, this.taskContract, this.verificationReadAllowed);
    }

    public nativeTools(tools: NativeToolDefinition[]): NativeToolDefinition[] {
        return nativeToolsForAgentPhase(tools, this._locked, this._verificationPending, this._verificationFile, this.verificationReadAllowed);
    }

    public before(tool: ToolCall, readOnlyMode: boolean): ExplorationCheck {
        if (readOnlyMode) { return { isExploration: false }; }

        if (this._verificationPending && isExplorationTool(tool)) {
            if (tool.type === 'get_diagnostics') { return { isExploration: false }; }

            if (tool.type === 'read_file') {
                const local = !this._verificationFile || tool.filepath === this._verificationFile;
                if (local) {
                    this._verificationAuditReads++;
                    this._verificationAuditSeen = true;
                    return {
                        isExploration: true,
                        guidance: this._verificationAuditReads === 1
                            ? '[System Verification] Audit this edit against the requested behavior and every preservation/negative constraint. Trace normal success/completion/cancellation paths before deciding the fix is complete.'
                            : '[System Verification] This file was already inspected after the edit. Re-read only if it closes a concrete acceptance gap; otherwise verify behavior now.',
                    };
                }
                return {
                    isExploration: true,
                    guidance: '[System Verification] You are following a dependency outside the edited file. Keep this targeted: verify a caller, consumer, shared abstraction, sibling implementation, or explicit acceptance constraint, then return to verification.',
                };
            }

            return {
                isExploration: true,
                guidance: '[System Verification] Discovery remains available because correctness outranks a fixed read budget. Use this call only to close a concrete acceptance gap, then verify the implementation.',
            };
        }

        if (!isExplorationTool(tool)) { return { isExploration: false }; }

        const target = explorationTarget(tool);
        const targetVisits = target ? (this.targetVisits.get(target) ?? 0) + 1 : 1;
        const nextStreak = this.streak + 1;
        const decision = explorationDecision(nextStreak, targetVisits);
        this.streak = nextStreak;
        if (target) { this.targetVisits.set(target, targetVisits); }
        if (decision.lock) { this._locked = true; }
        return { isExploration: true, guidance: decision.guidance };
    }

    public blocksTerminal(_tool: ToolCall): boolean { return false; }

    public after(tool: ToolCall, result = ''): string | undefined {
        if (tool.type === 'write_file' || tool.type === 'edit_file') {
            this.streak = 0;
            this._locked = false;
            this._verificationPending = true;
            this._verificationFile = tool.filepath;
            this._verificationAuditSeen = result.includes('[Local invariant audit]');
            this._verificationAuditReads = 0;
            this.targetVisits.clear();

            return '[System Follow-through] Code changed. Do not declare success yet. Verify the full task acceptance contract. ' +
                (this._verificationAuditSeen
                    ? 'Review the attached Local invariant audit. '
                    : 'Start with the edited component, then follow dependencies if correctness requires it. ') +
                'Run the narrowest meaningful verification command before finishing.';
        }

        if (!this._verificationPending) { return undefined; }

        if (tool.type === 'run_terminal' && !isExploratoryTerminalCommand(tool.command)) {
            if (!/\bExit:\s*0\b/.test(result)) {
                return '[System Verification] Verification failed. Use the failure as evidence, revise the implementation, and verify again.';
            }
            this.finishVerification();
            return '[System Verification] Focused verification passed. The acceptance gate is satisfied.';
        }

        if (tool.type === 'get_diagnostics') {
            const clean = !/\bERROR\b|🔴\s*ERROR/i.test(result);
            if (clean && this._verificationAuditSeen) {
                this.finishVerification();
                return '[System Verification] The edited behavior was audited and diagnostics are clean. The acceptance gate is satisfied.';
            }
            if (!clean) { return '[System Verification] Diagnostics still report errors. Fix them before finishing.'; }
            return '[System Verification] Diagnostics are clean, but inspect the changed behavior or run a focused test before finishing.';
        }

        return undefined;
    }

    private finishVerification(): void {
        this._verificationPending = false;
        this._verificationFile = undefined;
        this._verificationAuditSeen = false;
        this._verificationAuditReads = 0;
    }
}
