/**
 * Rules for terminal commands the user chose to always allow in a workspace.
 *
 * A rule is either a whole command (`npm test`), allowed only when the command is exactly
 * that, or a command followed by ` *` (`npm test *`), allowed with any further arguments.
 * A command that uses the shell to do more than run one program (`;`, `&&`, `|`, `>`,
 * `$( )`, backticks, a second line) only ever matches a rule that is exactly that command,
 * so `npm test *` can never allow `npm test; rm -rf ~`.
 */
export const MAX_RULES = 100;
export const MAX_RULE_CHARS = 500;

/** One program with arguments: nothing the shell would chain, redirect, substitute or expand into a command. */
export function isSimpleCommand(command: string): boolean {
    return !/[;&|<>`\n\r(){}\\]|\$\(/.test(command) && !/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(command);
}

/** Spaces at the ends and runs of spaces do not make another command. */
export function normalizeCommand(command: string): string {
    return isSimpleCommand(command) && !/["']/.test(command) ? command.trim().replace(/[ \t]+/g, ' ') : command.trim();
}

export function isWildcardRule(rule: string): boolean { return rule.endsWith(' *'); }

export function ruleAllows(rule: string, command: string): boolean {
    const wanted = normalizeCommand(command);
    if (!isWildcardRule(rule)) { return wanted === rule; }
    const head = rule.slice(0, -2);
    return isSimpleCommand(command) && (wanted === head || wanted.startsWith(head + ' '));
}

export function allowedBy(rules: readonly string[], command: string): string | undefined {
    return rules.find(rule => ruleAllows(rule, command));
}

// Tools whose first argument names what they do: the rule keeps it (`git status *`, never `git *`)
const SUBCOMMAND_TOOLS = new Set(['npm', 'yarn', 'pnpm', 'bun', 'npx', 'git', 'cargo', 'go', 'dotnet', 'mvn', 'gradle', './gradlew', 'deno', 'composer', 'bundle', 'make', 'poetry', 'uv']);
// Test runners, type checkers and linters: any arguments
const CHECK_TOOLS = new Set(['pytest', 'jest', 'vitest', 'tsc', 'eslint', 'ruff', 'mypy', 'phpunit', 'rspec']);

/**
 * The rules the approval card offers for a command: always the command itself, and for
 * well-known build and test tools the same with any arguments.
 */
export function suggestRules(command: string): string[] {
    const exact = normalizeCommand(command);
    if (!exact || exact.length > MAX_RULE_CHARS) { return []; }
    const rules = [exact];
    if (!isSimpleCommand(command) || /["'$*?~]/.test(exact)) { return rules; }
    const words = exact.split(' ');
    // An option is not a subcommand: `node -e *` or `git -c *` would allow anything
    const named = (n: number) => words.length >= n && words.slice(1, n).every(word => /^[A-Za-z0-9][\w:.@/-]*$/.test(word));
    let head: string | undefined;
    if (CHECK_TOOLS.has(words[0])) { head = words[0]; }
    else if (SUBCOMMAND_TOOLS.has(words[0])) {
        const runner = ['npm', 'yarn', 'pnpm', 'bun'].includes(words[0]) && words[1] === 'run';
        if (named(runner ? 3 : 2)) { head = words.slice(0, runner ? 3 : 2).join(' '); }
    }
    if (head) { rules.push(head + ' *'); }
    return rules;
}

/** A rule read from storage or sent by the panel is used only if it is one this module could have made. */
export function isValidRule(rule: unknown): rule is string {
    if (typeof rule !== 'string' || !rule.trim() || rule.length > MAX_RULE_CHARS || rule !== rule.trim()) { return false; }
    if (!isWildcardRule(rule)) { return normalizeCommand(rule) === rule; }
    const head = rule.slice(0, -2);
    return isSimpleCommand(head) && !/["'$*?~]/.test(head) && normalizeCommand(head) === head;
}

export function addRule(rules: readonly string[], rule: string): string[] {
    if (!isValidRule(rule) || rules.includes(rule)) { return [...rules]; }
    return [...rules, rule].slice(-MAX_RULES);
}
