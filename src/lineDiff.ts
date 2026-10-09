/**
 * Line diff shown on write/edit approval cards. Identical leading and trailing
 * lines are skipped first, so a change anywhere in a large file is shown (an
 * empty diff would make the user approve blind). The exact LCS diff runs only
 * on the changed middle; if that middle is too large for it, the removed and
 * added lines are shown as one block instead.
 */
const CONTEXT = 3;
const MAX_LCS_CELLS = 250_000; // e.g. 500 × 500 changed lines

type Op = ['+' | '-' | ' ', string];

function lcsOps(a: string[], b: string[]): Op[] {
    const n = a.length, m = b.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0) as number[]);
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    const ops: Op[] = [];
    let i = n, j = m;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { ops.push([' ', a[i - 1]]); i--; j--; }
        else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { ops.push(['+', b[j - 1]]); j--; }
        else { ops.push(['-', a[i - 1]]); i--; }
    }
    return ops.reverse();
}

export function computeLineDiff(before: string, after: string, maxOutputLines = 200): string {
    const a = before.split('\n');
    const b = after.split('\n');

    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) { prefix++; }
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) { suffix++; }

    const midA = a.slice(prefix, a.length - suffix);
    const midB = b.slice(prefix, b.length - suffix);
    if (midA.length === 0 && midB.length === 0) { return ''; } // identical

    const middle: Op[] = midA.length * midB.length <= MAX_LCS_CELLS
        ? lcsOps(midA, midB)
        : [...midA.map((l): Op => ['-', l]), ...midB.map((l): Op => ['+', l])];

    const before3 = a.slice(Math.max(0, prefix - CONTEXT), prefix).map((l): Op => [' ', l]);
    const after3 = a.slice(a.length - suffix, Math.min(a.length, a.length - suffix + CONTEXT)).map((l): Op => [' ', l]);
    const ops: Op[] = [...before3, ...middle, ...after3];

    // Within the middle, unchanged runs longer than 2×CONTEXT are collapsed to "@@"
    const show = new Set<number>();
    ops.forEach((op, k) => {
        if (op[0] === ' ') { return; }
        for (let c = Math.max(0, k - CONTEXT); c <= Math.min(ops.length - 1, k + CONTEXT); c++) { show.add(c); }
    });

    const lines: string[] = [];
    if (prefix > CONTEXT) { lines.push('@@'); }
    let prevShown = -1;
    for (let k = 0; k < ops.length; k++) {
        if (!show.has(k)) { continue; }
        if (prevShown >= 0 && k > prevShown + 1) { lines.push('@@'); }
        lines.push(ops[k][0] + ops[k][1]);
        prevShown = k;
        if (lines.length >= maxOutputLines) { lines.push('…'); break; }
    }
    return lines.join('\n');
}
