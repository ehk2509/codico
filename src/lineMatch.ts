/**
 * Lines two versions of a text have in common, in order (a longest common subsequence),
 * found with Myers' algorithm: its cost grows with the number of changed lines, not with
 * the size of the file, so a few edits far apart in a large file are still told apart.
 * Returns null when the two differ by more than `maxChanges` lines.
 */
export function matchLines(a: readonly string[], b: readonly string[], maxChanges = 1500): Array<[number, number]> | null {
    const n = a.length, m = b.length;
    const max = Math.min(n + m, maxChanges);
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace: Int32Array[] = [];
    for (let d = 0; d <= max; d++) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) { x++; y++; }
            v[offset + k] = x;
            if (x >= n && y >= m) { return backtrack(trace, offset, n, m, d); }
        }
    }
    return null;
}

function backtrack(trace: Int32Array[], offset: number, n: number, m: number, steps: number): Array<[number, number]> {
    const pairs: Array<[number, number]> = [];
    let x = n, y = m;
    for (let d = steps; d > 0; d--) {
        const before = trace[d];
        const k = x - y;
        const fromK = k === -d || (k !== d && before[offset + k - 1] < before[offset + k + 1]) ? k + 1 : k - 1;
        const fromX = before[offset + fromK], fromY = fromX - fromK;
        while (x > fromX && y > fromY) { pairs.push([--x, --y]); }
        x = fromX; y = fromY;
    }
    while (x > 0 && y > 0) { pairs.push([--x, --y]); }
    return pairs.reverse();
}
