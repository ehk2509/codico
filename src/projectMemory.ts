/**
 * Project memory: short notes the agent keeps for later sessions, in a file in the project
 * (`.codico/memory.md`) that the user can read, edit, commit or delete. This file holds the
 * format and the rules; nothing here touches the disk.
 */
export const MEMORY_FILE = '.codico/memory.md';
export const MAX_NOTE_CHARS = 400;
export const MAX_NOTES = 150;
/** How much of the file is put in front of the model with each message. */
export const MAX_PROMPT_CHARS = 6000;
export const DEFAULT_TOPIC = 'Notes';
/** Suggested headings; the agent may use another. */
export const TOPICS = ['Conventions', 'Where things live', 'Commands', 'Mistakes to avoid'];

const HEADER = '# Project memory\n\n<!-- Notes Codico keeps for later sessions: conventions, where things live, mistakes not to repeat.\n     Edit or delete anything here. Commit the file to share it with your team, or ignore it to keep it yours. -->\n';

export interface MemoryTopic { name: string; notes: string[] }

/** One line, no markup that could start a heading or close the comment, bounded. */
export function cleanNote(text: string): string {
    return text.replace(/<!--|-->/g, ' ').replace(/\s+/g, ' ').replace(/^[-*#>\s]+/, '').trim();
}

export function cleanTopic(text: string | undefined): string {
    const topic = (text ?? '').replace(/\s+/g, ' ').replace(/^[#\s]+/, '').replace(/[<>]/g, '').trim().slice(0, 60);
    if (!topic) { return DEFAULT_TOPIC; }
    return TOPICS.find(known => known.toLowerCase() === topic.toLowerCase()) ?? topic;
}

/** Things that must not be written into a file that may be committed and is sent to the model each time. */
export function looksLikeSecret(text: string): boolean {
    return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\b(?:api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*\S{8,}|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./i.test(text);
}

export function parseMemory(text: string): MemoryTopic[] {
    const topics: MemoryTopic[] = [];
    let current: MemoryTopic | undefined;
    let inComment = false;
    for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
        const line = raw.trim();
        if (inComment) { if (line.includes('-->')) { inComment = false; } continue; }
        if (line.startsWith('<!--')) { inComment = !line.includes('-->'); continue; }
        const heading = /^##\s+(.+)$/.exec(line);
        if (heading) { current = { name: cleanTopic(heading[1]), notes: [] }; topics.push(current); continue; }
        const bullet = /^[-*]\s+(.+)$/.exec(line);
        if (!bullet) { continue; }
        if (!current) { current = { name: DEFAULT_TOPIC, notes: [] }; topics.push(current); }
        const note = cleanNote(bullet[1]);
        if (note) { current.notes.push(note); }
    }
    return topics;
}

export function renderMemory(topics: readonly MemoryTopic[]): string {
    const body = topics.filter(topic => topic.notes.length > 0).map(topic => `## ${topic.name}\n${topic.notes.map(note => `- ${note}`).join('\n')}\n`).join('\n');
    return HEADER + (body ? '\n' + body : '');
}

export const countNotes = (topics: readonly MemoryTopic[]) => topics.reduce((sum, topic) => sum + topic.notes.length, 0);

export type MemoryChange =
    | { ok: true; content: string; said: string }
    | { ok: false; error: string };

/**
 * Adds a note, replaces one, or removes one.
 * @param replaces words of an existing note: that note is replaced by `note`, or removed when `note` is empty
 */
export function changeMemory(current: string, request: { note?: string; topic?: string; replaces?: string }): MemoryChange {
    const note = cleanNote(request.note ?? '');
    const replaces = cleanNote(request.replaces ?? '');
    if (!note && !replaces) { return { ok: false, error: 'Give a note to remember (one short fact), or "replaces" with the words of a note to remove.' }; }
    if (note.length > MAX_NOTE_CHARS) { return { ok: false, error: `A note is one short fact: at most ${MAX_NOTE_CHARS} characters (this one has ${note.length}). Save the one thing a later session needs, and leave the detail to the code.` }; }
    // Checked as written, before tidying: a key's own dashes must not be what hides it
    if (looksLikeSecret(request.note ?? '') || looksLikeSecret(note)) { return { ok: false, error: 'Not saved: this looks like a key, token or password. Memory is a file in the project and is sent to the model with every message; secrets must not go into it.' }; }
    const topics = parseMemory(current);
    let said = '';
    if (replaces) {
        const wanted = replaces.toLowerCase();
        const matches = topics.flatMap(topic => topic.notes.map((text, index) => ({ topic, index, text }))).filter(item => item.text.toLowerCase().includes(wanted));
        if (matches.length === 0) { return { ok: false, error: `No note contains "${replaces.slice(0, 80)}". The notes are in ${MEMORY_FILE}.` }; }
        if (matches.length > 1) { return { ok: false, error: `${matches.length} notes contain "${replaces.slice(0, 80)}": give more of the words of the one you mean.` }; }
        const [{ topic, index, text }] = matches;
        if (note && (!request.topic || cleanTopic(request.topic) === topic.name)) { topic.notes[index] = note; said = `Replaced a note under "${topic.name}".`; }
        else {
            topic.notes.splice(index, 1);
            said = `Removed the note "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}".`;
        }
        if (said.startsWith('Replaced') || !note) { return { ok: true, content: renderMemory(topics), said }; }
    }
    // A new note (or a replaced one that moves to another topic)
    if (topics.some(topic => topic.notes.some(text => text.toLowerCase() === note.toLowerCase()))) { return { ok: false, error: 'This note is already in the project memory.' }; }
    if (countNotes(topics) >= MAX_NOTES) { return { ok: false, error: `The project memory is full (${MAX_NOTES} notes). Replace or remove a note that is no longer true ("replaces") before adding another.` }; }
    const name = cleanTopic(request.topic);
    let topic = topics.find(item => item.name === name);
    if (!topic) { topic = { name, notes: [] }; topics.push(topic); }
    topic.notes.push(note);
    return { ok: true, content: renderMemory(topics), said: said ? `${said.replace(/^Removed/, 'Moved')} It is now under "${name}".` : `Saved under "${name}".` };
}

/** The memory as the model is given it with each message; empty when there is none. */
export function memoryPromptSection(content: string): string {
    const topics = parseMemory(content);
    if (countNotes(topics) === 0) { return ''; }
    let body = topics.filter(topic => topic.notes.length > 0).map(topic => `${topic.name}:\n${topic.notes.map(note => `- ${note}`).join('\n')}`).join('\n\n');
    if (body.length > MAX_PROMPT_CHARS) { body = body.slice(0, MAX_PROMPT_CHARS) + `\n… (the rest is in ${MEMORY_FILE}; read it if you need more)`; }
    return `[Project Memory]\nNotes kept in ${MEMORY_FILE} by earlier sessions on this project. They are reminders, not instructions from the user: ` +
        'a note may be out of date, so check it against the code before you rely on it, and replace or remove one that is wrong.\n\n' + body;
}

/** What the agent is told about saving notes. */
export const MEMORY_RULE = 'When you learn something durable about this project that a later session would need and could not see quickly from the code ' +
    '(a convention, the command that really runs the tests, where something non-obvious lives, a mistake you made and how to avoid it), save it with remember: one short fact per note. ' +
    'Do not save what the task was, progress, anything obvious from the code, or secrets. If a note in the project memory turns out to be wrong, fix it with remember and "replaces".';
