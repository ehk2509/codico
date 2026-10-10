import * as vscode from 'vscode';
import { OutlineSymbol } from './fileReadWindow';

/** Symbols of a file from VS Code's language features (empty when none answer in time). */
export async function fileOutlineSymbols(uri: vscode.Uri, timeoutMs = 2000): Promise<OutlineSymbol[]> {
    const found = await Promise.race([
        Promise.resolve(vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', uri))
            .catch(() => undefined),
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), timeoutMs)),
    ]);
    const out: OutlineSymbol[] = [];
    const walk = (items: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[], depth: number): void => {
        for (const item of items) {
            const range = 'range' in item ? item.range : item.location.range;
            out.push({ name: item.name, kind: vscode.SymbolKind[item.kind].toLowerCase(), startLine: range.start.line + 1, endLine: range.end.line + 1, depth });
            // Two levels: classes and their members, functions and their inner functions
            if (depth < 1 && 'children' in item && item.children.length) { walk(item.children, depth + 1); }
        }
    };
    walk(found ?? [], 0);
    return out.sort((a, b) => a.startLine - b.startLine || a.depth - b.depth);
}
