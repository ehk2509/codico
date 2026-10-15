/**
 * A question the agent asks the user: a <clarify> block at the end of its reply, with the
 * question, its kind (one choice or several) and its options. The panel shows the same block
 * as a question with buttons.
 */
export interface Question { question: string; multi: boolean; options: string[]; freeInput: boolean }

const BLOCK = /<clarify>([\s\S]*?)<\/clarify>/g;

/** The last question in a reply, or undefined when it asks none. */
export function lastQuestion(text: string): Question | undefined {
    const blocks = [...text.matchAll(BLOCK)];
    const raw = blocks[blocks.length - 1]?.[1];
    if (raw === undefined) { return undefined; }
    const result: Question = { question: '', multi: false, options: [], freeInput: false };
    let inOptions = false;
    for (const line of raw.trim().split('\n')) {
        const field = /^\s*(question|type|free_input|options):\s*(.*)$/.exec(line);
        if (field) {
            inOptions = field[1] === 'options';
            if (field[1] === 'question') { result.question = field[2].trim(); }
            if (field[1] === 'type') { result.multi = field[2].trim() === 'multi'; }
            if (field[1] === 'free_input') { result.freeInput = /true/i.test(field[2]); }
        } else if (inOptions && /^\s*-\s+/.test(line)) { result.options.push(line.replace(/^\s*-\s+/, '').trim()); }
    }
    return result.question || result.options.length ? result : undefined;
}

/** A reply without its question block (shown apart, as a question). */
export const withoutQuestion = (text: string) => text.replace(BLOCK, '').trim();
