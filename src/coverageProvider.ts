import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FileCoverage {
    filePath: string;       // absolute path
    uncoveredLines: number[];
    totalLines: number;
    coveredPct: number;
}

// ─── Discovery ────────────────────────────────────────────────────────────────

/** Known locations where popular test runners emit coverage output. */
const COVERAGE_CANDIDATES = [
    'coverage/lcov.info',
    'coverage/lcov.dat',
    '.nyc_output/lcov.info',
    'lcov.info',
    'coverage/coverage-final.json',
    '.nyc_output/coverage-final.json',
    'coverage/coverage.json',
    'coverage-final.json',
];

/**
 * Walk common directories to find a coverage report file.
 * Returns the absolute path to the first one found, or null.
 */
export async function discoverCoverageFile(workspaceRoot: string): Promise<string | null> {
    for (const rel of COVERAGE_CANDIDATES) {
        const abs = path.join(workspaceRoot, rel);
        try {
            await fs.promises.access(abs, fs.constants.R_OK);
            return abs;
        } catch {
            // not found — try next
        }
    }
    return null;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse a coverage file and return per-file coverage data.
 * Supports LCOV (`.info` / `.dat`) and Istanbul JSON (`coverage-final.json`).
 */
export async function parseCoverage(coverageFile: string): Promise<Map<string, FileCoverage>> {
    const ext = path.extname(coverageFile).toLowerCase();
    const content = await fs.promises.readFile(coverageFile, 'utf8');

    if (ext === '.info' || ext === '.dat') {
        return _parseLcov(content);
    }
    if (ext === '.json') {
        return _parseIstanbulJson(content);
    }
    return new Map();
}

// ── LCOV ──────────────────────────────────────────────────────────────────────

function _flushLcovRecord(file: string, lineCounts: Map<number, number>, result: Map<string, FileCoverage>): void {
    const uncoveredLines: number[] = [];
    let total = 0;
    let covered = 0;
    for (const [lineNo, hits] of lineCounts) {
        total++;
        if (hits === 0) { uncoveredLines.push(lineNo); } else { covered++; }
    }
    uncoveredLines.sort((a, b) => a - b);
    result.set(file, {
        filePath: file,
        uncoveredLines,
        totalLines: total,
        coveredPct: total === 0 ? 100 : Math.round((covered / total) * 100),
    });
}

function _parseLcov(content: string): Map<string, FileCoverage> {
    const result = new Map<string, FileCoverage>();
    let currentFile: string | null = null;
    const lineCounts = new Map<number, number>(); // lineNo → hits

    for (const raw of content.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('SF:')) {
            // Malformed LCOV: new SF: without end_of_record — flush any pending data first
            if (currentFile && lineCounts.size > 0) {
                _flushLcovRecord(currentFile, lineCounts, result);
            }
            currentFile = line.slice(3);
            lineCounts.clear();
        } else if (line.startsWith('DA:') && currentFile) {
            const parts = line.slice(3).split(',');
            const lineNo = parseInt(parts[0], 10);
            const hits = parseInt(parts[1], 10);
            if (!isNaN(lineNo) && !isNaN(hits)) {
                // DA lines can repeat (e.g. from multiple test runs); take max
                lineCounts.set(lineNo, Math.max(lineCounts.get(lineNo) ?? 0, hits));
            }
        } else if (line === 'end_of_record' && currentFile) {
            _flushLcovRecord(currentFile, lineCounts, result);
            currentFile = null;
            lineCounts.clear();
        }
    }
    return result;
}

// ── Istanbul JSON ─────────────────────────────────────────────────────────────

interface IstanbulStatementMap {
    [id: string]: { start: { line: number; column: number }; end: { line: number; column: number } };
}
interface IstanbulFileCoverage {
    s?: Record<string, number>;
    statementMap?: IstanbulStatementMap;
}

function _parseIstanbulJson(content: string): Map<string, FileCoverage> {
    const result = new Map<string, FileCoverage>();
    let json: unknown;
    try {
        json = JSON.parse(content);
    } catch {
        return result;
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
        return result;
    }

    for (const [filePath, fileData] of Object.entries(json as Record<string, unknown>)) {
        if (filePath === 'total') { continue; }
        const fd = fileData as IstanbulFileCoverage;
        if (!fd.s || !fd.statementMap) { continue; }

        const uncoveredLinesSet = new Set<number>();
        const coveredLinesSet   = new Set<number>();
        const allLinesSet = new Set<number>();

        for (const [id, count] of Object.entries(fd.s)) {
            const loc = fd.statementMap[id];
            if (!loc) { continue; }
            // Mark every line spanned by this statement
            for (let l = loc.start.line; l <= loc.end.line; l++) {
                allLinesSet.add(l);
                if (count === 0) {
                    uncoveredLinesSet.add(l);
                } else {
                    coveredLinesSet.add(l);
                }
            }
        }
        // A line is only truly uncovered if no statement covering it ran.
        // Multi-line statements can overlap: remove any line hit by a covered statement.
        for (const l of coveredLinesSet) { uncoveredLinesSet.delete(l); }

        const uncoveredLines = Array.from(uncoveredLinesSet).sort((a, b) => a - b);
        const total = allLinesSet.size;
        const covered = total - uncoveredLines.length;

        result.set(filePath, {
            filePath,
            uncoveredLines,
            totalLines: total,
            coveredPct: total === 0 ? 100 : Math.round((covered / total) * 100),
        });
    }
    return result;
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Build an AI prompt that includes the annotated source with uncovered lines
 * clearly marked, asking the model to write tests targeting those paths.
 */
export function buildCoveragePrompt(
    filePath: string,
    uncoveredLines: number[],
    sourceCode: string,
    coveredPct: number,
): string {
    const uncoveredSet = new Set(uncoveredLines);
    const annotated = sourceCode
        .split('\n')
        .map((l, i) => {
            const lineNo = i + 1;
            const marker = uncoveredSet.has(lineNo) ? '  ← UNCOVERED' : '';
            return `${String(lineNo).padStart(5)}: ${l}${marker}`;
        })
        .join('\n');

    const baseName = path.basename(filePath, path.extname(filePath));
    const ext = path.extname(filePath);

    return [
        `Generate tests for the file below to cover the currently untested lines.`,
        ``,
        `File: ${filePath}`,
        `Coverage: ${coveredPct}% of tracked lines are currently covered.`,
        `Uncovered lines: ${uncoveredLines.join(', ')}`,
        ``,
        `Annotated source (lines marked ← UNCOVERED need test coverage):`,
        `\`\`\``,
        annotated,
        `\`\`\``,
        ``,
        `Instructions:`,
        `- Identify the code paths on the uncovered lines and write focused test cases that exercise each one.`,
        `- Use whatever test framework is already present in the project (check package.json).`,
        `- Write the tests to the appropriate test file (e.g. \`${baseName}.test${ext}\` or \`${baseName}.spec${ext}\` in the nearest __tests__ or test directory).`,
        `- Do not duplicate existing tests; only add what is missing.`,
    ].join('\n');
}
