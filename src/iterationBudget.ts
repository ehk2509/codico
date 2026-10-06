/**
 * Decides whether another autonomous agent iteration is allowed.
 *
 * maxIterations is the normal budget. Two bounded grace phases can extend it:
 * - mutation grace: a coding task reached mutation-only mode but has not yet
 *   produced a successful change;
 * - verification grace: code changed and still needs acceptance checks.
 *
 * Verification grace is progress-aware: a successful late edit refreshes the
 * verification window, but the whole loop is still clipped to the absolute
 * ceiling maxIterations + mutationGraceIterations + verificationGraceIterations.
 */
export function shouldRunAgentIteration(
    iteration: number,
    maxIterations: number,
    verificationPending: boolean,
    verificationGraceIterations = 4,
    mutationPending = false,
    mutationGraceIterations = 3,
    lastMutationIteration = 0,
): boolean {
    if (maxIterations <= 0) { return true; }
    if (iteration < maxIterations) { return true; }

    const verificationGrace = Math.max(0, Math.floor(verificationGraceIterations));
    const mutationGrace = Math.max(0, Math.floor(mutationGraceIterations));

    if (verificationPending) {
        const baselineDeadline = maxIterations + verificationGrace;
        const progressDeadline = lastMutationIteration > 0
            ? lastMutationIteration + verificationGrace
            : baselineDeadline;
        const absoluteDeadline = maxIterations + mutationGrace + verificationGrace;
        return iteration < Math.min(
            absoluteDeadline,
            Math.max(baselineDeadline, progressDeadline),
        );
    }

    return mutationPending && iteration < maxIterations + mutationGrace;
}
