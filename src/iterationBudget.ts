/**
 * Decides whether another autonomous agent iteration is allowed.
 *
 * A configured maxIterations value is the normal budget. A short extra budget
 * is available only while a code change is still behind the acceptance gate,
 * so Codico can finish verification instead of stopping mid-fix. The grace
 * disappears immediately once verification succeeds and never extends pure
 * exploration.
 */
export function shouldRunAgentIteration(
    iteration: number,
    maxIterations: number,
    verificationPending: boolean,
    verificationGraceIterations = 4,
): boolean {
    if (maxIterations <= 0) { return true; }
    if (iteration < maxIterations) { return true; }
    const grace = Math.max(0, Math.floor(verificationGraceIterations));
    return verificationPending && iteration < maxIterations + grace;
}
