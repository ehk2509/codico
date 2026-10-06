import type { ToolCall } from './toolParser';
import type { NativeToolDefinition } from './nativeTools';
import { nativeToolsForAgentPhase } from './nativeTools';
import { systemPromptForAgentPhase } from './agentPhasePrompt';
import { buildTaskAcceptanceContract, taskLikelyRequiresMutation } from './taskAcceptance';
import {
    explorationDecision,
    explorationTarget,
    isBehavioralVerificationCommand,
    isExplorationTool,
    isExploratoryTerminalCommand,
} from './agentEfficiency';

export interface ExplorationCheck { isExploration: boolean; guidance?: string; block?: string; }

function normalizeWorkspacePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isExactFileGlob(value: string | undefined): value is string {
    return Boolean(value && !/[*?\[\]{}!]/.test(value));
}

/**
 * Exploration pressure is advisory, never a capability lock. A read-count
 * heuristic cannot prove that enough evidence exists for a safe mutation.
 */
export class ExplorationController {
    private streak = 0;
    private readonly targetVisits = new Map<string, number>();
    private readonly knownFiles = new Set<string>();
    private _locked = false;
    private _verificationPending = false;
    private _verificationFile?: string;
    private _verificationAuditSeen = false;
    private _verificationAuditReads = 0;
    private readonly _unwiredImports = new Set<string>();
    private _iteration = 0;
    private _lastExplorationIteration = -1;
    private _lockedAtIteration = -1;
    private _actionEscapeIterations = 0;
    private _lastActionEscapeIteration = -1;
    private _integrationRecoveryIterations = 0;
    private _lastIntegrationRecoveryIteration = -1;
    private _focusedAction = false;
    private _focusedReadIterations = 0;
    private _lastFocusedReadIteration = -1;
    private _lastMutationIteration = 0;
    private readonly taskContract: string;
    private readonly mutationRequired: boolean;

    constructor(rawTask = '', normalIterationBudget = 0) {
        this.taskContract = buildTaskAcceptanceContract(rawTask);
        this.mutationRequired = taskLikelyRequiresMutation(rawTask);
        void normalIterationBudget; // iteration limits must not control evidence access or task completion
    }

    /** Called exactly once for each model/agent turn. */
    public beginIteration(): void {
        this._iteration++;
    }

    public get locked(): boolean { return this._locked; }
    public get verificationPending(): boolean { return this._verificationPending; }
    public get verificationFile(): string | undefined { return this._verificationFile; }
    public get focusedAction(): boolean { return this._focusedAction; }
    public get focusedReadExhausted(): boolean { return this._focusedReadIterations >= 2; }
    public get lastMutationIteration(): number { return this._lastMutationIteration; }
    public progressReminder(): string | undefined {
        if (!this.mutationRequired || this._lastMutationIteration > 0 || this._verificationPending) { return undefined; }
        const target = explorationTarget(tool);
        const targetVisits = target ? (this.targetVisits.get(target) ?? 0) + 1 : 1;
        if (this._lastExplorationIteration !== this._iteration) {
            this._lastExplorationIteration = this._iteration;
            this.streak++;
        }
        const decision = explorationDecision(this.streak, targetVisits);
        if (target) { this.targetVisits.set(target, targetVisits); }
        if (decision.lock && !this._locked) {
            this._locked = true;
            this._lockedAtIteration = this._iteration;
            this._actionEscapeIterations = 0;
            this._lastActionEscapeIteration = -1;
        }
        return { isExploration: true, guidance: decision.guidance };
    }

    public blocksTerminal(tool: ToolCall): boolean {
        if (tool.type !== 'run_terminal' || !isExploratoryTerminalCommand(tool.command)) { return false; }
        if (this._unwiredImports.size > 0) { return true; }
        return this._focusedAction;
    }

