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
