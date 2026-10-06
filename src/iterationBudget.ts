/**
 * Decides whether another autonomous agent iteration is allowed.
 *
 * A configured maxIterations value is the normal budget. Two bounded grace
 * modes can extend that same absolute ceiling:
 * - mutation grace: an explicit coding task reached mutation-only mode but has
 *   not yet produced a successful code change;
 * - verification grace: a successful code change still needs acceptance checks.
 *
 * The grace budgets never reopen exploration and do not stack additively. The
 * maximum total loop length is maxIterations + max(active grace budget).
 */
export function shouldRunAgentIteration(
    iteration: number,
    maxIterations: number,
    verificationPending: boolean,
    verificationGraceIterations = 4,
    mutationPending = false,
    mutationGraceIterations = 3,
): boolean {
    if (maxIterations <= 0) { return true; }
    if (iteration < maxIterations) { return true; }

    const verificationGrace = Math.max(0, Math.floor(verificationGraceIterations));
    const mutationGrace = Math.max(0, Math.floor(mutationGraceIterations));

    if (verificationPending && iteration < maxIterations + verificationGrace) {
        return true;
    }
    return mutationPending && iteration < maxIterations + mutationGrace;
}
