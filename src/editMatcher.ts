export type EditMatchMode = 'exact' | 'trimmed-boundary' | 'whitespace-tolerant';

export interface EditMatch {
    start: number;
    end: number;
    matchedText: string;
    mode: EditMatchMode;
}

export type EditMatchResult =
    | { match: EditMatch; error?: undefined }
    | { match?: undefined; error: 'not_found' | 'ambiguous'; candidates: number };

function occurrences(source: string, needle: string, limit = 3): Array<{ start: number; end: number }> {
    if (!needle) { return []; }
    const found: Array<{ start: number; end: number }> = [];
    let from = 0;
    while (from <= source.length - needle.length && found.length < limit) {
        const index = source.indexOf(needle, from);
        if (index < 0) { break; }
        found.push({ start: index, end: index + needle.length });
        from = index + Math.max(1, needle.length);
    }
    return found;
}

function escapeRegex(value: string): string {
    return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function whitespacePattern(value: string): RegExp | null {
    const trimmed = value.trim();
    if (!trimmed || !/\s/.test(trimmed)) { return null; }
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length < 2) { return null; }
    return new RegExp(parts.map(escapeRegex).join('[\\t \\r\\n\\f\\v]+'), 'g');
}

function regexMatches(source: string, pattern: RegExp, limit = 3): Array<{ start: number; end: number }> {
    const found: Array<{ start: number; end: number }> = [];
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null && found.length < limit) {
        if (match[0].length === 0) {
            pattern.lastIndex++;
            continue;
        }
        found.push({ start: match.index, end: match.index + match[0].length });
    }
    return found;
}

/**
 * Resolve an edit target conservatively.
 *
 * 1. Exact unique text wins.
 * 2. A unique exact match after trimming only outer whitespace is accepted.
 * 3. A unique match that differs only in whitespace runs is accepted.
 *
 * Any ambiguous fallback is rejected. This makes edit_file resilient to model
 * formatting/indentation drift without turning it into an unsafe fuzzy patcher.
 */
export function resolveEditMatch(source: string, requestedOldText: string): EditMatchResult {
    const exact = occurrences(source, requestedOldText);
    if (exact.length === 1) {
        const hit = exact[0];
        return { match: { ...hit, matchedText: source.slice(hit.start, hit.end), mode: 'exact' } };
    }
    if (exact.length > 1) {
        return { error: 'ambiguous', candidates: exact.length };
    }

    const trimmed = requestedOldText.trim();
    if (trimmed && trimmed !== requestedOldText) {
        const boundary = occurrences(source, trimmed);
        if (boundary.length === 1) {
            const hit = boundary[0];
            return { match: { ...hit, matchedText: source.slice(hit.start, hit.end), mode: 'trimmed-boundary' } };
        }
        if (boundary.length > 1) {
            return { error: 'ambiguous', candidates: boundary.length };
        }
    }

    const pattern = whitespacePattern(requestedOldText);
    if (pattern) {
        const fuzzy = regexMatches(source, pattern);
        if (fuzzy.length === 1) {
            const hit = fuzzy[0];
            return { match: { ...hit, matchedText: source.slice(hit.start, hit.end), mode: 'whitespace-tolerant' } };
        }
        if (fuzzy.length > 1) {
            return { error: 'ambiguous', candidates: fuzzy.length };
        }
    }

    return { error: 'not_found', candidates: 0 };
}

export function applyEditMatch(source: string, match: EditMatch, replacement: string): string {
    return source.slice(0, match.start) + replacement + source.slice(match.end);
}


/**
 * Returns a small current-source excerpt near the strongest line-level anchor
 * from a failed edit request. This does not relax matching; it only gives the
 * model fresh evidence so it can retry with an exact current old_str.
 */
export function editFailureContext(
    source: string,
    requestedOldText: string,
    contextLines = 3,
): string {
    const sourceLines = source.split('\n');
    const requestedLines = requestedOldText
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length >= 4)
        .sort((a, b) => b.length - a.length);

    let anchor = -1;
    for (const requested of requestedLines) {
        const matches: number[] = [];
        for (let i = 0; i < sourceLines.length; i++) {
            if (sourceLines[i].trim() === requested) { matches.push(i); }
            if (matches.length > 1) { break; }
        }
        if (matches.length === 1) {
            anchor = matches[0];
            break;
        }
    }

    if (anchor < 0) {
        const identifiers = [...new Set(
            requestedOldText.match(/[A-Za-z_$][\w$]{3,}/g) ?? []
        )].slice(0, 12);
        let bestScore = 0;
        for (let i = 0; i < sourceLines.length; i++) {
            const score = identifiers.reduce(
                (sum, identifier) => sum + (sourceLines[i].includes(identifier) ? 1 : 0),
                0,
            );
            if (score > bestScore) {
                bestScore = score;
                anchor = i;
            }
        }
        if (bestScore === 0) { return ''; }
    }

    const from = Math.max(0, anchor - contextLines);
    const to = Math.min(sourceLines.length, anchor + contextLines + 1);
    return sourceLines
        .slice(from, to)
        .map((line, index) => `${from + index + 1}: ${line}`)
        .join('\n');
}
