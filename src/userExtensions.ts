/**
 * Skills and agents a project defines for itself, as Markdown files in its `.codico` folder:
 *
 *   .codico/agents/<name>.md          an agent: `@name` puts its instructions in charge of the turn
 *   .codico/skills/<name>/SKILL.md    a skill: instructions for one kind of task (also <name>.md)
 *
 * A file starts with a small header between `---` lines (`name`, `description`), followed by
 * the instructions. Skills use the same SKILL.md layout as Claude Code, so one folder can
 * serve both tools.
 *
 * This module is the format and the rules; reading the files is in userExtensionsLoader.
 */

export interface UserAgent {
    name: string;
    description: string;
    /** The agent's instructions: added to the system prompt for a turn that mentions it. */
    instructions: string;
    /** Workspace-relative path of the file, for messages. */
    path: string;
}

export interface UserSkill {
    name: string;
    description: string;
    instructions: string;
    path: string;
}

export interface UserExtensions {
    agents: UserAgent[];
    skills: UserSkill[];
    /** Files that were skipped, and why. */
    problems: string[];
}

export const NO_USER_EXTENSIONS: UserExtensions = { agents: [], skills: [], problems: [] };

/** Names Codico uses itself: a project's agent or skill cannot take them. */
export const BUILT_IN_AGENTS = ['workspace', 'terminal', 'vscode', 'github'];
export const BUILT_IN_COMMANDS = ['fix', 'explain', 'doc', 'tests', 'plan', 'review', 'pr', 'coverage', 'test', 'new', 'compact'];

/** More than this is a mistake (a pasted document), and would be paid for on every use. */
export const MAX_INSTRUCTIONS_CHARS = 20_000;
export const MAX_DESCRIPTION_CHARS = 200;
/** At most this many agents, and this many skills, are loaded. */
export const MAX_PER_KIND = 50;

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The `key: value` header between the first two `---` lines, and the text after it. */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
    const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
    const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
    if (!match) { return { fields: {}, body: normalized.trim() }; }
    const fields: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
        const field = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
        if (!field) { continue; }
        const value = field[2].trim();
        const quoted = /^(["'])(.*)\1$/.exec(value);
        fields[field[1].toLowerCase()] = quoted ? quoted[2] : value;
    }
    return { fields, body: normalized.slice(match[0].length).trim() };
}

type Parsed<T> = { ok: T } | { problem: string };

function parseDefinition(path: string, fallbackName: string, text: string, kind: 'agent' | 'skill', reserved: string[]): Parsed<UserAgent> {
    const { fields, body } = parseFrontmatter(text);
    const name = (fields.name || fallbackName).trim().toLowerCase();
    if (!NAME_PATTERN.test(name)) {
        return { problem: `${path}: the name "${name}" must be lowercase letters, digits and hyphens (at most 40 characters).` };
    }
    if (reserved.includes(name)) {
        return { problem: `${path}: "${name}" is a name Codico already uses; choose another.` };
    }
    if (!body) { return { problem: `${path}: the ${kind} has no instructions after its header.` }; }
    if (body.length > MAX_INSTRUCTIONS_CHARS) {
        return { problem: `${path}: the instructions are ${body.length.toLocaleString('en-US')} characters; the limit is ${MAX_INSTRUCTIONS_CHARS.toLocaleString('en-US')}.` };
    }
    // Without a description the first line of the instructions has to do
    const firstLine = body.split('\n').find(line => line.trim())?.replace(/^#+\s*/, '').trim() ?? '';
    const description = (fields.description || firstLine).replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION_CHARS);
    return { ok: { name, description, instructions: body, path } };
}

/** An agent file: `.codico/agents/<name>.md`. */
export function parseAgentFile(path: string, fileName: string, text: string): Parsed<UserAgent> {
    return parseDefinition(path, fileName.replace(/\.md$/i, ''), text, 'agent', BUILT_IN_AGENTS);
}

/** A skill file: `.codico/skills/<name>/SKILL.md` (folderName) or `.codico/skills/<name>.md`. */
export function parseSkillFile(path: string, folderOrFileName: string, text: string): Parsed<UserSkill> {
    return parseDefinition(path, folderOrFileName.replace(/\.md$/i, ''), text, 'skill', BUILT_IN_COMMANDS);
}

