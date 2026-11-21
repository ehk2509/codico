import { invalidNativeCallResult, NativeToolCall, nativeToolCallToToolCall, nativeToolSchema } from './nativeTools';
import { parseToolBody, scanToolFences, ToolCall, unreadableFenceResult } from './toolParser';

/**
 * Tool calls written in the XML syntax models of the Qwen family are trained on, which they fall back to
 * in Codico's text tool format (seen with Qwen3 30B A3B on Ollama):
 *
 *     <tool_call>
 *     <function=search_files>
 *     <parameter=pattern>
 *     toLocaleString
 *     </parameter>
 *     </function>
 *     </tool_call>
 *
 * and the JSON form of the same wrapper (`<tool_call>{"name": …, "arguments": {…}}</tool_call>`). They are
 * read as the native call they stand for, so they run instead of showing as text. A call is only read at
 * the start of a line, so a reply that mentions `<tool_call>` in a sentence is left alone.
 */

export interface XmlToolCall {
    /** Index of the opening tag. */
    start: number;
    /** Index just past the closing tag. */
    end: number;
    call: NativeToolCall;
}

export interface XmlToolScan {
    calls: XmlToolCall[];
    /** Start of a call that has not been closed yet (still streaming), or -1. */
    unclosedStart: number;
}

const OPEN_RE = /(^|\n)[ \t]*(<tool_call>|<function=([\w.-]+)>)/g;
const OPENERS = ['<tool_call>', '<function='];

/**
 * Finds the XML tool calls in model output, from `from`. A call still open at the end is reported as
 * unclosed, unless `final` is set because the stream ended: a call whose last parameter is complete
 * is then taken as it is (models often stop without the closing tags).
 */
export function scanXmlToolCalls(text: string, from = 0, final = false): XmlToolScan {
    const calls: XmlToolCall[] = [];
    let pos = from;
    for (;;) {
        OPEN_RE.lastIndex = pos;
        const open = OPEN_RE.exec(text);
        if (!open) { return { calls, unclosedStart: -1 }; }
        const start = open.index + open[0].length - open[2].length;
        const bodyStart = start + open[2].length;
        const wrapped = open[2] === '<tool_call>';
        const closeTag = wrapped ? '</tool_call>' : '</function>';
        const close = text.indexOf(closeTag, bodyStart);
        let end: number;
        let inner: string;
        if (close === -1) {
            if (!final) { return { calls, unclosedStart: start }; }
            end = text.length;
            inner = text.slice(bodyStart);
        } else {
            end = close + closeTag.length;
            inner = text.slice(bodyStart, close);
        }
        const call = wrapped ? readWrapped(inner) : readFunction(open[3], inner);
        if (call) { calls.push({ start, end, call }); }
        pos = call ? end : bodyStart;
    }
}

/**
 * How much of the end of `text` to hold back from display: the start of a line that may still become
 * an opening tag (`<tool_c`), so the raw tag is not shown before it is known to be a call.
 */
export function partialXmlOpenerLength(text: string): number {
    const m = /(?:^|\n)[ \t]*(<[\w=]*)$/.exec(text);
    if (!m) { return 0; }
    return OPENERS.some(opener => opener.startsWith(m[1]) || m[1].startsWith(opener)) ? m[1].length : 0;
}

/** The inside of `<tool_call>…</tool_call>`: a `<function=…>` block or a JSON object. */
function readWrapped(inner: string): NativeToolCall | null {
    const fn = /<function=([\w.-]+)>/.exec(inner);
    if (fn) {
        const bodyStart = fn.index + fn[0].length;
        const close = inner.indexOf('</function>', bodyStart);
        return readFunction(fn[1], inner.slice(bodyStart, close === -1 ? undefined : close));
    }
    try {
        const json = JSON.parse(inner.trim()) as { name?: unknown; arguments?: unknown; parameters?: unknown };
        let args = json.arguments ?? json.parameters ?? {};
        if (typeof args === 'string') { args = JSON.parse(args); }
        if (typeof json.name !== 'string' || typeof args !== 'object' || args === null || Array.isArray(args)) { return null; }
        return { name: json.name, arguments: args as Record<string, unknown> };
    } catch {
        return null;
    }
}

/** The parameters of a `<function=name>` block, typed by the tool's schema. */
function readFunction(name: string, body: string): NativeToolCall {
    const args: Record<string, unknown> = {};
    const properties = (nativeToolSchema(name)?.properties ?? {}) as Record<string, { type?: unknown } | undefined>;
    // A value runs to its closing tag, or to the next parameter when the model left the closing tag out
    const parts = body.split(/<parameter=([\w.-]+)>/);
    for (let i = 1; i < parts.length; i += 2) {
        const key = parts[i];
        const raw = parts[i + 1]
            .replace(/<\/parameter>[\s\S]*$/, '')
            .replace(/^\r?\n/, '')
            .replace(/\r?\n$/, '');
        args[key] = typed(raw, properties[key]?.type);
    }
    return { name, arguments: args };
}

function typed(raw: string, type: unknown): unknown {
    const text = raw.trim();
    switch (type) {
        case 'boolean':
            return /^true$/i.test(text) ? true : /^false$/i.test(text) ? false : raw;
        case 'integer':
        case 'number':
            return /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : raw;
        case 'array':
        case 'object':
            // Not JSON: a list is one item per line ("- " bullets allowed)
            try { return JSON.parse(text); } catch { return type === 'array' ? text.split('\n').map(line => line.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean) : raw; }
        default:
            return raw;
    }
}

/** A tool call found in model output, either kind; a string is the error said back for a block that could not be used. */
export interface WrittenToolCall { start: number; end: number; tool: ToolCall | string }

/**
 * The tool calls written in the text from `from`, fenced blocks and XML calls, in the order written.
 * What is inside the other kind (a fence in a parameter, a tag in a written file) is content, as is
 * anything after a call of either kind that is still open.
 */
export function writtenToolCalls(text: string, from = 0, final = false): WrittenToolCall[] {
    const scan = scanToolFences(text, from, final);
    const xml = scanXmlToolCalls(text, from, final);
    const inside = (at: number, outer: Array<{ start: number; end: number }>, openAt: number) =>
        outer.some(o => at > o.start && at < o.end) || (openAt !== -1 && at > openAt);
    return [
        ...scan.fences.filter(f => !inside(f.start, xml.calls, xml.unclosedStart))
            .map(f => ({ start: f.start, end: f.end, tool: parseToolBody(f.type, f.body)[0] ?? unreadableFenceResult(f.type) })),
        ...xml.calls.filter(x => !inside(x.start, scan.fences, scan.unclosedStart))
            .map(x => ({ start: x.start, end: x.end, tool: nativeToolCallToToolCall(x.call) ?? invalidNativeCallResult(x.call) })),
    ].sort((a, b) => a.start - b.start);
}

/** Where display must stop: before an XML call still open, or a line that may become one (`<tool_c`). */
export function xmlDisplayLimit(text: string, from: number): number {
    const open = scanXmlToolCalls(text, from, false).unclosedStart;
    return Math.min(open === -1 ? text.length : open, text.length - partialXmlOpenerLength(text.slice(from)));
}
