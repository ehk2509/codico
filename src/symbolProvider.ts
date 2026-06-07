/**
 * Symbol-aware LSP context
 *
 * Provides two things:
 *  1. `buildSymbolContext(document, position)` — reads LSP data for the symbol
 *     under cursor (definition location, type via hover, references) and returns
 *     a formatted context block injected into _buildContextPreamble.
 *
 *  2. `resolveSymbol(query, document?)` — look up a symbol by name across the
 *     workspace using vscode.executeWorkspaceSymbolProvider.  Used by the AI
 *     `lsp_symbol` tool.
 */

import * as vscode from 'vscode';

// ── Types returned to callers ─────────────────────────────────────────────────

export interface SymbolInfo {
    name: string;
    kind: string;
    /** Workspace-relative file path of the definition. */
    definedIn: string;
    /** 1-based line number of the definition. */
    definedAtLine: number;
    /** A short snippet around the definition (≤ 20 lines). */
    definitionSnippet: string;
    /** Plain-text hover / type info. */
    typeInfo: string;
    /** How many references were found (undefined = not counted). */
    referenceCount?: number;
    /** Up to 5 reference locations. */
    references: Array<{ file: string; line: number; preview: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _kindLabel(kind: vscode.SymbolKind): string {
    const map: Partial<Record<vscode.SymbolKind, string>> = {
        [vscode.SymbolKind.File]:          'file',
        [vscode.SymbolKind.Module]:        'module',
        [vscode.SymbolKind.Namespace]:     'namespace',
        [vscode.SymbolKind.Class]:         'class',
        [vscode.SymbolKind.Method]:        'method',
        [vscode.SymbolKind.Property]:      'property',
        [vscode.SymbolKind.Field]:         'field',
        [vscode.SymbolKind.Constructor]:   'constructor',
        [vscode.SymbolKind.Enum]:          'enum',
        [vscode.SymbolKind.Interface]:     'interface',
        [vscode.SymbolKind.Function]:      'function',
        [vscode.SymbolKind.Variable]:      'variable',
        [vscode.SymbolKind.Constant]:      'constant',
        [vscode.SymbolKind.String]:        'string',
        [vscode.SymbolKind.TypeParameter]: 'type parameter',
    };
    return map[kind] ?? 'symbol';
}

async function _snippetAt(location: vscode.Location, halfWindow = 10): Promise<string> {
    try {
        const doc  = await vscode.workspace.openTextDocument(location.uri);
        const line = location.range.start.line;
        const from = Math.max(0, line - 2);
        const to   = Math.min(doc.lineCount - 1, line + halfWindow);
        return doc.getText(new vscode.Range(from, 0, to, 0)).trimEnd();
    } catch { return ''; }
}

function _extractText(hover: vscode.Hover): string {
    return hover.contents
        .map(c => (typeof c === 'string' ? c : c.value))
        .join('\n')
        .trim()
        .slice(0, 400);
}

// ── Symbol context for cursor position ───────────────────────────────────────

/**
 * Build an LSP-powered symbol context block for `position` in `document`.
 * Returns an empty string if no symbol is found or LSP is unavailable.
 */
export async function buildSymbolContext(
    document: vscode.TextDocument,
    position: vscode.Position
): Promise<string> {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) { return ''; }
    const name = document.getText(wordRange);
    if (!name || name.length < 2) { return ''; }

    const parts: string[] = [`[Symbol: \`${name}\`]`];

    // 1. Hover → type info
    try {
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            document.uri,
            position
        );
        if (hovers && hovers.length > 0) {
            const text = _extractText(hovers[0]);
            if (text) { parts.push(`Type info:\n${text}`); }
        }
    } catch { /* LSP unavailable */ }

    // 2. Definition → where it's declared
    try {
        const defs = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
            'vscode.executeDefinitionProvider',
            document.uri,
            position
        );
        const locations: vscode.Location[] = (defs ?? []).map(d =>
            'targetUri' in d
                ? new vscode.Location(d.targetUri, d.targetRange)
                : d as vscode.Location
        );
        if (locations.length > 0) {
            const loc  = locations[0];
            const rel  = vscode.workspace.asRelativePath(loc.uri);
            const line = loc.range.start.line + 1;
            parts.push(`Defined in: ${rel}:${line}`);
            const snippet = await _snippetAt(loc);
            if (snippet) {
                parts.push(`Definition:\n\`\`\`\n${snippet}\n\`\`\``);
            }
        }
    } catch { /* skip */ }

    // 3. References → how widely it's used
    try {
        const refs = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider',
            document.uri,
            position
        );
        if (refs && refs.length > 0) {
            parts.push(`References: ${refs.length} across workspace`);
            const samples: string[] = [];
            let shown = 0;
            for (const ref of refs) {
                if (shown >= 5) { break; }
                const rel  = vscode.workspace.asRelativePath(ref.uri);
                const line = ref.range.start.line + 1;
                try {
                    const d  = await vscode.workspace.openTextDocument(ref.uri);
                    const ln = d.lineAt(ref.range.start.line).text.trim();
                    samples.push(`  ${rel}:${line}  ${ln.slice(0, 100)}`);
                    shown++;
                } catch { samples.push(`  ${rel}:${line}`); shown++; }
            }
            if (samples.length > 0) {
                parts.push(`Sample references:\n${samples.join('\n')}`);
            }
        }
    } catch { /* skip */ }

    return parts.length > 1 ? parts.join('\n\n') : '';
}

// ── Workspace symbol search (used by the lsp_symbol AI tool) ─────────────────

/**
 * Find up to `limit` symbols matching `query` across the entire workspace
 * using the workspace symbol provider (requires a language server).
 */
export async function resolveSymbol(
    query: string,
    limit = 10
): Promise<SymbolInfo[]> {
    let symbols: vscode.SymbolInformation[] = [];
    try {
        const results = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider',
            query
        );
        symbols = (results ?? []).slice(0, limit);
    } catch { return []; }

    const infos: SymbolInfo[] = [];
    for (const sym of symbols) {
        const loc     = sym.location;
        const rel     = vscode.workspace.asRelativePath(loc.uri);
        const defLine = loc.range.start.line + 1;
        const snippet = await _snippetAt(loc, 15);

        let typeInfo = '';
        try {
            const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
                'vscode.executeHoverProvider',
                loc.uri,
                loc.range.start
            );
            if (hovers && hovers.length > 0) {
                typeInfo = _extractText(hovers[0]);
            }
        } catch { /* skip */ }

        infos.push({
            name:              sym.name,
            kind:              _kindLabel(sym.kind),
            definedIn:         rel,
            definedAtLine:     defLine,
            definitionSnippet: snippet,
            typeInfo,
            references:        [],
        });
    }
    return infos;
}