/** Collects parsed files into the set a turn uses: sorted, without duplicates, within the limits. */
export function collectUserExtensions(agents: Array<Parsed<UserAgent>>, skills: Array<Parsed<UserSkill>>): UserExtensions {
    const problems: string[] = [];
    const collect = <T extends UserAgent>(parsed: Array<Parsed<T>>, kind: string): T[] => {
        const byName = new Map<string, T>();
        for (const item of parsed) {
            if ('problem' in item) { problems.push(item.problem); continue; }
            const earlier = byName.get(item.ok.name);
            if (earlier) { problems.push(`${item.ok.path}: another ${kind} is already named "${item.ok.name}" (${earlier.path}).`); continue; }
            byName.set(item.ok.name, item.ok);
        }
        const sorted = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
        if (sorted.length > MAX_PER_KIND) { problems.push(`Only the first ${MAX_PER_KIND} ${kind}s are loaded (${sorted.length} found).`); }
        return sorted.slice(0, MAX_PER_KIND);
    };
    return { agents: collect(agents, 'agent'), skills: collect(skills, 'skill'), problems };
}

/**
 * The part of the system prompt that tells the model which skills exist. Only names and
 * descriptions: the model reads a skill's file when a task calls for it, so an unused skill
 * costs one line.
 */
export function skillsPromptSection(skills: UserSkill[]): string {
    if (skills.length === 0) { return ''; }
    return '[Project Skills]\n' +
        'This project defines skills: instructions for specific kinds of task. When a task matches a skill, read its file with read_file before you start and follow it. ' +
        'Do not read a skill that does not apply.\n' +
        skills.map(skill => `- ${skill.name}: ${skill.description} (${skill.path})`).join('\n');
}

/**
 * `@name` for one of the project's agents, anywhere in the message.
 * @returns the agent and the message without the mention, or null when none is mentioned
 */
export function parseUserAgentMention(text: string, agents: UserAgent[]): { agent: UserAgent; strippedText: string } | null {
    for (const match of text.matchAll(/(^|\s)@([a-z0-9][a-z0-9-]*)(?![\w-])/gi)) {
        const agent = agents.find(candidate => candidate.name === match[2].toLowerCase());
        if (!agent) { continue; }
        const strippedText = (text.slice(0, match.index) + ' ' + text.slice(match.index + match[0].length)).replace(/\s{2,}/g, ' ').trim();
        return { agent, strippedText };
    }
    return null;
}

/** The system prompt prefix for a turn run by one of the project's agents. */
export function userAgentPrefix(agent: UserAgent): string {
    return `You are acting as the project's "${agent.name}" agent. Follow these instructions from the project for this request:\n\n${agent.instructions}`;
}

/**
 * `/name the request` for one of the project's skills: the skill is given in full with the
 * request, so the model does not have to find and read it.
 * @returns the message to send, or null when the text is not a skill command
 */
export function expandSkillCommand(text: string, skills: UserSkill[]): { skill: UserSkill; text: string } | null {
    const match = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (!match) { return null; }
    const skill = skills.find(candidate => candidate.name === match[1].toLowerCase());
    if (!skill) { return null; }
    const request = (match[2] ?? '').trim();
    return {
        skill,
        text: `[Skill: ${skill.name}]\nFollow this skill from the project (${skill.path}) for the request below.\n\n${skill.instructions}\n\n[Request]\n${request || 'Apply the skill to the current context (the active file or selection).'}`,
    };
}

/** What the panel needs for its @ and / menus: names and descriptions only. */
export function userExtensionsMessage(extensions: UserExtensions): { type: 'userExtensions'; agents: Array<{ name: string; description: string }>; skills: Array<{ name: string; description: string }> } {
    const brief = (item: UserAgent): { name: string; description: string } => ({ name: item.name, description: item.description });
    return { type: 'userExtensions', agents: extensions.agents.map(brief), skills: extensions.skills.map(brief) };
}

/** A starting point for a new file, written by the "New Skill" and "New Agent" commands. */
export function templateFor(kind: 'agent' | 'skill', name: string): string {
    return kind === 'agent'
        ? `---\nname: ${name}\ndescription: One line shown in the @ menu: what this agent is for\n---\n\nYou are the ${name} agent for this project.\n\nDescribe here how it should work: what it focuses on, the conventions it must follow,\nwhat it should check before answering, and what it must never do.\n`
        : `---\nname: ${name}\ndescription: One line that tells Codico when to use this skill, e.g. "Use when adding a database migration"\n---\n\n# ${name}\n\nWrite the steps Codico should follow for this kind of task:\n\n1. What to read first.\n2. The conventions to follow.\n3. How to verify the result (the command to run).\n`;
}

/** Whether a name can be used for a new agent or skill; the reason when it cannot. */
export function nameProblem(kind: 'agent' | 'skill', name: string): string | undefined {
    if (!NAME_PATTERN.test(name)) { return 'Use lowercase letters, digits and hyphens (at most 40 characters).'; }
    if ((kind === 'agent' ? BUILT_IN_AGENTS : BUILT_IN_COMMANDS).includes(name)) { return `"${name}" is a name Codico already uses.`; }
    return undefined;
}
