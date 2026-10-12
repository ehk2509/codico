/**
 * Local code search: a ranked, symbol-aware index of a repository that needs no API key and
 * sends nothing anywhere. It answers "where is this handled?" in one call, where plain text
 * search needs the exact words and several tries.
 *
 * - Files are cut into chunks at symbol boundaries (a function or class starts a chunk), not
 *   at fixed line counts, so a result is a whole definition.
 * - Ranking is BM25 over identifier parts ("autoCompactThreshold" matches "compact threshold"),
 *   with more weight for the chunk that defines a symbol and for the file's path.
 * - Imports are recorded, so a result can say which files use it.
 *
 * This module is the engine: no file access, no VS Code.
 */

export interface CodeSymbol {
    name: string;
    kind: string;
    /** 0-based line of the definition. */
    line: number;
}

/** Evidence from outside the index that a place in a file is relevant: a language server's symbol, an embeddings match. */
export interface CodeBoost {
    file: string;
    /** 1-based line the evidence points at. */
    line: number;
    /** Last line, when the evidence is about a range: every chunk the range touches is lifted. */
    toLine?: number;
    /** Share of the best lexical score to add (0.5 lifts a chunk halfway to the top). */
    weight: number;
    /** A symbol known to be defined there, shown with the result. */
    symbol?: string;
}

export interface CodeHit {
    file: string;
    /** 1-based, inclusive. */
    startLine: number;
    endLine: number;
    score: number;
    /** Symbols defined in the chunk. */
    symbols: string[];
    /** The query's terms found in the chunk, as written in the query. */
    matched: string[];
}

// ── Words ────────────────────────────────────────────────────────────────────

/** Too common in code or in questions to tell chunks apart. */
const STOP = new Set(('the a an and or of to in is it its for on with as by at be been being this that these those from not no are was were will would can could should may might must ' +
    'if else then than so such too very much many more most some any each every all both either neither only just also even still yet again once ' +
    'has have had having do does did doing done am i we you they he she them us our your their my me who whom whose what which when where why how ' +
    'into onto out up down over under about after before during while until since through between against without within across along ' +
    'gets got get getting set make makes made take takes took put puts let lets want wants need needs use uses used using one two ' +
    'thing things way ways there here now long big small little lot kind sort case cases place places sure ' +
    'return const let var function class def import export new null true false undefined void public private static async await find code file files').split(' '));

/** "compaction", "compacted", "compacts" and "compact" are one word for search. */
export function stem(word: string): string {
    for (const suffix of ['ations', 'ation', 'ions', 'ion', 'ings', 'ing', 'ies', 'ed', 'es', 's']) {
        // "class", "status", "analysis" end in s without being plurals
        if (suffix === 's' && /(?:ss|us|is)$/.test(word)) { continue; }
        if (word.length - suffix.length >= 4 && word.endsWith(suffix)) {
            const base = word.slice(0, -suffix.length);
            return suffix === 'ies' ? `${base}y` : base;
        }
    }
    return word;
}

/**
 * The search terms of a text: each identifier in its parts ("autoCompactThreshold" → "auto",
 * "compact", "threshold"), lower-cased and stemmed. Whole identifiers are not kept as terms:
 * on a large repository they are a long tail of one-off entries that costs more memory than
 * the parts, and a chunk that has all the parts ranks first anyway.
 */
export function tokenize(text: string): string[] {
    const out: string[] = [];
    for (const word of text.match(/[A-Za-z_][A-Za-z0-9_]*|\d{2,}/g) ?? []) {
        const parts = word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[\s_]+/).filter(Boolean);
        for (const part of parts) {
            const lower = part.toLowerCase();
            if (lower.length < 2 || STOP.has(lower)) { continue; }
            out.push(stem(lower));
        }
    }
    return out;
}

// ── Symbols and imports ──────────────────────────────────────────────────────

