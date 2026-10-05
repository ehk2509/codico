import * as vscode from 'vscode';

export function countWorkspaceDiagnostics(): { errorCount: number; warningCount: number } {
    let errorCount = 0;
    let warningCount = 0;
    for (const [, diagnostics] of vscode.languages.getDiagnostics()) {
        for (const diagnostic of diagnostics) {
            if (diagnostic.severity === vscode.DiagnosticSeverity.Error) { errorCount++; }
            else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) { warningCount++; }
        }
    }
    return { errorCount, warningCount };
}

export function buildWorkspaceDiagnosticsSummary(): string | null {
    const cap = 60;
    type Entry = {
        rel: string;
        line: number;
        sev: 'ERROR' | 'WARNING';
        msg: string;
        source?: string;
    };
    const entries: Entry[] = [];

    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
        const rel = vscode.workspace.asRelativePath(uri);
        for (const diagnostic of diagnostics) {
            if (diagnostic.severity !== vscode.DiagnosticSeverity.Error &&
                diagnostic.severity !== vscode.DiagnosticSeverity.Warning) {
                continue;
            }
            entries.push({
                rel,
                line: diagnostic.range.start.line + 1,
                sev: diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARNING',
                msg: diagnostic.message.replace(/\n/g, ' ').slice(0, 200),
                source: diagnostic.source ?? undefined,
            });
            if (entries.length >= cap) { break; }
        }
        if (entries.length >= cap) { break; }
    }

    if (entries.length === 0) { return null; }

    entries.sort((a, b) => {
        if (a.sev !== b.sev) { return a.sev === 'ERROR' ? -1 : 1; }
        if (a.rel !== b.rel) { return a.rel.localeCompare(b.rel); }
        return a.line - b.line;
    });

    const errorCount = entries.filter(entry => entry.sev === 'ERROR').length;
    const warningCount = entries.length - errorCount;
    const lines = entries.map(entry => {
        const source = entry.source ? `[${entry.source}] ` : '';
        return `${entry.sev}  ${entry.rel}:${entry.line}  ${source}${entry.msg}`;
    });
    if (entries.length >= cap) {
        lines.push(`… (capped at ${cap} — run get_diagnostics for the full list)`);
    }

    return `Workspace Problems panel (${errorCount} error${errorCount !== 1 ? 's' : ''}, ${warningCount} warning${warningCount !== 1 ? 's' : ''}):\n${lines.join('\n')}`;
}
