/**
 * The separate changes ("hunks") between two versions of a file, so that a proposed
 * edit can be accepted or rejected one change at a time.
 */
import { matchLines } from './lineMatch';

const MAX_LCS_CELLS = 250_000;
/** Lines of a change shown in the panel; the rest is counted. */
export const HUNK_PREVIEW_LINES = 12;

export interface Hunk {
    index: number;
    /** 0-based position in the old lines where the change starts. */
    oldStart: number;
    removed: string[];
    /** 0-based position in the new lines where the change starts. */
    newStart: number;
    added: string[];
}

function commonLines(a: string[], b: string[]): Array<[number, number]> {
    const n = a.length, m = b.length;
    // Too large for the table: still aligned when the edits are few; a near-total rewrite is one change
    if (n * m > MAX_LCS_CELLS) { return matchLines(a, b) ?? []; }
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const pairs: Array<[number, number]> = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { i++; }
        else { j++; }
    }
    return pairs;
}

/** Every run of lines that differs between the two texts, in file order. */
export function computeHunks(before: string, after: string): Hunk[] {
    const a = before.split('\n'), b = after.split('\n');
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) { prefix++; }
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) { suffix++; }
    const midA = a.slice(prefix, a.length - suffix), midB = b.slice(prefix, b.length - suffix);
    // Lines both versions keep, as fixed points; the gaps between them are the changes
    const anchors = commonLines(midA, midB).map(([i, j]): [number, number] => [i + prefix, j + prefix]);
    anchors.push([a.length - suffix, b.length - suffix]);
    const hunks: Hunk[] = [];
    let oldAt = prefix, newAt = prefix;
    for (const [i, j] of anchors) {
        if (i > oldAt || j > newAt) {
            hunks.push({ index: hunks.length, oldStart: oldAt, removed: a.slice(oldAt, i), newStart: newAt, added: b.slice(newAt, j) });
        }
        oldAt = i + 1; newAt = j + 1;
    }
    return hunks;
}

/** The old text with only the chosen changes made. */
export function withHunks(before: string, after: string, keep: (index: number) => boolean): string {
    const lines = before.split('\n');
    const hunks = computeHunks(before, after);
    // From the end, so that earlier positions stay valid
    for (let k = hunks.length - 1; k >= 0; k--) {
        if (keep(hunks[k].index)) { lines.splice(hunks[k].oldStart, hunks[k].removed.length, ...hunks[k].added); }
    }
    return lines.join('\n');
}

/** A change as the panel shows it: where it is, and its first lines. */
export interface HunkPreview { index: number; line: number; removed: string[]; added: string[]; removedCount: number; addedCount: number; /** Said instead of the lines, for a change with nothing to show. */ note?: string }

export function hunkPreviews(before: string, after: string, max = 40): HunkPreview[] {
    const clip = (lines: string[]) => lines.slice(0, HUNK_PREVIEW_LINES).map(line => line.length > 300 ? line.slice(0, 300) + '…' : line);
    const oldLines = before.split('\n').length;
    return computeHunks(before, after).slice(0, max).map(h => {
        // Only the empty last "line" differs: the file gains or loses its final newline
        const atEnd = h.oldStart + h.removed.length === oldLines && h.removed.concat(h.added).join('') === '' && h.removed.length + h.added.length === 1;
        if (atEnd) { return { index: h.index, line: h.oldStart, removed: [], added: [], removedCount: 0, addedCount: 0, note: h.added.length ? 'Adds a newline at the end of the file' : 'Removes the newline at the end of the file' }; }
        return { index: h.index, line: h.oldStart + 1, removed: clip(h.removed), added: clip(h.added), removedCount: h.removed.length, addedCount: h.added.length };
    });
}
