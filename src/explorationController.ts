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
    private readonly normalIterationBudget: number;

    constructor(rawTask = '', normalIterationBudget = 0) {
        this.taskContract = buildTaskAcceptanceContract(rawTask);
        this.mutationRequired = taskLikelyRequiresMutation(rawTask);
        this.normalIterationBudget = Math.max(0, Math.floor(normalIterationBudget));
    }

    /** Called exactly once for each model/agent turn. */
    public beginIteration(): void {
        this._iteration++;
        // Exploration pressure must never become a capability lock before the first
        // successful mutation. Iteration count is not evidence that the model has
        // enough source context to edit safely.
        // Iteration/read-count heuristics are advisory only. They may change the
        // prompt priority, but must never remove evidence access or force a mutation.
    }

    public get locked(): boolean { return this._locked; }
    public get verificationPending(): boolean { return this._verificationPending; }
    public get verificationFile(): string | undefined { return this._verificationFile; }
    public get focusedAction(): boolean { return this._focusedAction; }
    public get focusedReadExhausted(): boolean { return this._focusedReadIterations >= 2; }
    public get lastMutationIteration(): number { return this._lastMutationIteration; }
    public get mutationGracePending(): boolean {
        return this.mutationRequired && this._focusedAction && this.focusedReadExhausted && !this._verificationPending;
    }

    /**
     * True means the edited file still needs an explicit post-edit control-flow
     * read. This is a priority signal only; dependency reads are never removed.
     */
    public get verificationReadAllowed(): boolean {
        return this._verificationPending && this._verificationAuditReads === 0;
    }

    public completionGuidance(): string | undefined {
        if (!this._verificationPending) {
            if (this._focusedAction && this.mutationRequired) {
                return this.focusedReadExhausted
                    ? '[System Action] The request explicitly requires a code change, but no mutation has succeeded. Focused source reading is complete. Do not finish yet: make the smallest evidence-backed edit now.'
                    : '[System Action] The request explicitly requires a code change, but no mutation has succeeded. Use at most the remaining bounded focused read, then edit. Do not finish with analysis only.';
            }
            return undefined;
        }
        if (this._unwiredImports.size) {
            return '[System Verification] An edited file still contains an unreferenced local import: ' +
                [...this._unwiredImports].join(', ') +
                '. Connect newly introduced helpers to their real caller/behavior path, or remove unused imports; then run a focused test. Do not finish with an import-only implementation.';
        }

        if (this._verificationAuditSeen && this._verificationAuditReads === 0) {
            return '[System Verification] This lifecycle/state edit is not verified. Re-read the edited control flow once and reconcile every path listed in the Local invariant audit, especially normal success/completion/terminal/cancellation paths. Do not broaden to sibling implementations yet.';
        }

        if (this._verificationAuditSeen) {
            return '[System Verification] The lifecycle/state edit still needs behavior-level verification. Diagnostics, lint and compilation are static checks and do not prove terminal-state semantics. Run the narrowest relevant test-like command; if it exposes a gap, revise this edit before broadening.';
        }

        return '[System Verification] You changed code but have not completed the task acceptance check. Before finishing, verify the changed behavior and every preservation/negative constraint. Run the narrowest relevant test/build command; inspect a dependency first only if it closes a concrete gap.';
    }

    public systemPrompt(chatMode: boolean): string | undefined {
        const prompt = systemPromptForAgentPhase(
            chatMode,
            this._locked,
            this._verificationPending,
            this._verificationFile,
            this.taskContract,
            this.verificationReadAllowed,
            this._focusedAction,
            this.focusedReadExhausted,
        );
        if (!prompt) { return prompt; }
        if (this._unwiredImports.size === 0) { return prompt; }
        return prompt + '\n\n## Blocking integration issue\n' +
            'A local helper is imported but still unused in: ' +
            [...this._unwiredImports].join(', ') +
            '. Stop broad exploration. Wire that helper into the actual behavior/caller path now, or remove the import. ' +
            'After the wiring edit, run the narrowest relevant test.';

    }

    public nativeTools(tools: NativeToolDefinition[]): NativeToolDefinition[] {
        return nativeToolsForAgentPhase(
            tools,
            this._locked,
            this._verificationPending,
            this._verificationFile,
            this.verificationReadAllowed,
            this._unwiredImports.size > 0,
            this._focusedAction,
            this.focusedReadExhausted,
        );
    }

    public before(tool: ToolCall, readOnlyMode: boolean): ExplorationCheck {
        if (readOnlyMode) { return { isExploration: false }; }

        if (this._verificationPending && isExplorationTool(tool)) {
            if (tool.type === 'get_diagnostics') { return { isExploration: false }; }

            if (this._unwiredImports.size > 0) {
                // Keep evidence access open. The completion gate below still prevents
                // success until the helper is wired or removed.
                return {
                    isExploration: true,
                    guidance: '[System Integration] A helper import is still unwired. Inspect only the caller/dependency evidence needed to wire it, then edit and verify. Do not finish while the import remains unused.',
                };
            }

            if (tool.type === 'read_file') {
                const local = !this._verificationFile || tool.filepath === this._verificationFile;
                if (local) {
                    this._verificationAuditReads++;
                    return {
                        isExploration: true,
                        guidance: this._verificationAuditReads === 1
                            ? '[System Verification] This is the required post-edit control-flow audit. Compare the changed guard/flag with every normal success, completion, terminal, cancellation, and error path. If any normal path can trigger the new failure condition, revise this file before broadening.'
                            : '[System Verification] This edited file has already been audited after the change. Re-read only a new range needed to close a concrete acceptance gap; otherwise run behavior-level verification.',
                    };
                }

                return {
                    isExploration: true,
                    guidance: '[System Verification] You are reading a dependency outside the edited file. Keep it read-only and targeted. Do not mutate sibling implementations until the current edited invariant is coherent and verified.',
                };
            }

            return {
                isExploration: true,
                guidance: '[System Verification] Discovery remains available only to close a concrete verification gap. Keep the current edited file as the mutation focus until its acceptance/preservation invariants are verified.',
            };
        }

        if (!isExplorationTool(tool)) { return { isExploration: false }; }

        // Focus/action pressure never blocks exploration tools. The model still receives
        // ACTION_PHASE guidance through systemPrompt() once exploration is repetitive.
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
        return false;
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
