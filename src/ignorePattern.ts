/** Shared ignore-pattern matching for VS Code and Node.js runtimes. */
export interface CompiledRule {
    negate: boolean;
    anchored: boolean;
    re: RegExp;
}

export function globToRegex(glob: string): RegExp { return _globToRegex(glob); }

function _globToRegex(glob: string): RegExp {
    let s = glob.replace(/[.+^$\{\}()|[\]\\]/g, '\\$&');
    s = s.replace(/\*\*/g, '\x00');
    s = s.replace(/\*/g, '[^/]*');
    s = s.replace(/\?/g, '[^/]');
    s = s.replace(/\x00\//g, '(?:.+/)?').replace(/\x00/g, '.*');
    return new RegExp('^' + s + '$', 'i');
}

function _compile(raw: string): CompiledRule | null {
    let line = raw.trim();
    if (!line || line.startsWith('#')) { return null; }

    const negate = line.startsWith('!');
    if (negate) { line = line.slice(1); }
    if (line.endsWith('/')) { line = line.slice(0, -1); }

    const anchored = line.startsWith('/');
    if (anchored) { line = line.slice(1); }

    let re: RegExp;
    if (anchored) {
        const base = _globToRegex(line);
        re = new RegExp(base.source.replace(/\$$/, '(?:\\/.*)?$'), 'i');
    } else {
        re = _globToRegex('**/' + line);
    }
    return { negate, anchored, re };
}


export function compileIgnoreRules(contents: string): CompiledRule[] {
    return contents.split(/\r?\n/).map(_compile).filter((rule): rule is CompiledRule => rule !== null);
}
export function ignoredByRules(rules: readonly CompiledRule[], relative: string): boolean {
    let ignored = false;
    for (const rule of rules) {
        if (rule.re.test(relative)) { ignored = !rule.negate; }
    }
    return ignored;
}
