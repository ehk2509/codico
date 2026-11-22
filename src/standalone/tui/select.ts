/** Arrow-key picker for the terminal. Works alongside an active readline interface. */
import { Paint, SYMBOLS, truncate } from './ansi';

export interface Choice<T> { label: string; value: T; hint?: string; current?: boolean }

interface KeyInput {
    on(event: 'keypress', listener: (text: string | undefined, key: Key | undefined) => void): unknown;
    off(event: 'keypress', listener: (text: string | undefined, key: Key | undefined) => void): unknown;
}
interface Key { name?: string; ctrl?: boolean; shift?: boolean }
interface Out { write(text: string): unknown; columns?: number }

export interface SelectOptions<T> {
    title: string;
    choices: Choice<T>[];
    /** Index highlighted first (defaults to the current choice, else 0). */
    initial?: number;
    footer?: string;
    signal?: AbortSignal;
    maxVisible?: number;
}

/**
 * Show a list and resolve with the chosen value, or undefined on Esc / Ctrl+C / abort.
 * Keys: ↑/↓ (or k/j), 1-9 to jump, Enter to choose, Esc to cancel.
 */
export function select<T>(input: KeyInput, out: Out, paint: Paint, options: SelectOptions<T>): Promise<T | undefined> {
    const { choices } = options;
    if (!choices.length) { return Promise.resolve(undefined); }
    const visible = Math.min(choices.length, options.maxVisible ?? 10);
    let index = options.initial ?? Math.max(0, choices.findIndex(c => c.current));
    let top = Math.max(0, Math.min(index - visible + 1, choices.length - visible));
    let drawn = 0;
    const p = paint;

    const render = (): void => {
        if (drawn) { out.write(`\x1b[${drawn}A\r\x1b[J`); }
        if (index < top) { top = index; }
        if (index >= top + visible) { top = index - visible + 1; }
        // Every row must fit on one terminal line, or the menu cannot redraw itself in place.
        const width = (out.columns || 80) - 1;
        const lines = [truncate(`${p.accent('?')} ${p.bold(options.title)}`, width)];
        for (let i = top; i < top + visible; i++) {
            const c = choices[i];
            const active = i === index;
            const number = i < 9 ? `${i + 1}.` : '  ';
            const mark = c.current ? p.green(' ' + SYMBOLS.check) : '';
            const label = active ? p.accent(p.bold(c.label)) : c.label;
            const hint = c.hint ? p.gray('  ' + c.hint) : '';
            lines.push(truncate(`${active ? p.accent(SYMBOLS.prompt) : ' '} ${p.gray(number)} ${label}${mark}${hint}`, width));
        }
        const more = choices.length > visible ? `${index + 1}/${choices.length} · ` : '';
        lines.push(truncate(p.gray(`  ${more}${options.footer ?? '↑↓ to move · enter to choose · esc to cancel'}`), width));
        out.write(lines.join('\n') + '\n');
        drawn = lines.length;
    };

    return new Promise(resolve => {
        const finish = (value: T | undefined): void => {
            input.off('keypress', onKey);
            options.signal?.removeEventListener('abort', onAbort);
            // Collapse the menu to one summary line.
            if (drawn) { out.write(`\x1b[${drawn}A\r\x1b[J`); }
            const chosen = value === undefined ? p.gray('cancelled') : p.accent(choices[index].label);
            out.write(`${p.accent('?')} ${p.bold(options.title)} ${chosen}\n`);
            resolve(value);
        };
        const onKey = (text: string | undefined, key: Key | undefined): void => {
            const name = key?.name;
            if (name === 'up' || text === 'k') { index = (index - 1 + choices.length) % choices.length; render(); }
            else if (name === 'down' || text === 'j' || (name === 'tab' && !key?.shift)) { index = (index + 1) % choices.length; render(); }
            else if (name === 'pageup') { index = Math.max(0, index - visible); render(); }
            else if (name === 'pagedown') { index = Math.min(choices.length - 1, index + visible); render(); }
            else if (name === 'return' || name === 'enter') { finish(choices[index].value); }
            else if (name === 'escape' || (key?.ctrl && name === 'c') || text === 'q') { finish(undefined); }
            else if (text && /^[1-9]$/.test(text) && Number(text) <= choices.length) { index = Number(text) - 1; finish(choices[index].value); }
        };
        const onAbort = (): void => finish(undefined);
        if (options.signal?.aborted) { resolve(undefined); return; }
        input.on('keypress', onKey);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        render();
    });
}
