/**
 * Decides whether another autonomous agent iteration should run.
 *
 * maxIterations is a soft exploration budget only. It must never terminate a
 * coding task while a required mutation or post-edit verification is pending.
 * Pending correctness obligations therefore keep the loop alive until they are
 * satisfied or the user aborts. A model that stops working on them is handled by
 * the agent loop, which ends the turn after repeated reminders that get no tool
 * call (see MAX_STALLED_VERIFICATION_NUDGES in agentProvider.ts).
 *
 * Nor does it end the loop between running a check (a test, build, type-check, lint or
 * diagnostics) and reading its result: the step after a check always runs, up to
 * MAX_CHECK_READS_PAST_BUDGET steps past the budget.
 */
export const MAX_CHECK_READS_PAST_BUDGET = 5;

export function shouldRunAgentIteration(
    iteration: number,
    maxIterations: number,
    verificationPending: boolean,
    _verificationGraceIterations = 4,
    mutationPending = false,
    _mutationGraceIterations = 3,
    _lastMutationIteration = 0,
    /** The previous step ran a check whose result the model has not read yet. */
    checkResultUnread = false,
): boolean {
    if (verificationPending || mutationPending) { return true; }
    if (maxIterations <= 0) { return true; }
    return iteration < maxIterations || (checkResultUnread && iteration < maxIterations + MAX_CHECK_READS_PAST_BUDGET);
}
