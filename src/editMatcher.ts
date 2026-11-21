import { withoutLineNumbers } from './fileReadWindow';
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

export function applyEditMatch(source: string, match: EditMatch, replacement: string, requestedOldText?: string): string {
    const text = match.mode === 'exact' || requestedOldText === undefined
        ? replacement
        : fitReplacement(source, match, requestedOldText, replacement);
    return source.slice(0, match.start) + text + source.slice(match.end);
}

const leadingSpace = (line: string): string => /^[ \t]*/.exec(line)![0];

/**
 * The new text of an edit that matched only after whitespace was relaxed, made to fit the file. The match
 * leaves out the old text's outer whitespace, so the same outer whitespace of the new text is not inserted
 * either (or the line would keep the file's indentation and gain the model's: `    \treturn`). Its lines
 * take the file's indentation where the old text's lines had another one (tabs for spaces, 2 for 4 spaces).
 */
function fitReplacement(source: string, match: EditMatch, requested: string, replacement: string): string {
    const lead = /^\s*/.exec(requested)![0];
    const trail = /\s*$/.exec(requested)![0];
    let body = replacement;
    const leadDropped = lead !== '' && body.startsWith(lead);
    if (leadDropped) { body = body.slice(lead.length); }
    if (trail && body.length >= trail.length && body.endsWith(trail)) { body = body.slice(0, body.length - trail.length); }

    // The indentation of the matched first line is in the file already, before the match
    const lineStart = source.lastIndexOf('\n', match.start - 1) + 1;
    const fileFirst = source.slice(lineStart, match.start);
    if (!/^[ \t]*$/.test(fileFirst)) { return body; }
    const modelFirst = /[ \t]*$/.exec(lead)![0];

    // Pair each line of the old text with the file's line it matched: the model's indentation → the file's
    const asked = requested.trim().split('\n');
    const found = match.matchedText.split('\n');
    const indent = new Map<string, string | null>([[modelFirst, fileFirst]]);
    if (asked.length === found.length) {
        for (let i = 1; i < asked.length; i++) {
            const from = leadingSpace(asked[i]);
            const to = leadingSpace(found[i]);
            const known = indent.get(from);
            indent.set(from, known === undefined || known === to ? to : null); // one indentation read two ways: unknown
        }
    }
    // Tabs for spaces (or spaces for tabs): the width of one level, from a pair that shows it
    let tabWidth = 0;
    let fileUsesTabs: boolean | undefined;
    for (const [from, to] of indent) {
        if (!to || !from) { continue; }
        if (/^\t+$/.test(from) && /^ +$/.test(to) && to.length % from.length === 0) { tabWidth = to.length / from.length; fileUsesTabs = false; break; }
        if (/^ +$/.test(from) && /^\t+$/.test(to) && from.length % to.length === 0) { tabWidth = from.length / to.length; fileUsesTabs = true; break; }
    }
    const restyle = (space: string): string => {
        const mapped = indent.get(space);
        if (mapped) { return mapped; }
        if (mapped === null || !tabWidth) { return space; }
        return fileUsesTabs
            ? space.replace(new RegExp(` {${tabWidth}}`, 'g'), '\t')
            : space.replace(/\t/g, ' '.repeat(tabWidth));
    };

    const lines = body.split('\n');
    return lines.map((line, i) => {
        if (i === 0) {
            // The first line starts after the file's own indentation
            return leadDropped || !line.startsWith(modelFirst) ? line : line.slice(modelFirst.length);
        }
        const space = leadingSpace(line);
        return line.trim() === '' ? line : restyle(space) + line.slice(space.length);
    }).join('\n');
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

/**
 * An edit whose old text carries the line numbers of a numbered read (the model copied them
 * along): used without them when that is what matches the file. Anything else is returned as given.
 */
export function withoutCopiedLineNumbers(source: string, oldText: string, newText: string): { oldText: string; newText: string } {
    if (resolveEditMatch(source, oldText).match) { return { oldText, newText }; }
    const bareOld = withoutLineNumbers(oldText);
    if (bareOld === null || !resolveEditMatch(source, bareOld).match) { return { oldText, newText }; }
    return { oldText: bareOld, newText: withoutLineNumbers(newText) ?? newText };
}

