/**
 * Decides whether another autonomous agent iteration should run.
 *
 * maxIterations is a soft exploration budget only. It must never terminate a
 * coding task while a required mutation or post-edit verification is pending.
 * Pending correctness obligations therefore keep the loop alive until they are
 * satisfied or the user aborts.
 */
export function shouldRunAgentIteration(
    iteration: number,
    maxIterations: number,
    verificationPending: boolean,
    _verificationGraceIterations = 4,
    mutationPending = false,
    _mutationGraceIterations = 3,
    _lastMutationIteration = 0,
): boolean {
    if (verificationPending || mutationPending) { return true; }
    if (maxIterations <= 0) { return true; }
    return iteration < maxIterations;
}
