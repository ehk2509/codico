/** Minimal, dependency-free terminal styling. Honors NO_COLOR, FORCE_COLOR and non-TTY output. */

export interface ColorSupport { enabled: boolean }

export function detectColor(stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
    if ('NO_COLOR' in env && env.NO_COLOR !== '') { return false; }
    if (env.FORCE_COLOR !== undefined) { return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false'; }
    if (env.TERM === 'dumb') { return false; }
    return !!stream.isTTY;
}

const CODES = {
    reset: [0, 0], bold: [1, 22], dim: [2, 22], italic: [3, 23], underline: [4, 24], inverse: [7, 27],
    red: [31, 39], green: [32, 39], yellow: [33, 39], blue: [34, 39], magenta: [35, 39], cyan: [36, 39], gray: [90, 39],
    brightRed: [91, 39], brightGreen: [92, 39], brightYellow: [93, 39], brightBlue: [94, 39], brightMagenta: [95, 39], brightCyan: [96, 39],
    bgRed: [41, 49], bgGreen: [42, 49], bgGray: [100, 49],
} as const;

export type StyleName = keyof typeof CODES;
export type Paint = { [K in StyleName]: (text: string) => string } & { enabled: boolean; accent: (text: string) => string };

export function painter(enabled: boolean): Paint {
    const paint = { enabled } as Paint;
    for (const [name, [open, close]] of Object.entries(CODES) as [StyleName, readonly [number, number]][]) {
        paint[name] = enabled ? (text: string) => `\x1b[${open}m${text}\x1b[${close}m` : (text: string) => text;
    }
    // Codico's accent: a soft blue that reads on dark and light terminals and stays distinct from the
    // cyan used for code. Windows Terminal and VS Code support truecolor without setting COLORTERM.
    const env = process.env;
    const truecolor = enabled && (/truecolor|24bit/i.test(env.COLORTERM ?? '') || !!env.WT_SESSION ||
        env.TERM_PROGRAM === 'vscode' || env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm' || !!env.ConEmuANSI);
    const color256 = enabled && /256/.test(env.TERM ?? '');
    paint.accent = !enabled ? (t: string) => t
        : truecolor ? (t: string) => `\x1b[38;2;110;168;254m${t}\x1b[39m`
        : color256 ? (t: string) => `\x1b[38;5;75m${t}\x1b[39m`
        : paint.brightBlue;
    return paint;
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string { return text.replace(ANSI_PATTERN, ''); }

/** Display width, counting common wide (CJK/emoji) code points as two columns. */
export function displayWidth(text: string): number {
    let width = 0;
    for (const char of stripAnsi(text)) {
        const code = char.codePointAt(0) ?? 0;
        if (code < 32 || (code >= 0x300 && code <= 0x36f) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) { continue; }
        width += (code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
            (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xff60) || (code >= 0x1f300 && code <= 0x1faff))) ? 2 : 1;
    }
    return width;
}

export function terminalWidth(stream: { columns?: number } = process.stdout): number {
    return Math.max(40, Math.min(stream.columns || 100, 160));
}

/** Trim to a display width with an ellipsis; styling is dropped from truncated text. */
export function truncate(text: string, width: number): string {
    if (displayWidth(text) <= width) { return text; }
    let out = '';
    for (const char of stripAnsi(text)) {
        if (displayWidth(out + char) > width - 1) { break; }
        out += char;
    }
    return out + '…';
}

/** Neutralize terminal control sequences in untrusted output (model text, tool results). */
export function sanitize(text: string): string {
    // eslint-disable-next-line no-control-regex
    return stripAnsi(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\r(?!\n)/g, '');
}

export const SYMBOLS = process.platform === 'win32' && !process.env.WT_SESSION && !process.env.TERM_PROGRAM
    ? { dot: '*', branch: '`-', check: 'v', cross: 'x', arrow: '>', bar: '|', spinner: ['-', '\\', '|', '/'], prompt: '>' }
    : { dot: '●', branch: '⎿', check: '✓', cross: '✗', arrow: '›', bar: '│', spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], prompt: '❯' };