    public after(tool: ToolCall, result = ''): string | undefined {
        if (tool.type === 'read_file' && !/\bERROR\b/.test(result)) {
            this.knownFiles.add(normalizeWorkspacePath(tool.filepath));
        }

        if (tool.type === 'write_file' || tool.type === 'edit_file') {
            if (!/\b(?:Edit applied successfully|Written successfully)\b/.test(result)) {
                return '[System Follow-through] The edit was not applied. Resolve the tool failure before counting this as a code change.';
            }
            if (result.includes('[Post-edit integration audit]')) {
                this._unwiredImports.add(tool.filepath);
            } else {
                this._unwiredImports.delete(tool.filepath);
            }
            const previousVerificationFile = this._verificationFile;
            const broadenedWhilePending =
                this._verificationPending &&
                previousVerificationFile &&
                tool.filepath !== previousVerificationFile;

            this.streak = 0;
            this._locked = false;
            this._lastMutationIteration = this._iteration;
            this._verificationPending = true;
            this._verificationFile = tool.filepath;
            this._verificationAuditSeen = result.includes('[Local invariant audit]');
            this._verificationAuditReads = 0;
            this._integrationRecoveryIterations = 0;
            this._lastIntegrationRecoveryIteration = -1;
            this._actionEscapeIterations = 0;
            this._lastActionEscapeIteration = -1;
            this._focusedAction = false;
            this._focusedReadIterations = 0;
            this._lastFocusedReadIteration = -1;
            this._lockedAtIteration = -1;
            this._lastExplorationIteration = -1;
            this.targetVisits.clear();

            if (this._unwiredImports.size) {
                return '[System Follow-through] An edited file has an unused local import. An imported helper is not implemented until a caller actually invokes it. Wire the helper into the behavior path or remove the unused import, then verify.';
            }

            if (broadenedWhilePending) {
                return '[System Follow-through] You changed a second file before the previous edit was behaviorally verified. Keep this new edit local now: audit its control flow and run behavior-level verification before changing another sibling.';
            }

            return '[System Follow-through] Code changed. Do not declare success yet. Verify the full task acceptance contract. ' +
                (this._verificationAuditSeen
                    ? 'This is a lifecycle/state edit: re-read the edited control flow once, reconcile the Local invariant audit, then run a behavior-level test. '
                    : 'Start with the edited component, then follow dependencies only if correctness requires it. ') +
                'Do not broaden mutations until this edit is locally verified.';
        }

        if (!this._verificationPending) { return undefined; }

        if (tool.type === 'run_terminal' && !isExploratoryTerminalCommand(tool.command)) {
            if (this._unwiredImports.size) {
                return '[System Verification] A command cannot close the acceptance gate while a local import is unwired in: ' + [...this._unwiredImports].join(', ') + '. Connect the helper or remove its import before final verification.';
            }
            if (!/\bExit:\s*0\b/.test(result)) {
                return '[System Verification] Verification failed. Use the failure as evidence, revise the implementation, and verify again.';
            }

            if (this._verificationAuditSeen && this._verificationAuditReads === 0) {
                return '[System Verification] The command passed, but the lifecycle/state edit has not been re-read after mutation. Audit the edited control flow and its normal terminal paths before accepting this result.';
            }

            if (this._verificationAuditSeen && !isBehavioralVerificationCommand(tool.command)) {
                return '[System Verification] Static verification passed, but lifecycle/state semantics still need a behavior-level test. Run the narrowest test-like command before considering this edit verified.';
            }

            this.finishVerification();
            return '[System Verification] Focused verification passed. The acceptance gate is satisfied.';
        }

        if (tool.type === 'get_diagnostics') {
            if (this._unwiredImports.size) {
                return '[System Verification] Clean diagnostics cannot prove an unused imported helper is integrated. Wire or remove it first.';
            }
            const clean = !/\bERROR\b|🔴\s*ERROR/i.test(result);
            if (!clean) {
                return '[System Verification] Diagnostics still report errors. Fix them before finishing.';
            }

            if (this._verificationAuditSeen) {
                const auditStep = this._verificationAuditReads === 0
                    ? ' Re-read the edited control flow and reconcile the Local invariant audit first.'
                    : '';
                return '[System Verification] Diagnostics are clean, but they are static evidence and cannot verify lifecycle/terminal behavior.' +
                    auditStep + ' Run a behavior-level test before broadening or finishing.';
            }

            if (this._verificationAuditReads > 0) {
                this.finishVerification();
                return '[System Verification] The edited behavior was inspected after mutation and diagnostics are clean. The acceptance gate is satisfied.';
            }

            return '[System Verification] Diagnostics are clean, but inspect the changed behavior or run a focused test before finishing.';
        }

        return undefined;
    }

    private finishVerification(): void {
        this._verificationPending = false;
        this._verificationFile = undefined;
        this._verificationAuditSeen = false;
        this._verificationAuditReads = 0;
        this._integrationRecoveryIterations = 0;
        this._lastIntegrationRecoveryIteration = -1;
    }
}
