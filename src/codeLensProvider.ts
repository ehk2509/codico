import * as vscode from 'vscode';

/**
 * Regex patterns that match the start of a function/method definition.
 * Covers: JS/TS functions, arrow functions, class methods, Python defs,
 * Go funcs, Rust fns, Java/C# methods, Ruby defs, C/C++ functions.
 */
const FUNC_PATTERNS: RegExp[] = [
    // JS/TS: function foo(, async function foo(, export function foo(, export default function(
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\w+\s*[(<]/,
    // JS/TS: arrow or method shorthand in class/object: foo(, async foo(, public/private/protected/static foo(
    /^\s*(?:(?:public|private|protected|static|abstract|override|async)\s+)*(?:readonly\s+)?(?:get\s+|set\s+)?\w+\s*[(<]/,
    // Python
    /^\s*(?:async\s+)?def\s+\w+\s*\(/,
    // Go
    /^\s*func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?\w+\s*\(/,
    // Rust
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+\w+\s*[(<]/,
    // Ruby
    /^\s*def\s+\w+/,
    // C/C++ — rough: type name( pattern
    /^\s*(?:(?:static|inline|virtual|explicit|constexpr|auto|void|int|bool|char|float|double|size_t|uint\w*|int\w*|std::\S+)\s+)+\w+\s*\(/,
];

/** Return true if the line looks like the start of a function definition. */
function isFunctionLine(line: string): boolean {
    // Skip import/export type lines, decorator lines, closing braces, comments
    if (/^\s*(?:import|export\s+(?:type|interface|enum|const|let|var|class)\s|\/\/|\/\*|\*|#|@|\}|<)/.test(line)) {
        return false;
    }
    return FUNC_PATTERNS.some(p => p.test(line));
}

/**
 * Extract the function body (up to MAX_LINES lines) starting at `startLine`.
 * Tries brace-matching for brace-based languages, falls back to indentation for Python/Ruby.
 */
function extractFunctionBody(doc: vscode.TextDocument, startLine: number, MAX_LINES = 80): string {
    const lines: string[] = [];
    const total = doc.lineCount;
    const firstLine = doc.lineAt(startLine).text;
    lines.push(firstLine);

    const usesBraces = /[{(]/.test(firstLine);

    if (usesBraces) {
        let depth = 0;
        for (let i = startLine; i < Math.min(total, startLine + MAX_LINES); i++) {
            const t = doc.lineAt(i).text;
            if (i > startLine) { lines.push(t); }
            for (const ch of t) {
                if (ch === '{' || ch === '(') { depth++; }
                if (ch === '}' || ch === ')') { depth--; }
            }
            if (i > startLine && depth <= 0) { break; }
        }
    } else {
        // Indentation-based (Python, Ruby, etc.)
        const baseIndent = (firstLine.match(/^(\s*)/) ?? ['', ''])[1].length;
        for (let i = startLine + 1; i < Math.min(total, startLine + MAX_LINES); i++) {
            const t = doc.lineAt(i).text;
            if (t.trim() === '') { lines.push(t); continue; }
            const indent = (t.match(/^(\s*)/) ?? ['', ''])[1].length;
            if (indent <= baseIndent) { break; }
            lines.push(t);
        }
    }

    return lines.join('\n');
}

export class CodicoCodeLensProvider implements vscode.CodeLensProvider {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChange.event;

    constructor(private readonly _enabled: () => boolean) {}

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (!this._enabled()) { return []; }

        const lenses: vscode.CodeLens[] = [];

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i).text;
            if (!isFunctionLine(line)) { continue; }

            const range = new vscode.Range(i, 0, i, line.length);

            lenses.push(new vscode.CodeLens(range, {
                title: '$(lightbulb) Explain',
                command: 'codico.codeLensExplain',
                arguments: [document.uri, i],
                tooltip: 'Explain this function with Codico',
            }));

            lenses.push(new vscode.CodeLens(range, {
                title: '$(wrench) Fix',
                command: 'codico.codeLensFix',
                arguments: [document.uri, i],
                tooltip: 'Fix issues in this function with Codico',
            }));
        }

        return lenses;
    }

    refresh(): void { this._onDidChange.fire(); }
}

/** Register the CodeLens provider + commands. */
export function registerCodeLens(
    context: vscode.ExtensionContext,
    sendMessage: (text: string) => Promise<void>
): void {
    const isEnabled = (): boolean =>
        vscode.workspace.getConfiguration('codico').get<boolean>('codeLensEnabled', true);

    const lensProvider = new CodicoCodeLensProvider(isEnabled);

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ pattern: '**' }, lensProvider),

        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('codico.codeLensEnabled')) {
                lensProvider.refresh();
            }
        }),

        vscode.commands.registerCommand(
            'codico.codeLensExplain',
            async (uri: vscode.Uri, line: number) => {
                const doc = await vscode.workspace.openTextDocument(uri);
                const body = extractFunctionBody(doc, line);
                const relPath = vscode.workspace.asRelativePath(uri);
                const prompt =
                    `Explain the following function from \`${relPath}\` clearly and step by step.\n` +
                    `Describe what it does, its parameters, return value, and any important patterns or edge cases.\n\n` +
                    `\`\`\`${doc.languageId}\n${body}\n\`\`\``;
                await sendMessage(prompt);
            }
        ),

        vscode.commands.registerCommand(
            'codico.codeLensFix',
            async (uri: vscode.Uri, line: number) => {
                const doc = await vscode.workspace.openTextDocument(uri);
                const body = extractFunctionBody(doc, line);
                const relPath = vscode.workspace.asRelativePath(uri);

                // Collect diagnostics scoped to this function's range
                const endLine = line + body.split('\n').length - 1;
                const fnRange = new vscode.Range(line, 0, endLine, 0);
                const diags = vscode.languages.getDiagnostics(uri).filter(d =>
                    (d.severity === vscode.DiagnosticSeverity.Error ||
                     d.severity === vscode.DiagnosticSeverity.Warning) &&
                    fnRange.intersection(d.range) !== undefined
                );

                let diagBlock = '';
                if (diags.length > 0) {
                    diagBlock =
                        `Diagnostics in this function:\n` +
                        diags.map(d =>
                            `  Line ${d.range.start.line + 1} [${d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning'}]: ${d.message}`
                        ).join('\n') + '\n\n';
                }

                const prompt =
                    `Fix all bugs, errors, and issues in the following function from \`${relPath}\`.\n` +
                    `Explain each fix you make and return the corrected function.\n\n` +
                    `${diagBlock}` +
                    `\`\`\`${doc.languageId}\n${body}\n\`\`\``;
                await sendMessage(prompt);
            }
        )
    );
}
