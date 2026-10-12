/**
 * Keeping what Codico adds to the conversation small: the list of open tabs, the size of a
 * search result, and reminders that would otherwise be repeated on every tool result.
 */

// ── Open tabs ────────────────────────────────────────────────────────────────

/** Files whose being open says nothing about the task: lock files, generated and vendored output. */
const NOISE_FILE_RE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum|[^/]*\.min\.(?:js|css)|[^/]*\.map|\.gitignore|\.DS_Store)$|(?:^|\/)(?:node_modules|dist|out|build|coverage|target|\.git|\.next|\.venv|__pycache__)\//i;

export function isNoiseFile(relativePath: string): boolean {
    return NOISE_FILE_RE.test(relativePath.replace(/\\/g, '/'));
}

export const MAX_OPEN_TABS = 8;

/** The open tabs as names: the agent reads a file when it needs it. */
export function openTabsBlock(tabs: ReadonlyArray<{ path: string; language?: string; lines?: number }>): string {
    const shown = tabs.filter(tab => !isNoiseFile(tab.path)).slice(0, MAX_OPEN_TABS);
    if (shown.length === 0) { return ''; }
    const describe = (tab: { path: string; language?: string; lines?: number }) =>
        tab.language && tab.lines ? `${tab.path} (${tab.language}, ${tab.lines} lines)` : tab.path;
    return `Other open tabs (names only; read a file if it matters): ${shown.map(describe).join(', ')}`;
}

// ── Search results ───────────────────────────────────────────────────────────

export const SEARCH_MAX_SHOWN = 40;
export const SEARCH_MAX_PER_FILE = 6;
export const SEARCH_MAX_LINE_CHARS = 200;

/**
 * A search result the model can act on without flooding the conversation: the first matches,
 * a few per file, and an exact count of what was left out and where, so the next search can
 * be narrower instead of longer.
 * @param matches every match found, as "path:line:text"
 * @param complete false when the scan itself stopped early (more matches exist than were counted)
 */
export function renderSearchMatches(matches: readonly string[], complete: boolean): string {
    const perFile = new Map<string, number>();
    const shown: string[] = [];
    const hiddenIn = new Map<string, number>();
    for (const match of matches) {
        const cut = match.indexOf(':');
        const file = cut < 0 ? match : match.slice(0, cut);
        const count = (perFile.get(file) ?? 0) + 1;
        perFile.set(file, count);
        if (shown.length < SEARCH_MAX_SHOWN && count <= SEARCH_MAX_PER_FILE) {
            const second = match.indexOf(':', cut + 1);
            const head = second < 0 ? match : match.slice(0, second + 1);
            const text = second < 0 ? '' : match.slice(second + 1);
            shown.push(head + (text.length > SEARCH_MAX_LINE_CHARS ? text.slice(0, SEARCH_MAX_LINE_CHARS) + '…' : text));
        } else {
            hiddenIn.set(file, (hiddenIn.get(file) ?? 0) + 1);
        }
    }
    const hidden = matches.length - shown.length;
    if (hidden === 0 && complete) { return shown.join('\n'); }
    const where = [...hiddenIn.entries()].sort((a, b) => b[1] - a[1]);
    const listed = where.slice(0, 8).map(([file, count]) => `${file} (${count})`).join(', ');
    const total = `${matches.length}${complete ? '' : '+'} matches in ${perFile.size} file${perFile.size === 1 ? '' : 's'}`;
    return shown.join('\n') + `\n… showing ${shown.length} of ${total}.` +
        (hidden > 0 ? ` Not shown: ${listed}${where.length > 8 ? ` and ${where.length - 8} more files` : ''}.` : '') +
        ' Narrow the search with a longer pattern or a glob for one folder or file to see the rest.';
}

// ── Reminders ────────────────────────────────────────────────────────────────

/** A reminder is given in full again after this many short repeats, in case its first copy was compacted away. */
export const REMINDER_FULL_EVERY = 8;

/**
 * Reminders attached to tool results while a condition holds. The first time a reminder is
 * given in full; while it keeps applying, one short line says so instead of the whole text.
 */
export class ReminderLog {
    private readonly _count = new Map<string, number>();

    say(reminder: string): string {
        const times = this._count.get(reminder) ?? 0;
        this._count.set(reminder, times + 1);
        if (times % REMINDER_FULL_EVERY === 0) { return reminder; }
        const tag = /^\[[^\]\n]{1,60}\]/.exec(reminder)?.[0] ?? '[System]';
        return `${tag} Still applies (see above).`;
    }
}
