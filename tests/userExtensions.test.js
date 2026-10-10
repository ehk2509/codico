const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseFrontmatter, parseAgentFile, parseSkillFile, collectUserExtensions, skillsPromptSection, parseUserAgentMention,
  userAgentPrefix, expandSkillCommand, userExtensionsMessage, templateFor, nameProblem, MAX_INSTRUCTIONS_CHARS, MAX_PER_KIND,
} = require('../out/userExtensions.js');

const skill = (name, description, instructions = 'Do the thing.') => ({ name, description, instructions, path: `.codico/skills/${name}/SKILL.md` });
const agent = (name, description, instructions = 'Be careful.') => ({ name, description, instructions, path: `.codico/agents/${name}.md` });

test('the header is read between the first two --- lines; the rest is the instructions', () => {
  const parsed = parseFrontmatter('---\nname: add-migration\ndescription: "Use when adding a migration"\nallowed-tools: Read\n---\n\n# Steps\n1. Read schema.sql\n');
  assert.deepEqual(parsed.fields, { name: 'add-migration', description: 'Use when adding a migration', 'allowed-tools': 'Read' });
  assert.equal(parsed.body, '# Steps\n1. Read schema.sql');
  // Windows line endings and a byte order mark
  assert.deepEqual(parseFrontmatter('﻿---\r\nname: x\r\n---\r\nbody\r\n'), { fields: { name: 'x' }, body: 'body' });
  // No header: all of it is instructions
  assert.deepEqual(parseFrontmatter('Just instructions\n--- not a header ---'), { fields: {}, body: 'Just instructions\n--- not a header ---' });
  // A --- line later in the text is not a header
  assert.equal(parseFrontmatter('intro\n---\nname: x\n---\nrest').fields.name, undefined);
});

test('a skill file: the same SKILL.md layout as Claude Code', () => {
  const parsed = parseSkillFile('.codico/skills/add-migration/SKILL.md', 'add-migration', '---\nname: add-migration\ndescription: Use when adding a database migration\n---\n\n1. Read db/schema.sql\n2. Run npm run migrate');
  assert.deepEqual(parsed.ok, { name: 'add-migration', description: 'Use when adding a database migration', instructions: '1. Read db/schema.sql\n2. Run npm run migrate', path: '.codico/skills/add-migration/SKILL.md' });
});

test('name and description fall back to the file name and the first line', () => {
  const parsed = parseAgentFile('.codico/agents/Reviewer.md', 'Reviewer.md', '# Strict code reviewer\n\nReview every change for security problems.');
  assert.equal(parsed.ok.name, 'reviewer');
  assert.equal(parsed.ok.description, 'Strict code reviewer');
  assert.equal(parsed.ok.instructions, '# Strict code reviewer\n\nReview every change for security problems.');
});

test('files that cannot be used are refused with the reason', () => {
  assert.match(parseAgentFile('.codico/agents/terminal.md', 'terminal.md', 'x').problem, /"terminal" is a name Codico already uses/);
  assert.match(parseSkillFile('.codico/skills/fix.md', 'fix.md', 'x').problem, /"fix" is a name Codico already uses/);
  // An agent may be called "fix" and a skill "terminal": the two do not share names
  assert.ok(parseAgentFile('a', 'fix.md', 'x').ok);
  assert.ok(parseSkillFile('a', 'terminal', 'x').ok);
  assert.match(parseSkillFile('.codico/skills/My Skill/SKILL.md', 'My Skill', 'x').problem, /must be lowercase letters, digits and hyphens/);
  assert.match(parseSkillFile('p', 'ok', '---\nname: ../../etc\n---\nx').problem, /must be lowercase/);
  assert.match(parseSkillFile('p', 'empty', '---\nname: empty\n---\n\n  \n').problem, /has no instructions/);
  assert.match(parseSkillFile('p', 'huge', 'x'.repeat(MAX_INSTRUCTIONS_CHARS + 1)).problem, /20,001 characters; the limit is 20,000/);
  assert.ok(parseSkillFile('p', 'big', 'x'.repeat(MAX_INSTRUCTIONS_CHARS)).ok);
  // A long description is cut, not refused
  assert.equal(parseSkillFile('p', 's', `---\ndescription: ${'d'.repeat(500)}\n---\nx`).ok.description.length, 200);
});

test('the set a turn uses: sorted, one per name, within the limit, problems kept', () => {
  const set = collectUserExtensions(
    [{ ok: agent('zeta', 'z') }, { ok: agent('alpha', 'a') }, { problem: 'bad agent file' }],
    [{ ok: skill('one', '1') }, { ok: { ...skill('one', 'again'), path: '.codico/skills/one.md' } }],
  );
  assert.deepEqual(set.agents.map(a => a.name), ['alpha', 'zeta']);
  assert.deepEqual(set.skills.map(s => s.description), ['1']);
  assert.deepEqual(set.problems, ['bad agent file', '.codico/skills/one.md: another skill is already named "one" (.codico/skills/one/SKILL.md).']);
  const many = collectUserExtensions([], Array.from({ length: MAX_PER_KIND + 3 }, (_, i) => ({ ok: skill(`s${String(i).padStart(3, '0')}`, 'd') })));
  assert.equal(many.skills.length, MAX_PER_KIND);
  assert.match(many.problems[0], /Only the first 50 skills are loaded \(53 found\)/);
});

