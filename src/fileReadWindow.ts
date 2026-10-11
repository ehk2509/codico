export interface FileReadWindow {
    text: string;
    startLine: number;
    endLine: number;
    totalLines: number;
    truncated: boolean;
}

export function sliceFileByLines(
    content: string,
    startLine?: number,
    endLine?: number,
    defaultLargeFileLines = 300,
    maxLinesPerRead = 400,
): FileReadWindow {
    const lines = content.split('\n');
    const totalLines = lines.length;
    const requestedStart = Math.max(1, Math.floor(startLine ?? 1));
    const start = Math.min(requestedStart, Math.max(1, totalLines));

    const noExplicitRange = startLine == null && endLine == null;
    let requestedEnd: number;
    if (endLine != null) {
        requestedEnd = Math.max(start, Math.floor(endLine));
    } else if (noExplicitRange && totalLines <= defaultLargeFileLines) {
        requestedEnd = totalLines;
    } else {
        requestedEnd = start + (noExplicitRange ? defaultLargeFileLines : maxLinesPerRead) - 1;
    }

    const cappedEnd = Math.min(requestedEnd, start + maxLinesPerRead - 1, totalLines);
    return {
        text: lines.slice(start - 1, cappedEnd).join('\n'),
        startLine: start,
        endLine: cappedEnd,
        totalLines,
        truncated: start > 1 || cappedEnd < totalLines,
    };
}

/**
 * Lines with their numbers, the way `cat -n` prints them. A model that is not given line
 * numbers goes and gets them through the shell (`cat -n`, `grep -n "" file | sed -n …`),
 * which costs a request per look.
 */
export function numberLines(text: string, startLine: number): string {
    return text.split('\n').map((line, index) => `${startLine + index}\t${line}`).join('\n');
}

/**
 * Text a model copied out of a numbered read, with the numbers taken off: every line must
 * start with a number and a tab, or the text is left alone.
 * @returns the bare text, or null when the text is not numbered lines
 */
export function withoutLineNumbers(text: string): string | null {
    const lines = text.split('\n');
    if (!lines.some(line => line.length > 0) || !lines.every(line => line === '' || /^\s*\d+\t/.test(line))) { return null; }
    return lines.map(line => line.replace(/^\s*\d+\t/, '')).join('\n');
}

/** A read without a line range of a file this long returns an outline and its first lines instead. */
export const OUTLINE_MIN_LINES = 600;
export const OUTLINE_HEAD_LINES = 80;

export interface OutlineSymbol {
    name: string;
    kind: string;
    /** 1-based, inclusive. */
    startLine: number;
    endLine: number;
    depth: number;
}

/**
 * The outline of a large file: its symbols with line ranges, so the model reads only
 * the part it needs instead of paging through the whole file (each page stays in context).
 */
export function formatOutline(symbols: OutlineSymbol[], maxEntries = 150): string {
    // Markdown headings come back as kind "string": their name says enough
    const shown = symbols.slice(0, maxEntries).map(s =>
        `${'  '.repeat(s.depth)}L${s.startLine}–${s.endLine}  ${s.kind === 'string' ? '' : s.kind + ' '}${s.name}`);
    if (symbols.length > maxEntries) { shown.push(`… ${symbols.length - maxEntries} more symbols (search_files finds them)`); }
    return shown.join('\n');
}
