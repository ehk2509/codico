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
