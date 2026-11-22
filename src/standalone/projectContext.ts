/** Project instructions and custom agent/skill files without a VS Code dependency. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    collectUserExtensions, parseAgentFile, parseSkillFile, skillsPromptSection,
    parseUserAgentMention, expandSkillCommand, userAgentPrefix, UserExtensions
} from '../userExtensions';
import { memoryPromptSection } from '../projectMemory';

const MAX_SOURCE = 24_000;

function regularFile(root: string, relative: string): string | undefined {
    const file = path.join(root, relative);
    try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > MAX_SOURCE) { return undefined; }
        return fs.readFileSync(file, 'utf8');
    } catch { return undefined; }
}

export class ProjectContext {
    readonly workspace: string;
    readonly extensions: UserExtensions;
    readonly preamble: string;

    constructor(workspace: string) {
        this.workspace = fs.realpathSync(workspace);
        const agents: ReturnType<typeof parseAgentFile>[] = [];
        const skills: ReturnType<typeof parseSkillFile>[] = [];
        const agentDir = path.join(this.workspace, '.codico', 'agents');
        const skillDir = path.join(this.workspace, '.codico', 'skills');
        const filenames = (dir: string): string[] => {
            try {
                if (!fs.lstatSync(dir).isDirectory()) { return []; }
                return fs.readdirSync(dir).slice(0, 100);
            } catch { return []; }
        };
        for (const name of filenames(agentDir).filter(x => x.endsWith('.md'))) {
            const relative = '.codico/agents/' + name;
            const content = regularFile(this.workspace, relative);
            if (content !== undefined) { agents.push(parseAgentFile(relative, name, content)); }
        }
        for (const name of filenames(skillDir)) {
            const fileName = name.endsWith('.md') ? name : name + '/SKILL.md';
            const relative = '.codico/skills/' + fileName;
            const content = regularFile(this.workspace, relative);
            if (content !== undefined) { skills.push(parseSkillFile(relative, name, content)); }
        }
        this.extensions = collectUserExtensions(agents, skills);
        const sections: string[] = [];
        for (const name of ['AGENTS.md', '.codico/instructions.md']) {
            const text = regularFile(this.workspace, name);
            if (text?.trim()) { sections.push('[Project instructions: ' + name + ']\n' + text); }
        }
        const memory = regularFile(this.workspace, '.codico/memory.md');
        if (memory) { sections.push(memoryPromptSection(memory)); }
        const catalog = skillsPromptSection(this.extensions.skills);
        if (catalog) { sections.push(catalog); }
        this.preamble = sections.join('\n\n').slice(0, 50_000);
    }

    expand(request: string): string {
        const mentioned = parseUserAgentMention(request, this.extensions.agents);
        const input = mentioned ? mentioned.strippedText : request;
        const skill = expandSkillCommand(input, this.extensions.skills);
        const prompt = skill ? skill.text : input;
        return mentioned ? userAgentPrefix(mentioned.agent) + '\n\n[User request]\n' + prompt : prompt;
    }
}