test('the system prompt lists skills by name, description and path, not their text', () => {
  assert.equal(skillsPromptSection([]), '');
  const section = skillsPromptSection([skill('add-migration', 'Use when adding a migration', 'SECRET STEPS'), skill('release', 'Use when cutting a release')]);
  assert.match(section, /^\[Project Skills\]\n/);
  assert.match(section, /read its file with read_file before you start/);
  assert.match(section, /\n- add-migration: Use when adding a migration \(\.codico\/skills\/add-migration\/SKILL\.md\)\n- release: Use when cutting a release \(\.codico\/skills\/release\/SKILL\.md\)$/);
  assert.doesNotMatch(section, /SECRET STEPS/);
  // Identical for identical skills: the system prompt stays cacheable
  assert.equal(section, skillsPromptSection([skill('add-migration', 'Use when adding a migration', 'SECRET STEPS'), skill('release', 'Use when cutting a release')]));
});

test('@name selects a project agent and is taken out of the message', () => {
  const agents = [agent('reviewer', 'Reviews'), agent('db', 'Database')];
  assert.deepEqual(parseUserAgentMention('@reviewer check src/app.ts', agents), { agent: agents[0], strippedText: 'check src/app.ts' });
  assert.deepEqual(parseUserAgentMention('check this  @DB please', agents), { agent: agents[1], strippedText: 'check this please' });
  // Not an agent: an email address, a longer name, an unknown name
  assert.equal(parseUserAgentMention('mail me@reviewer.com', agents), null);
  assert.equal(parseUserAgentMention('ask @reviewer-bot', agents), null);
  assert.equal(parseUserAgentMention('ping @someone', agents), null);
  assert.equal(parseUserAgentMention('@reviewer', []), null);
  // An unknown mention before a known one does not hide it
  assert.equal(parseUserAgentMention('@someone said ask @db', agents).agent.name, 'db');
  assert.match(userAgentPrefix(agents[0]), /^You are acting as the project's "reviewer" agent\.[\s\S]*\n\nBe careful\.$/);
});

test('/name runs a skill: its instructions travel with the request', () => {
  const skills = [skill('add-migration', 'Use when adding a migration', '1. Read db/schema.sql')];
  const run = expandSkillCommand('/add-migration add a users.email column', skills);
  assert.equal(run.skill.name, 'add-migration');
  assert.match(run.text, /^\[Skill: add-migration\]\nFollow this skill from the project \(\.codico\/skills\/add-migration\/SKILL\.md\)/);
  assert.match(run.text, /\n\n1\. Read db\/schema\.sql\n\n\[Request\]\nadd a users\.email column$/);
  // No request: applied to what is in front of the user
  assert.match(expandSkillCommand('/Add-Migration', skills).text, /\[Request\]\nApply the skill to the current context/);
  // Not skill commands
  assert.equal(expandSkillCommand('/fix the bug', skills), null);
  assert.equal(expandSkillCommand('please /add-migration now', skills), null);
  assert.equal(expandSkillCommand('/add-migration-v2 x', skills), null);
  assert.equal(expandSkillCommand('/usr/bin/env node', skills), null);
});

test('the panel gets names and descriptions only', () => {
  const message = userExtensionsMessage({ agents: [agent('reviewer', 'Reviews', 'LONG INSTRUCTIONS')], skills: [skill('release', 'Cut a release', 'STEPS')], problems: ['x'] });
  assert.deepEqual(message, { type: 'userExtensions', agents: [{ name: 'reviewer', description: 'Reviews' }], skills: [{ name: 'release', description: 'Cut a release' }] });
});

test('the templates written by New Skill / New Agent load as they are', () => {
  const s = parseSkillFile('.codico/skills/add-migration/SKILL.md', 'add-migration', templateFor('skill', 'add-migration'));
  const a = parseAgentFile('.codico/agents/reviewer.md', 'reviewer.md', templateFor('agent', 'reviewer'));
  assert.equal(s.ok.name, 'add-migration');
  assert.equal(a.ok.name, 'reviewer');
  assert.ok(s.ok.description && a.ok.description);
  assert.equal(nameProblem('skill', 'add-migration'), undefined);
  assert.match(nameProblem('skill', 'Add Migration'), /lowercase letters/);
  assert.match(nameProblem('agent', 'github'), /already uses/);
  assert.match(nameProblem('skill', 'compact'), /already uses/);
});

test('the reserved names match the commands and agents the panel offers', () => {
  const chat = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'media', 'chat.js'), 'utf8');
  const { BUILT_IN_AGENTS, BUILT_IN_COMMANDS } = require('../out/userExtensions.js');
  const agents = [...chat.slice(chat.indexOf('var AGENTS = ['), chat.indexOf('var SLASH_COMMANDS')).matchAll(/name: '@([a-z]+)'/g)].map(m => m[1]);
  const commands = [...chat.slice(chat.indexOf('var SLASH_COMMANDS = ['), chat.indexOf('var _userAgents')).matchAll(/cmd: '\/([a-z]+)'/g)].map(m => m[1]);
  assert.deepEqual([...BUILT_IN_AGENTS].sort(), agents.sort());
  assert.deepEqual([...BUILT_IN_COMMANDS].sort(), commands.sort());
});