type SymbolRule = [RegExp, string];
const JS_RULES: SymbolRule[] = [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function(?:\s*\*\s*|\s+)([A-Za-z_$][\w$]*)/, 'function'],
    [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/, 'type'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, 'function'],
    [/^(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/, 'constant'],
    [/^\s{2,8}(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{;]+)?\{\s*$/, 'method'],
    [/^\s*var\s+([A-Za-z_$][\w$]*)\s*=\s*function\b/, 'function'],
];
const RULES: Record<string, SymbolRule[]> = {
    js: JS_RULES, jsx: JS_RULES, ts: JS_RULES, tsx: JS_RULES, mjs: JS_RULES, cjs: JS_RULES,
    py: [[/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'function'], [/^\s*class\s+([A-Za-z_]\w*)/, 'class'], [/^([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/, 'constant']],
    go: [[/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'function'], [/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, 'type']],
    rs: [[/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, 'function'], [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|mod)\s+([A-Za-z_]\w*)/, 'type'], [/^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_]\w*)/, 'impl']],
    java: [[/^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, 'class'], [/^\s*(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)+[\w<>\[\], ]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:throws [\w., ]+)?\{/, 'method']],
    rb: [[/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/, 'function'], [/^\s*(?:class|module)\s+([A-Z]\w*)/, 'class']],
    php: [[/^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?([A-Za-z_]\w*)/, 'function'], [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+([A-Za-z_]\w*)/, 'class']],
    c: [[/^[A-Za-z_][\w\s*]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/, 'function'], [/^\s*(?:typedef\s+)?(?:struct|enum|union)\s+([A-Za-z_]\w*)/, 'type']],
};
RULES.kt = RULES.cs = RULES.scala = RULES.java;
RULES.h = RULES.cpp = RULES.cc = RULES.hpp = RULES.c;
/** Words that look like a method name to the patterns above but are control flow. */
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'else', 'do', 'try', 'new', 'await', 'typeof']);

/** The definitions in a file, found by pattern: good enough to rank and to cut chunks, with no language server. */
export function extractSymbols(lines: string[], ext: string): CodeSymbol[] {
    const rules = RULES[ext.replace(/^\./, '').toLowerCase()];
    if (!rules) { return []; }
    const symbols: CodeSymbol[] = [];
    lines.forEach((line, index) => {
        if (line.length > 400) { return; } // minified or generated
        for (const [pattern, kind] of rules) {
            const name = pattern.exec(line)?.[1];
            if (name && !NOT_A_NAME.has(name)) { symbols.push({ name, kind, line: index }); break; }
        }
    });
    return symbols;
}

/** The modules a file imports, as written. The index resolves them to files. */
export function extractImports(text: string, ext: string): string[] {
    const kind = ext.replace(/^\./, '').toLowerCase();
    const found: string[] = [];
    if (/^(?:js|jsx|ts|tsx|mjs|cjs)$/.test(kind)) {
        for (const match of text.matchAll(/(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*|^\s*import\s+)['"]([^'"\n]+)['"]/gm)) { found.push(match[1]); }
    } else if (kind === 'py') {
        for (const match of text.matchAll(/^\s*from\s+(\.*[\w.]+|\.+)\s+import\b/gm)) { found.push(match[1]); }
        for (const match of text.matchAll(/^\s*import\s+([\w.]+)/gm)) { found.push(match[1]); }
    } else if (/^(?:java|kt|scala)$/.test(kind)) {
        for (const match of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)/gm)) { found.push(match[1]); }
    } else if (kind === 'rs') {
        for (const match of text.matchAll(/^\s*(?:pub\s+)?use\s+((?:crate|super|self)(?:::\w+)+)/gm)) { found.push(match[1]); }
        for (const match of text.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)) { found.push(`self::${match[1]}`); }
    } else if (kind === 'go') {
        for (const match of text.matchAll(/^\s*(?:import\s+)?(?:[\w.]+\s+)?"([\w./-]+\/[\w./-]+)"\s*$/gm)) { found.push(match[1]); }
    }
    return [...new Set(found)];
}

// ── Chunks ───────────────────────────────────────────────────────────────────

export interface Chunk { start: number; end: number; symbols: string[] }

/**
 * Cuts a file into chunks that begin where a top-level definition begins. Small neighbours
 * are joined and long bodies are split, so chunks stay between about 15 and 80 lines.
 * `start` and `end` are 0-based, `end` exclusive.
 */
