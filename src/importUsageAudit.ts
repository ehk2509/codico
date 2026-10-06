/**
 * Lightweight source-level integration check for local named imports.
 * The VSIX cannot rely on the TypeScript compiler (a devDependency) at runtime.
 * These findings are not proof of correctness: they are specific missing
 * wiring evidence for the agent to resolve before claiming success.
 */
export function buildImportUsageAudit(source: string): string {
    const imports = /\bimport\s+(?!type\b)\{([^}]+)\}\s+from\s+['"](\.[^'"]+)['"]\s*;?/g;
    const unused: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = imports.exec(source)) !== null) {
        const rest = source.slice(0, match.index) + source.slice(match.index + match[0].length);
        const identifiers = match[1].split(',').map(part => part.trim());
        for (const item of identifiers) {
            if (!item || item.startsWith('type ')) { continue; }
            const alias = /^(?:[A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(item);
            if (!alias) { continue; }
            const name = alias[1] || item;
            const used = new RegExp('\\b' + name.replace(/[$]/g, '\\$&') + '\\b').test(rest);
            if (!used) { unused.push(name + ' from ' + match[2]); }
        }
    }
    if (!unused.length) { return ''; }
    return '\n\n[Post-edit integration audit]\n' +
        'These local imports are not referenced outside their import statement:\n' +
        unused.slice(0, 8).map(item => '- ' + item).join('\n') + '\n' +
        'If a helper was added to implement this task, call it from the actual behavior path (and verify the result), ' +
        'or remove the unused import. An import alone is not integration. Do not claim completion while these remain.';
}