export function chunkBySymbols(lines: string[], symbols: CodeSymbol[], maxLines = 80, minLines = 15): Chunk[] {
    const total = lines.length;
    if (total === 0) { return []; }
    // A definition starts a chunk when it is not nested deeply (methods of a class stay with it unless it is long)
    const indentOf = (line: string): number => /^\s*/.exec(line)![0].replace(/\t/g, '    ').length;
    const starts = [0];
    for (const symbol of symbols) {
        if (indentOf(lines[symbol.line]) > 4) { continue; }
        // Comments and decorators directly above belong to the definition
        let at = symbol.line;
        while (at > 0 && /^\s*(?:\/\/|\/\*|\*|#(?!!)|@\w|""")/.test(lines[at - 1])) { at--; }
        if (at - starts[starts.length - 1] >= minLines) { starts.push(at); }
    }
    const chunks: Chunk[] = [];
    starts.forEach((start, index) => {
        const stop = index + 1 < starts.length ? starts[index + 1] : total;
        for (let from = start; from < stop; from += maxLines) {
            const to = Math.min(stop, from + maxLines);
            // A short tail joins the piece before it
            if (to - from < minLines && chunks.length > 0 && from > start) { chunks[chunks.length - 1].end = to; continue; }
            chunks.push({ start: from, end: to, symbols: [] });
        }
    });
    for (const symbol of symbols) {
        const chunk = chunks.find(candidate => symbol.line >= candidate.start && symbol.line < candidate.end);
        if (chunk && !chunk.symbols.includes(symbol.name)) { chunk.symbols.push(symbol.name); }
    }
    return chunks;
}

// ── Index ────────────────────────────────────────────────────────────────────

const K1 = 1.2;
const B = 0.75;
/** A term in the name of a symbol the chunk defines counts this many times. */
const DEFINITION_WEIGHT = 4;
/** A term in the file's path counts this many times. */
const PATH_WEIGHT = 2;
const DOC_WORDS = new Set(['doc', 'docs', 'document', 'documentation', 'readme', 'changelog', 'guide', 'tutorial', 'note'].map(stem));
const TEST_WORDS = new Set(['test', 'tests', 'spec', 'fixture', 'mock', 'coverage'].map(stem));
const DOC_FILE_RE = /\.(?:md|mdx|markdown|rst|adoc|txt)$|(?:^|\/)(?:docs?|documentation)\//i;
const TEST_FILE_RE = /(?:^|\/)(?:tests?|__tests__|spec|specs|e2e|fixtures?|__mocks__)\/|[._-](?:test|spec)\.[a-z]+$|_test\.[a-z]+$/i;
const DATA_FILE_RE = /\.(?:json|ya?ml|toml|ini|csv|xml|html?|css|scss|less|svg)$/i;

/** How much a file's kind counts for a question: source first, then data and markup, tests, documentation. */
function fileWeight(file: string, wantsDocs: boolean, wantsTests: boolean): number {
    if (DOC_FILE_RE.test(file)) { return wantsDocs ? 1 : 0.35; }
    if (TEST_FILE_RE.test(file)) { return wantsTests ? 1 : 0.6; }
    if (DATA_FILE_RE.test(file)) { return 0.7; }
    return 1;
}

/** A posting is chunk id × this + count; counts above it are capped (they no longer change the ranking). */
const COUNT_RANGE = 1024;
const IMPORT_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '.py', '/__init__.py'];

interface Doc { file: string; start: number; end: number; symbols: string[]; length: number; alive: boolean }

export class CodeIndex {
    private readonly _docs: Doc[] = [];
    /** term → one number per chunk that has it: the chunk's id and the term's count there, packed (half the memory of pairs). */
    private readonly _postings = new Map<string, number[]>();
    private readonly _docsOfFile = new Map<string, number[]>();
    private readonly _importsOfFile = new Map<string, string[]>();
    private _alive = 0;
    private _totalLength = 0;

    get fileCount(): number { return this._docsOfFile.size; }
    get chunkCount(): number { return this._alive; }
    /** Share of entries that belong to removed or replaced files: high means a rebuild would free memory. */
    get staleShare(): number { return this._docs.length === 0 ? 0 : 1 - this._alive / this._docs.length; }
    has(file: string): boolean { return this._docsOfFile.has(file); }

    /** Adds a file, replacing what the index had for it. `file` is a workspace-relative path with forward slashes. */
    addFile(file: string, text: string): void {
        this.removeFile(file);
        const ext = /\.([A-Za-z0-9]+)$/.exec(file)?.[1] ?? '';
        const lines = text.split('\n');
        const pathTerms = tokenize(file.replace(/\.[A-Za-z0-9]+$/, ''));
        const ids: number[] = [];
        for (const chunk of chunkBySymbols(lines, extractSymbols(lines, ext))) {
            const counts = new Map<string, number>();
            const add = (term: string, weight: number): void => { counts.set(term, (counts.get(term) ?? 0) + weight); };
            for (const term of tokenize(lines.slice(chunk.start, chunk.end).join('\n'))) { add(term, 1); }
            for (const symbol of chunk.symbols) { for (const term of tokenize(symbol)) { add(term, DEFINITION_WEIGHT); } }
            for (const term of pathTerms) { add(term, PATH_WEIGHT); }
            let length = 0;
            const id = this._docs.length;
            for (const [term, count] of counts) {
                length += count;
                let list = this._postings.get(term);
                if (!list) { list = []; this._postings.set(term, list); }
                list.push(id * COUNT_RANGE + Math.min(Math.round(count), COUNT_RANGE - 1));
            }
            this._docs.push({ file, start: chunk.start, end: chunk.end, symbols: chunk.symbols, length, alive: true });
            this._alive++;
            this._totalLength += length;
            ids.push(id);
        }
        this._docsOfFile.set(file, ids);
        this._importsOfFile.set(file, extractImports(text, ext));
    }

    removeFile(file: string): void {
        for (const id of this._docsOfFile.get(file) ?? []) {
            const doc = this._docs[id];
            if (doc.alive) { doc.alive = false; this._alive--; this._totalLength -= doc.length; }
        }
        this._docsOfFile.delete(file);
        this._importsOfFile.delete(file);
    }

    /**
     * The chunks that best match a description or a set of identifiers, best first.
     * @param pathPrefix only files under this folder (or this file)
     */
    search(query: string, limit = 8, pathPrefix = '', boosts: CodeBoost[] = []): CodeHit[] {
        const terms = [...new Set(tokenize(query))];
        if ((terms.length === 0 && boosts.length === 0) || this._alive === 0) { return []; }
        const average = this._totalLength / this._alive;
        const scores = new Map<number, number>();
        const hits = new Map<number, Set<string>>();
        for (const term of terms) {
            const list = this._postings.get(term);
            if (!list) { continue; }
            let containing = 0;
            for (const packed of list) { if (this._docs[Math.floor(packed / COUNT_RANGE)].alive) { containing++; } }
            if (containing === 0) { continue; }
            const idf = Math.log(1 + (this._alive - containing + 0.5) / (containing + 0.5));
            for (const packed of list) {
                const id = Math.floor(packed / COUNT_RANGE);
                const doc = this._docs[id];
                if (!doc.alive || (pathPrefix && !doc.file.startsWith(pathPrefix))) { continue; }
                const count = packed % COUNT_RANGE;
                const score = idf * (count * (K1 + 1)) / (count + K1 * (1 - B + B * doc.length / average));
                scores.set(id, (scores.get(id) ?? 0) + score);
                let matched = hits.get(id);
                if (!matched) { matched = new Set(); hits.set(id, matched); }
                matched.add(term);
            }
        }
        // A chunk that has more of the query's terms beats one that repeats a single term
        const lexical = new Map<number, number>();
        for (const [id, score] of scores) { lexical.set(id, score * (0.5 + 0.5 * hits.get(id)!.size / Math.max(1, terms.length))); }
        // Evidence from outside the index (a language server's symbols, an embeddings search) lifts the chunk
        // it points at, in proportion to the best lexical score, and can bring in a chunk no word matched
        const best = Math.max(1, ...lexical.values());
        const extraSymbols = new Map<number, string[]>();
        for (const boost of boosts) {
            if (pathPrefix && !boost.file.startsWith(pathPrefix)) { continue; }
            const from = boost.line - 1;
            const to = (boost.toLine ?? boost.line) - 1;
            for (const id of this._docsOfFile.get(boost.file) ?? []) {
                const doc = this._docs[id];
                if (!doc.alive || doc.start > to || doc.end <= from) { continue; }
                lexical.set(id, (lexical.get(id) ?? 0) + boost.weight * best);
                if (boost.symbol) { extraSymbols.set(id, [...(extraSymbols.get(id) ?? []), boost.symbol]); }
            }
        }
        // A question about code is answered by code: documentation and tests repeat its words in prose and
        // would otherwise come first. They keep their place when the question is about them.
        const wantsDocs = terms.some(term => DOC_WORDS.has(term));
        const wantsTests = terms.some(term => TEST_WORDS.has(term));
        const ranked = [...lexical.entries()]
            .map(([id, score]) => ({ id, score: score * fileWeight(this._docs[id].file, wantsDocs, wantsTests) }))
            .sort((a, b) => b.score - a.score || a.id - b.id);
        // At most three chunks of one file, so one large file cannot fill the list
        const perFile = new Map<string, number>();
        const out: CodeHit[] = [];
        for (const { id, score } of ranked) {
            const doc = this._docs[id];
            const taken = perFile.get(doc.file) ?? 0;
            if (taken >= 3) { continue; }
            perFile.set(doc.file, taken + 1);
            const symbols = [...new Set([...doc.symbols, ...(extraSymbols.get(id) ?? [])])];
            out.push({ file: doc.file, startLine: doc.start + 1, endLine: doc.end, score, symbols, matched: [...(hits.get(id) ?? [])] });
            if (out.length >= limit) { break; }
        }
        return out;
    }

    /**
     * The indexed files that import this one: relative and aliased imports of JavaScript and
     * TypeScript, Python modules, Java and Kotlin classes, Rust modules and Go packages.
     */
    importersOf(file: string): string[] {
        const result: string[] = [];
        const fileDir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
        for (const [from, specifiers] of this._importsOfFile) {
            if (from === file) { continue; }
            const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
            const go = from.endsWith('.go');
            if (specifiers.some(specifier => go ? goPackageIs(specifier, fileDir, dir) && file.endsWith('.go') : this._resolve(from, dir, specifier) === file)) { result.push(from); }
        }
        return result.sort();
    }

    private _first(candidates: string[]): string | undefined {
        for (const candidate of candidates) {
            for (const extension of IMPORT_EXTENSIONS) { if (this._docsOfFile.has(candidate + extension)) { return candidate + extension; } }
        }
        return undefined;
    }

    /** A file whose path ends with the given path (any source root): how a Java class or an aliased module is found. */
    private _bySuffix(suffix: string, extensions: string[]): string | undefined {
        for (const extension of extensions) {
            const wanted = suffix + extension;
            if (this._docsOfFile.has(wanted)) { return wanted; }
            for (const file of this._docsOfFile.keys()) { if (file.endsWith(`/${wanted}`)) { return file; } }
        }
        return undefined;
    }

    private _resolve(from: string, dir: string, specifier: string): string | undefined {
        const kind = /\.([A-Za-z0-9]+)$/.exec(from)?.[1].toLowerCase() ?? '';
        if (/^(?:java|kt|scala)$/.test(kind)) {
            // com.acme.orders.Order → …/com/acme/orders/Order.java, under whatever source root
            return this._bySuffix(specifier.replace(/\./g, '/'), ['.java', '.kt', '.scala']);
        }
        if (kind === 'rs') {
            const parts = specifier.split('::');
            const head = parts.shift();
            const start = head === 'crate' ? (from.startsWith('src/') || !from.includes('/src/') ? 'src' : from.slice(0, from.indexOf('/src/') + 4))
                : head === 'super' ? dir.split('/').slice(0, -1).join('/') : dir;
            // The last segments may be items inside the module: try the longest module path first
            for (let n = parts.length; n >= 1; n--) {
                const base = [start, ...parts.slice(0, n)].filter(Boolean).join('/');
                for (const candidate of [`${base}.rs`, `${base}/mod.rs`]) { if (this._docsOfFile.has(candidate)) { return candidate; } }
            }
            return undefined;
        }
        if (kind === 'py' && /^[A-Za-z_][\w.]*$/.test(specifier)) {
            // An absolute module: a.b.c is a/b/c.py from the root or a source folder
            const modulePath = specifier.replace(/\./g, '/');
            return this._first([modulePath, `src/${modulePath}`]) ?? this._bySuffix(modulePath, ['.py', '/__init__.py']);
        }
        let base: string;
        if (/^\.+[\w.]*$/.test(specifier) && !specifier.includes('/')) {
            // Python: ".x.y" is x/y next to the file, each extra dot one folder up
            const dots = /^\.+/.exec(specifier)![0].length;
            base = [...dir.split('/').filter(Boolean).slice(0, dots > 1 ? -(dots - 1) : undefined), ...specifier.slice(dots).split('.').filter(Boolean)].join('/');
        } else if (specifier.startsWith('.')) {
            const parts = dir.split('/').filter(Boolean);
            for (const piece of specifier.split('/')) {
                if (piece === '..') { parts.pop(); } else if (piece !== '.' && piece !== '') { parts.push(piece); }
            }
            base = parts.join('/');
        } else if (/^(?:@|~|#)\//.test(specifier) || specifier.startsWith('src/')) {
            // A path alias ("@/lib/x", "~/lib/x") or a root-relative import: from the root or from src
            const rest = specifier.replace(/^(?:@|~|#)\//, '');
            return this._first([rest, `src/${rest}`, rest.replace(/\.(?:js|jsx|mjs|cjs)$/, ''), `src/${rest.replace(/\.(?:js|jsx|mjs|cjs)$/, '')}`]);
        } else { return undefined; }
        // "./a.js" in TypeScript source means a.ts
        return this._first([base, base.replace(/\.(?:js|jsx|mjs|cjs)$/, '')]);
    }
}

/** A Go import names a package, which is a folder: "example.com/app/internal/store" is the folder internal/store. */
function goPackageIs(specifier: string, fileDir: string, importerDir: string): boolean {
    if (!fileDir || fileDir === importerDir) { return false; }
    return specifier === fileDir || specifier.endsWith(`/${fileDir}`);
}

// ── The tool's answer ────────────────────────────────────────────────────────

/** The lines of a chunk worth showing: where the symbols are defined and where most query terms meet. */
export function bestLines(lines: string[], hit: CodeHit, queryTerms: string[], max = 4): number[] {
    const wanted = new Set(queryTerms);
    const scored: Array<{ line: number; score: number }> = [];
    for (let i = hit.startLine - 1; i < Math.min(hit.endLine, lines.length); i++) {
        const text = lines[i];
        if (!text.trim() || text.length > 300) { continue; }
        const terms = new Set(tokenize(text));
        let score = 0;
        for (const term of terms) { if (wanted.has(term)) { score++; } }
        if (hit.symbols.some(symbol => new RegExp(`\\b${symbol.replace(/[$]/g, '\\$')}\\b`).test(text) && /\b(?:function|class|def|fn|func|interface|type|enum|const|let|var|struct|impl|module|trait)\b/.test(text))) { score += 1.5; }
        if (score > 0) { scored.push({ line: i, score }); }
    }
    return scored.sort((a, b) => b.score - a.score || a.line - b.line).slice(0, max).map(entry => entry.line).sort((a, b) => a - b);
}

export interface RenderedHit extends CodeHit { lines: Array<{ number: number; text: string }>; usedBy: string[] }

/** The result text of the search_code tool. */
export function renderSearchResults(query: string, hits: RenderedHit[], files: number, note = ''): string {
    if (hits.length === 0) {
        return `[search_code: ${query}] No match in ${files.toLocaleString('en-US')} indexed files${note}. Try other words for the same idea, or search_files for exact text.`;
    }
    const blocks = hits.map((hit, index) => {
        const defines = hit.symbols.length > 0 ? `  defines: ${hit.symbols.slice(0, 6).join(', ')}${hit.symbols.length > 6 ? ', …' : ''}` : '';
        const lines = hit.lines.map(line => `   ${line.number}\t${line.text.length > 200 ? `${line.text.slice(0, 200)}…` : line.text}`);
        const usedBy = hit.usedBy.length > 0 ? [`   used by: ${hit.usedBy.slice(0, 5).join(', ')}${hit.usedBy.length > 5 ? ` (+${hit.usedBy.length - 5} more)` : ''}`] : [];
        return [`${index + 1}. ${hit.file}:${hit.startLine}-${hit.endLine}${defines}`, ...lines, ...usedBy].join('\n');
    });
    return `[search_code: ${query}] ${hits.length} best match${hits.length === 1 ? '' : 'es'} in ${files.toLocaleString('en-US')} indexed files${note}, best first. ` +
        `Each shows a few lines only: read a range with read_file before relying on it.\n\n${blocks.join('\n\n')}`;
}
