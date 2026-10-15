# Changelog

All notable changes to Codico will be documented in this file.

## Unreleased

### Added
- **Codico: Marketplace**: community skills, agents, MCP servers and hooks from a registry, searchable, installed into the project. Each version is pinned to a commit of its publisher's repository and a content hash, checked on download; before installing you see what it adds, its declared permissions and a security scan of every file. Updates (checked daily) and uninstalls touch exactly what was installed, recorded in `.codico/packages.json`, and keep files you changed. `codico package check` and `codico registry verify` for publishers and the registry's CI. Setting: `codico.marketplaceRegistry`.

### Fixed
- A reply that ended with an offer ("If you meant a file containing `{}`, let me know and I'll adjust it") was taken for an announced step the agent had not taken, and the agent was sent back up to twice to "issue that tool call", for nothing: two extra requests on a finished task. Offers and replies that say the work is done now end the turn.

## 0.5.1 - 2026-10-15

### Fixed
- A background task or a team's worker that ended with a question was reported as finished, and its question showed only as raw text in its collapsed log. The question's tag usually arrives split across the pieces a model streams, and only single pieces were looked at; the whole reply is now. Such a task now says it needs you, and the Agents view shows its question in its card with the options as buttons (several choices: select, then Send; "Other…" to write an answer). `codico run` exits with 2 for such a reply, as documented.

## 0.5.0 - 2026-10-15

### Added
- Automations (**Codico: Automations**, off until turned on for a repository). An issue labelled `codico` or a new CI failure on the default branch starts a job: an agent in its own worktree, started from GitHub's branch, run in this window. Its work becomes a draft pull request (after asking, unless publishing is set to go on by itself). Codico then follows the pull request: a CI failure, requested changes or a new review thread resumes the same agent with its conversation (kept on disk, so it survives a reload) and the failing log or the comments, and the fix is pushed to the same pull request, until it is merged or closed. Outside text is quoted as such; a job's commands run unattended only in the command sandbox. Settings: `codico.automationPollSeconds`, `codico.automationPermissions`.
- Automations answer review comments: after working on them, the agent's reply to each is posted in its thread once the fix is pushed (asked first unless publishing goes on by itself). Only feedback from the repository's owner, members and collaborators resumes a job.
- `codico automate`: the automations without the editor (GitHub Actions, cron, a server), with their state kept in `--state-dir` between runs; a job's worktree is made again from its pushed branch on a fresh checkout. **Codico: Add GitHub Actions Workflow for Automations** writes a workflow that runs it on GitHub's events.
- End-to-end verification. For a feature or a fix the agent states acceptance criteria, reproduces a bug before fixing it, starts the app (`app` tool: a dev server in the background, stopped when the task ends), uses it in the browser, and checks it with `browser_expect`, an assertion Codico runs itself and records as evidence along with test and build results. Console errors, page errors and failed requests are reported and kept. A criterion is verified only on evidence observed after the last code change; the agent is reminded of criteria it has not verified. An independent review (one request without tools or the agent's reasoning) agrees or disputes each criterion. Screenshots, an animated replay and a report are saved in `.codico/evidence/`. Settings: `codico.acceptanceChecks`, `codico.acceptanceReview`.
- Agent teams, in one window. `/team <goal>` makes the agent in the panel the orchestrator of a team: it plans, starts named developers and testers (`backend`, `frontend`…) that work in parallel, each an agent with its own conversation in a git worktree and branch of its own, waits for their reports, has a read-only reviewer check their patches, sends them corrections or answers, and merges their branches into the workspace after your approval. A merge that conflicts is undone. After merging, it runs the build and tests as an acceptance gate. A tester starts from a developer's branch.
- The Agents view in the panel: each worker's or background task's status, steps, tokens, current step, change-report verdict, processes left running and log, with Reply, Stop and Open (its worktree in a separate window). Their approval cards appear in their place there, named after them, and "Allow all" given to the orchestrator never covers them.
- New settings: `codico.teamMaxWorkers` (default 3), `codico.teamWorkerPermissions` (default: edit freely, ask before commands) and `codico.backgroundTasksRunIn`.

### Changed
- The change report separates acceptance from checks: its headline is *Accepted*, *Partly accepted*, *Disputed* or *Not accepted* when criteria were stated, and *Checks pass* (formerly "Verified") otherwise, with a note that passing checks do not show that the request is met.
- Background tasks (`/background`) run in this window by default, next to your conversation, in their own git worktree as before, and are followed and answered in the Agents view. A task can be answered or given more to do after it has finished. Set `codico.backgroundTasksRunIn` to `windows` for the previous behaviour (a VS Code window per task).

- Internal: the main agent file (`agentProvider.ts`) is split by responsibility, from 2,895 lines to 1,429. The agent loop now lives in `agentTurn.ts` and reaches the panel only through a narrow interface; the workspace tools, approvals, thread list, compaction, panel commands and turn setup each have a module of their own. Each file has its own size budget in the architecture test, in place of one limit for the main file. No behaviour changes.

## 0.4.1 - 2026-10-13

### Security
- Checkpoints (0.4.0) copied every file that `.gitignore` did not exclude into Codico's store, so a `.env` or key file in a project that does not ignore it was kept there, in a folder other local users could read, for as long as the store existed. Credential files are now never copied, whatever `.gitignore` says; the store is readable by your user only; checkpoints are deleted after 14 days (`codico.checkpointRetentionDays`); and a store created by 0.4.0 is deleted the first time this version uses it, so nothing it may hold is left behind. Reported in an external review.

### Fixed
- Background tasks were only shown in VS Code's status bar at the bottom of the window, where they were easy to miss. The Codico panel now shows them too, next to its own status, and a click opens the list.
- A background task whose window was waiting for VS Code's "do you trust this folder" question stayed at "starting" with no explanation. It is now shown as waiting for you, and a notification says where to answer.

## 0.4.0 - 2026-10-13

### Added
- Running without the editor: a `codico` command (`bin/codico.js` in the extension; **Codico: Copy Command-Line Command** copies its path) runs one task from a terminal, a script, CI or a schedule. It starts VS Code for the task, prints the agent's reply and steps, and exits with 0 (finished), 1 (failed), 2 (the agent asked a question) or 3 (something was not allowed). Nothing is allowed unless an option says so: `--allow-edits`, `--allow-commands`, `--allow-web`, `--allow-hooks`. Keys are read from environment variables, and `--json` gives machine-readable output.
- Pull-request workflow: **Codico: Create Pull Request** pushes the current branch and opens a pull request for it, and a background task's branch can be published the same way from **Codico: Background Tasks**; a confirmation shows what is published and where, and offers a draft. **Codico: Address Review Comments** gives the agent the unresolved review threads of the branch's pull request as a task, with the comments treated as outside text. Codico does not post comments or resolve threads.
- Command sandbox: with `codico.commandSandbox` set to `auto` or `required`, the agent's terminal commands run confined by the operating system (bubblewrap on Linux, the built-in sandbox on macOS). A command can read the machine but write only in the workspace, package caches and temporary folders; it cannot read credential folders such as `~/.ssh`; and the network can be switched off. When a command fails because of that, the agent is told so. Off by default; the settings are per machine, so a project cannot change them.
- Project memory: the agent can save short notes about a project (a convention, the command that runs the tests, where something lives, a mistake to avoid) with a `remember` tool, and every later session starts with them. They are kept in `.codico/memory.md`, a Markdown file you can edit, commit or ignore; each note is written through the normal file-change approval and can be undone. Notes are given to the model as reminders to check against the code, text that looks like a secret is refused, and after web content was read in a turn a note is never saved unseen. **Codico: Open Project Memory** opens the file; `codico.memory` turns it off.
- Durable checkpoints: with every message Codico records the whole workspace in a git repository of its own, outside the project. Rewinding to a message now restores every file to what it was then, including what terminal commands created, changed or deleted, and it still works after VS Code is restarted. Until now rewind only knew Codico's own edits and lost them when the window closed. **Codico: Undo Last Rewind** brings back the state before a rewind; **Codico: Clear Checkpoints** frees the space; `codico.checkpoints` turns them off. Files your `.gitignore` excludes are neither copied nor restored, and your project's own repository is never touched.
- Web search: a `web_search` tool lets the agent look something up without being given an address, and returns up to 8 results that it can then read with `fetch_url`. DuckDuckGo is used by default and needs no key; Brave Search can be chosen with a key (**Codico: Set Web Search Key**), and `codico.webSearch: off` removes the ability. Each search is asked about first and names the engine the query goes to; results are treated as untrusted content.
- Background tasks: `/background <task>` (or **Codico: Start Background Task**) runs a task in a git worktree and branch of its own, in a second window, while you keep working. A status bar item and notifications in your window say when a task finishes, fails or needs you; **Codico: Background Tasks** lists them, shows everything a task changed as one patch, merges it into your branch (a conflicting merge is undone) or discards it. Several tasks can run at once, one window each.
- A usage record with every reply: the task's requests one by one (prompt, completion and cached tokens, and whether a subagent made the request) and the points at which the conversation was compacted. Until now only task totals were kept, so a question like "why did this task use 3 million tokens" could not be answered from the thread. The token tooltip also shows how many requests the task has made.

### Changed
- File reads that are still current are no longer trimmed from the conversation. Codico replaced any tool result over 6,000 characters with a "compacted, re-run the tool if needed" note once six newer large results existed. For a file read that mostly produced another read of the same lines, a full request to save part of one. A read is now kept while its file has not been edited since and no later read holds the same lines, up to 120,000 characters of such reads in total; a read made stale by an edit, or repeated by a later read, is trimmed as before.

## 0.3.17 - 2026-10-13

### Security
- The contents of every open editor tab (up to five, 5,000 characters each) were added to each message, including tabs of files excluded by `.codicoignore` and files outside the workspace: a `.env` left open in a tab was sent to the model. Tabs are now sent as names only, and a tab the agent could not read itself is not named.

### Added
- Duplicate a thread from the thread list (⧉, after rename). The copy has the same conversation, what the panel shows and what the model sees, under the name "<original> (copy)"; it opens straight away and is never pinned. The original is left untouched, the two are independent, and duplicating is refused while a reply is running. Written by Codico's own agent as a test task, then reviewed and ported.
- After **Stop**, if commands of the task left background processes running (a dev server, a watcher), the reply ends with a note naming them and a **Stop them** button. Stop itself still leaves them running, as before; they were only visible as a chip in the status bar.

### Changed
- Smaller additions to the conversation, from the review of a recorded task:
  - Open tabs are named, not included (see Security). In that task the block held `package-lock.json` and `.gitignore`, 6,500 characters resent with each of about 60 requests. Lock files and generated output are not listed.
  - `search_files` returns at most 40 matches, 6 per file and 200 characters per line, followed by the exact number left out and the files they are in, so the next search can be narrower. It used to return up to 100 matches of up to 500 characters.
  - A reminder attached to tool results while a condition holds ("a helper import is still unwired…", sent 14 times in that task) is given in full the first time and as one short line afterwards.
- Reads no longer repeat what the model already has. In a recorded task a third of all lines read (1,312 of 3,823) were already in the conversation and unchanged, most of them slices of one long file read 15 times. `read_file` now checks the conversation for earlier text of the file: lines that are still there and still equal to the file are left out (a pointer for a fully known range, only the new lines for an overlapping one). Changed lines are always sent, and nothing is assumed after a compaction, a rewind or a thread switch, because the check reads the conversation as it is instead of remembering what was sent.
- After an edit, the agent was told to "re-read the edited control flow". The edit result already shows the changed lines, so it is now told to check those, and to read only what the result does not show.
- One search instead of two. The thread bar had a button to find in the open conversation and another to search all threads, each with its own box. There is now one button and one bar (`Ctrl+F`), with a **This thread / All threads** switch that keeps what you typed. In all threads the results are listed under the bar; picking one opens that thread and switches back to its highlighted matches.

### Fixed
- After an edit, Codico told the agent that the file "still contains an unreferenced local import" for imports that were unused before the task began. In a recorded task this sent the agent on an unrequested cleanup of the main file's imports, about eight requests. Only imports the edit itself left unused are reported now.
- The change report counted almost every line of a long file as changed when a task edited it in two places far apart (a 2,865-line file with 26 lines added and 1 removed was reported as +2819 −2794). Line counts are now exact unless the file was rewritten almost entirely. The same correction makes such an edit two separate changes in Edits mode's per-change review, and a short diff on the approval card, where it used to be one block of the whole region.
- Stopping a task after one of its tools had finished lost that tool's result for providers that use the text tool format (Claude Code and ChatGPT logins, Ollama): the conversation kept the call but not what it returned, so on the next message the agent did not know an edit had been applied or what a command printed. The results are now kept, as they already were with native tool calls.
- Stop waited for web fetches, browser actions, workspace searches and diagnostics to finish or time out (up to 15 seconds for a fetch, 30 for a page load) with nothing shown meanwhile. It now ends the reply at once.
- A message queued for the agent's next step is discarded with the turn it was queued in (when it is stopped or ends), not only when the next message is sent.

## 0.3.16 - 2026-10-12

### Added
- Remembered commands: a terminal command's approval card offers **Always allow in this workspace**, for the command as written or, for known build and test tools, with any arguments (`npm test *`, `git status *`, `pytest *`). Such a rule never covers a command that chains, pipes, redirects or substitutes, so `npm test; rm -rf ~` still asks. **Codico: Remembered Commands** shows the list and removes entries. Rules are stored per workspace outside the repository, and are set aside for a turn in which the agent read web or MCP content.
- Per-change review in Edits mode: a proposed edit with several separate changes lists each one under the file with its lines, and each can be accepted or rejected by itself. Accepting one writes only that change (and is its own undo step); the rest stays proposed. Until now a file's proposal could only be taken or left whole.
- A message typed while the agent works reaches it at its next step. It used to wait until the whole reply had ended, so correcting a task meant pressing Stop. It is now given to the model together with the result of the step in progress, the reply shows where it was taken in, and the task carries on. If the task finishes first, the message is sent as a normal follow-up, as before. Commands (`/…`) and messages with attachments still wait for the reply to end.
- Rewind: every message of yours has a ↺ button that takes the conversation back to just before it and puts back the files Codico changed since, across any number of turns. A dialog lists the files first and offers the conversation alone; a file you edited by hand since is asked about and kept unless you say otherwise; a file Codico created is deleted again. The removed message returns to the input box, and Redo reapplies the rewound changes one at a time. Not restored: what terminal commands changed, and changes made before VS Code was last restarted.
- Search in the provider list, as in the model list: type to narrow it, Enter takes the first match, Escape closes.

### Fixed
- The panel's top row at narrow widths: the logo was squeezed under the provider selector while unused space sat next to the buttons, and below about 450px the buttons were pushed off the panel. The buttons now stay at the right of the first row, and in a panel of 480px or less the provider, model and effort selectors take a row of their own beneath it. A long model name is cut short instead of pushing anything out.
- The provider list could not be scrolled: in a panel shorter than the list its last entries (the local providers) were cut off and out of reach. Every dropdown now fits the room it has, above or below its button, and scrolls the rest.
- The actions of a thread in the thread list (pin, rename, export, delete) were invisible until the pointer was on the row. They are now always shown, dimmed, and at full strength on hover or keyboard focus.
- The actions on your own messages (rewind, edit, delete) are likewise shown without hovering.

## 0.3.15 - 2026-10-12

### Added
- Local code search for the agent: a `search_code` tool that ranks the whole repository for a description or identifiers and returns the best-matching definitions with file and line, the symbols they define, a few of their lines and the files that import them. It is symbol-aware (files are cut at function and class boundaries; the chunk that defines a symbol outranks those that mention it; `autoCompactThreshold` and "compact threshold" find the same code), built on your machine on first use with no API key, kept current as files change, and sized for large repositories (`codico.codeSearchMaxFiles`, default 5,000 files). Source ranks above tests and documentation unless the question asks for those; a running language server's symbols and, if you built it, the embeddings index are blended in; importers are found for JavaScript and TypeScript (relative and aliased), Python, Java, Kotlin, Rust and Go; and every open workspace folder is searched. It applies the read tool's protections: nothing from `.codicoignore`d files, from files behind a symbolic link out of the workspace, from `.env` and other credential files or private keys. Available in Ask mode and to subagents.
- Lifecycle hooks: a project can run its own commands around the agent's edits and terminal commands from `.codico/hooks.json` (`beforeEdit`, `afterEdit`, `beforeCommand`, `afterCommand`, each with an optional `match`). A `before` hook that fails refuses the call and its output is given to the agent as the reason; an `after` hook's output is added to the result, so a linter or a rule check reaches the agent without being asked for. Hooks run only in a trusted workspace and after you approved the exact command once. **Codico: New Hooks File** writes a starting file.

### Fixed
- While a subagent worked, the status bar showed no token usage: its requests were added to the task total but never sent to the display. Each subagent request now updates the token count (marked "subagent") and the task total as it happens, the status reads "Subagent working…", and the context meter keeps showing the main conversation.

### Changed
- Subagents stay closer to the question. In a recorded run a subagent had its answer after 6 tool calls and made 32 more, because the task it was handed asked for definitions, tests and related code as well. Now: the agent is told to delegate exactly what it needs and no more; a subagent is told to stop as soon as it can answer; after 12 tool calls it is reminded once that it may already have the answer; and the default limit `codico.subagentMaxSteps` is 10 requests (was 15).

## 0.3.14 - 2026-10-11

### Added
- Subagents: the agent has a `delegate` tool that hands a look-around task to a second agent with a conversation of its own. The subagent reads and searches (read-only: no edits, commands, web or further delegation) and returns a short report; what it read never enters the main conversation. It can take one of the project's agents (`.codico/agents`) as its role, shows as a step with its own reads under it, counts toward the task's tokens, and is limited to `codico.subagentMaxSteps` requests (default 15). Works with every provider, in both tool formats.

### Fixed
- Ask mode with models that are used to another tool syntax (seen with Claude through the Claude Code provider): the read-only prompt showed the tool formats without saying they are the only way to call a tool, and the model wrote XML tool calls, which Codico does not run, followed by results it made up. Both prompts now say to use the fenced formats only and never to write tool results.

## 0.3.13 - 2026-10-11

### Changed
- Fewer requests per task. The agent was told to make one tool call per reply, so every look at the code cost a full request (around 36,000 tokens each in long tasks). It is now told to issue independent reads and searches together in one reply; the loop already ran several calls per reply.
- `read_file` shows line numbers (`<number><tab><text>`, like `cat -n`). Without them the agent fetched numbered text through the shell (`cat -n`, `grep -n "" file | sed -n …`), one request per look: in one recorded task 186 of 237 terminal commands were this. The prompt now also says to read and search with the read and search tools, not the terminal.
- An edit whose old text was copied with those line numbers is applied without them.
- The text tool format documents `start_line` / `end_line` for `read_file` (they were accepted but not shown).
- Less of Codico's own text in the conversation, which is resent with every request whatever the provider:
  - The note that announces a phase (after every edit: "satisfy the acceptance contract") repeated the phase's rules and the whole task description each time, about 4,900 characters. A repeat now names the phase, points to the rules and the task already in the conversation, and adds only what is new (the edited file, the next step). After a compaction the next note is complete again. On a recorded conversation this removed 9.7% of its size.
  - An edit's result no longer echoes a long insertion back in full (its first and last three lines are shown; the rest is in the edit itself), cuts lines over 240 characters, and numbers its lines like `read_file`.
  - The lifecycle audit attached to edits is for code: it is no longer added to edits of Markdown, JSON, YAML, CSS, HTML and other prose or data files, where a word like "done" or "error" set it off.

## 0.3.12 - 2026-10-11

### Added
- Drafts and reading position: each thread keeps its own unsent message and where you were reading, through thread switches, hiding the panel and reloading the window.
- Context meter in the status bar: how close the conversation is to auto-compaction, as a bar and a percentage of the threshold; the size of the last request when auto-compact is off.
- Code blocks have **Insert** (at the editor's cursor, replacing the selection) and **New file** (an untitled editor in the block's language) next to Copy.
- Export a thread as Markdown from the thread list (⤓): save to a file or copy. It holds your messages, the replies, the steps taken and each change report.
- A queued message can be edited: **Edit** on its banner puts it back in the box.
- Change report: a reply that changed files ends with a card giving a verdict (Verified, Checks failing, Not verified), the files changed with lines added and removed, the test, build, type-check and lint commands that ran with their results, and what was not covered. A check that failed earlier in the turn and passes now is marked "was failing". Results are not taken on trust: a check that ran before the last file change does not count, and neither does a success hidden behind a pipe unless the test runner's summary shows it. Built from what Codico observed, with no model request; "Copy as Markdown" for pull requests; `codico.changeReport: false` turns it off.
- MCP catalog: **🔌 MCP** in the chat header lists known servers (Playwright, Chrome DevTools, Context7, Memory, Sequential Thinking), each pinned to a version and checked to connect with Codico. A card shows the exact command; **Add…** opens a VS Code dialog with that command, its requirements and tool count, and adds the server to this project (`.mcp.json`) or to all projects (user settings) only when you choose. **Remove** takes it out. The panel can only name a catalog entry: the command always comes from the bundled catalog.
- Project skills and agents: a project can define its own, as Markdown files in a `.codico` folder committed with the code. A skill (`.codico/skills/<name>/SKILL.md`, the same layout as Claude Code's) holds the steps for one kind of task: Codico is told its name, description and path and reads it when a task matches, or you run it with `/name`. An agent (`.codico/agents/<name>.md`) is called with `@name` and puts its instructions in charge of the turn. Both appear in the `/` and `@` menus marked "project", "Codico: New Skill" and "Codico: New Agent" create a starting file, and file changes are picked up at once. Files with an unusable name, no instructions or more than 20,000 characters are skipped with a message; nothing is loaded in an untrusted folder.

### Changed
- Approving a plan switches the mode tab from Plan to Agent: the plan is being executed, and your next message is an ordinary agent message instead of a new plan.

### Removed
- The pause that asked "Continue?" every 50 steps, and its setting `codico.checkpointSteps`. A long task now runs until it is done or you press Stop; `codico.maxIterations` limits a run only if you set it (its default is no limit). The optional token budget (`codico.taskTokenBudget`) still pauses when you set one.

### Fixed
- Copy on a code block did nothing while the reply was still streaming, or in a reply loaded from a thread saved by an older version: the button was only wired up when a reply finished. Clicks are now handled in one place.
- A queued message replaced whatever you had typed while it waited. The typed text now stays in the box.
- The queued-message banner could be wider than a narrow panel.

## 0.3.11 - 2026-10-10

### Fixed
- ACCO (`codico.accoEnabled`) was applied to OpenRouter requests only: with a direct provider model (for example your own DeepSeek key) the setting did nothing. Direct provider requests now pass through ACCO too, for all three request shapes (OpenAI-compatible, Anthropic, Gemini), with the same fail-open behaviour: if ACCO is down, slow or rejects a request, the original request is sent. Ollama, Claude Code and ChatGPT requests are still not optimized.

## 0.3.10 - 2026-10-10

### Added
- Find in a conversation: `Ctrl+F` / `Cmd+F` in the chat (or the ⌕ button) opens a find bar. Matches are highlighted in messages, replies, code and reasoning, with a count and `Enter` / `Shift+Enter` to step through them; a match inside a collapsed code block, a folded run of steps or a closed reasoning trace opens it. It keeps up with a reply that is still streaming.
- A result of the search across threads now opens that thread with its matches highlighted, instead of leaving you to look for them.
- Notifications when you are not looking at the chat: a reply finished, or Codico is waiting for your approval (a file change, a command, a "continue?" pause). A desktop notification when VS Code is in the background, a notification inside VS Code with "Show Codico" when only the chat is hidden. `codico.notifications: "off"` disables it.
- First-run onboarding: a "Get started with Codico" guide opens once after install (and from the "Codico: Get Started" command), and until a provider is set up the empty chat offers the ways to do it — an OpenRouter key, your Claude Code or ChatGPT login (marked "found on this machine" or "not installed"), your own provider key, or local Ollama.

## 0.3.9 - 2026-10-10

### Added
- ChatGPT provider: run Codico through OpenAI's `codex` command and your ChatGPT login (`codex login`), with no API key. Pick "ChatGPT" in the provider menu, then GPT-6.1 Sol, GPT-6 Sol, GPT-6 Astra, GPT-6 Luna or GPT-5.5 (what your plan allows). Codex runs read-only with its shell, web search, plugins and other tools switched off and without your Codex settings — Codico keeps control of files and commands, with its approvals. The reply arrives in one piece (Codex does not stream it), an `OPENAI_API_KEY` in the environment is not passed on, and `codico.codexPath` points to the command when it is not on the PATH.
- OpenAI adapter for the direct provider (your own OpenAI key). The models are now GPT-6.1 Sol, GPT-6 Sol, GPT-6 Astra, GPT-6 Luna, GPT-5.5 and GPT-5.4 Mini; ids saved by older versions keep working. Reasoning effort follows the effort selector, and when a model refuses the option the request is sent once more without it.
- Gemini adapter for the direct provider (your own Google AI Studio key). The models are now Gemini 3.8 Flash, 3.5 Flash, 3.5 Flash Lite, 3.1 Pro, 2.5 Pro and 2.5 Flash. Thinking follows the effort selector (a thinking level on Gemini 3, a token budget on 2.5), thought summaries are shown in the reasoning panel, and cached prompt tokens are reported.
- Claude Code provider: run Codico through your installed `claude` command and Claude login, with no API key. Pick "Claude Code" in the provider menu, then Sonnet, Opus, Haiku or Fable (Claude Code's aliases for its current models). Claude Code's own tools are switched off — Codico keeps control of files and commands, with its approvals. The command is found on the PATH or inside the Claude Code VS Code extension (`codico.claudeCodePath` overrides it). Usage counts against your Claude plan's limits.
- Provider menu in the chat header: choose OpenRouter, Claude Code (your Claude login), one of the direct providers (your own key: Anthropic, OpenAI, Google, Groq, DeepSeek, Mistral, Grok, Cerebras) or local Ollama; the model menu then lists only that provider's models and remembers the last model used with each. Providers without a key are marked "no key", and picking one asks for its key. Ollama models can now be picked from the header (they were missing from the old single list).
- DeepSeek adapter for the direct provider (your own DeepSeek key). The models are now DeepSeek V4.1 Flash (`deepseek-flash`) and DeepSeek V4 Pro (`deepseek-v4-pro`); `deepseek-chat` and `deepseek-reasoner` saved by older versions keep working. Thinking is shown in the reasoning panel and follows the effort selector (Low → low, Medium → high, High → max), and the token counter shows DeepSeek's cache hits.

### Changed
- Status bar in a narrow panel: the background-process button is no longer shortened to "⚙ 1 ✕". When the row is full, it and Stop move together to a second row, both whole and at the right edge.

### Fixed
- Direct OpenAI: requests sent `max_tokens`, which OpenAI's reasoning models (o-series, GPT-5 and later) refuse, so those models failed on every request. The limit is now sent as `max_completion_tokens`, with room for the model's reasoning.
- Direct Gemini: the output limit was 8,192 tokens, which a thinking model (2.5 and later) can use up on thinking alone, cutting the answer short or leaving it empty; follow-up suggestions, commit messages and compaction summaries had the same problem with their much smaller limits. Thinking models now get 65,536 tokens, and one-shot jobs ask for little thinking and leave room for it.
- Direct Gemini 3 with tools: Gemini 3 signs each tool call and answers 400 when the call is sent back without its signature, so the agent failed after its first tool call. The signature is now stored with the call and sent back.
- Direct Gemini: thinking tokens were left out of the output token count.
- Direct DeepSeek with tools: DeepSeek requires each reply's reasoning to be sent back with later requests and answers 400 otherwise, so the agent could fail after its first tool call. The reasoning is now stored with the reply and sent back.
- With only a direct provider key set (for example DeepSeek) and no OpenRouter key, Codico still asked for an OpenRouter key: the default model is an OpenRouter one, and saving a direct key did not select one of its models. Now, when the selected model needs an OpenRouter key that is not set, Codico switches to a provider you have a key for (the same vendor when possible) and says so; saving a direct key switches straight away or offers to. The header's model selector follows the setting.
- Direct OpenAI-compatible providers now report cached prompt tokens (`prompt_tokens_details.cached_tokens`).

## 0.3.8 - 2026-10-10

### Fixed
- The task list's progress bar never filled (it was an inline element, which ignores width).
- "↓ Jump to latest" could sit over the Attach toolbar; it now stays inside the message area.
- The Stop button was pushed out of view when the background-process chip appeared in a narrow panel. The status bar now shortens its text with "…", the chip becomes "⚙ 1 ✕" when space is short (full text on hover), and Stop stays visible.
- Compaction could replace the conversation with a broken "summary": some models (seen with DeepSeek V4 Flash) continued the transcript in its own format instead of summarising it, Codico accepted any non-empty answer, and the agent forgot the work it had done (then re-read files to recover). The transcript is now delimited with the instruction repeated after it; an answer that copies the transcript or is far too short is rejected and retried once, and otherwise the history is kept unchanged. A failed automatic compaction is not retried on every step, and the summary has more room (4,000 tokens, low reasoning effort on OpenRouter).

### Changed
- Reading a large file (over 600 lines) without a line range returns an outline of its functions or sections with their line ranges, and its first 80 lines, so the agent reads only the part it needs instead of paging through the file 300 lines at a time (each page stays in the context and is resent with every request).
- An edit's result shows 10 lines around the change (was 3), so the next nearby edit usually needs no re-read.
- Auto-compaction starts at 60,000 prompt tokens by default (was 100,000), keeping long tasks' requests smaller.
- The task list (plan execution and the agent's own task list) is redesigned: numbered badges that turn into a green check when done or a red cross when failed, the task in progress highlighted with a pulsing ring, a bold title with its details below, code and bold rendered instead of raw backticks, and "3 of 14 done" in the header, which also names the task in progress while the list is collapsed.
- The task token total shows how much was served from the provider's cache ("task 7.6M tok (82% cached)"); cached tokens are counted but billed at a fraction of the price.

## 0.3.7 - 2026-10-09

### Added
- Grouped tool steps: when a reply finishes, runs of three or more steps collapse into one line ("12 steps · read 7 files, searched 3×, ran 2 commands") that expands on click. Failed steps, terminal output and diffs stay visible; steps are shown live while the agent works.
- Progress header for tasks that take more than a moment: current activity, elapsed time, plan step ("step 3 of 6") and the task's tokens and cost.
- "Open diff" on every change the agent made opens VS Code's diff editor (the file before the change against now). Long diffs in the chat show their first 40 lines, with "Show all".
- Thread list: grouped into Pinned / Today / Yesterday / This week / Older, pin to the top, a preview line, and each thread's total tokens and cost on hover.
- Suggestions on an empty panel (explain the project, fix the N errors in the Problems panel, tests and improvements for the open file).
- Long replies get an outline of their headings and a link to their summary.
- Settings `codico.chatDensity` (comfortable / compact) and `codico.showReasoning`.

### Changed
- Thinking effort now defaults to Medium instead of High (High spends noticeably more reasoning tokens on every step); High is still one click away in the header.
- Approval cards: Allow comes first, "Allow all writes / commands this task" says what it covers, Deny comes last.
- Attachment chips show their size, and warn when a file was cut to 20,000 characters.

## 0.3.6 - 2026-10-09

### Added
- Edit and resend a message (✎ on hover): the conversation is cut back to that message and the edited text is sent; for a Plan-mode message the goal is edited. Delete (🗑) removes a message and everything after it, after a confirmation. The panel, the saved thread and the history the model sees are cut at the same point. Messages already folded into a compaction summary cannot be changed.
- Regenerate (↻) on the latest reply runs its message again and replaces the reply.
- Message times ("2m ago", full date on hover), saved with the thread so reopened conversations show when messages were sent.
- Long code blocks (over 25 lines) in finished replies are collapsed to a preview with an Expand button; the header shows the line count.
- File paths in replies (`src/app.ts:42`, or a path with a folder in plain text) and in tool steps (Reading / Editing / Written) open the file, at the line when one is given.
- Keyboard: ↑ in an empty input edits your last message; Esc stops the reply.
- While a reply streams, scrolling up to read no longer gets pulled back to the bottom; a "↓ Jump to latest" button returns to it.
- Drag and drop files onto the chat to attach them: text files as file context, images as image attachments. From VS Code's Explorer hold Shift while dragging; workspace files excluded by `.codicoignore` are refused.

### Changed
- An approved plan is saved in the thread as "✅ Plan approved — executing…", as shown live, instead of the full execution prompt.

## 0.3.5 - 2026-10-09

### Changed
- Prompt caching: requests to Claude models (direct and through OpenRouter) now ask the provider to cache the conversation, so each request in a task re-reads what was already sent at about a tenth of the price. The system prompt and tool list no longer change during a task (phase guidance is added to the conversation instead), so providers that cache automatically (OpenAI, DeepSeek, Gemini, Grok…) get cache hits too. The token counter shows the cached share. On a recorded 63-request task, billed input dropped from ~6.0M to the equivalent of ~0.9M tokens at Claude cache pricing.
- Approving a plan removes the planning turn's file reads from the context (the plan stays); the agent re-reads what it needs. About 1M fewer tokens sent on the same task.
- A tool result repeated unchanged later in a task (e.g. a file read twice) is sent only once.

### Fixed
- While a change awaited verification there was no iteration limit, so a model whose tool calls could not run (repeats blocked as a loop, phase-blocked or invalid calls) kept going forever. The task now stops after three such iterations in a row.
- Security: `fetch_url` and the browser could reach localhost and cloud metadata through IPv6 forms that embed an IPv4 address (`http://[::ffff:127.0.0.1]` — URLs rewrite it to `[::ffff:7f00:1]`, which the filter did not recognise). IPv4-mapped, IPv4-compatible, NAT64, 6to4 and Teredo addresses are now checked by their embedded address.
- Security: browser pages could open WebSocket connections to local services (WebSockets are not covered by request routing); they now go through the same network policy.
- Terminal: commands got an open input, so one that prompts (an `npx` install, `npm init`) waited until the 5-minute timeout. Commands now get no input and fail at once.
- Terminal: the model saw only the first 4,000 characters of a command's output, missing the failures and summary that test runners and builds print last (it then re-ran them). It now sees the start and, mostly, the end; past the 1 MB capture limit the end is kept too.
- Inline completions, next-edit suggestions, AI rename, inline chat and commit messages sent the selected model to OpenRouter even when it was a direct-provider model (or Ollama, where unsupported), so every request failed — on every pause in typing for completions. They now explain that the model is not supported (once, for features that run while typing) instead of sending requests.
- Superseded inline-completion and next-edit requests were never settled (one stranded promise per keystroke).
- MCP: a request from the server (such as `ping`) could be taken as the reply to one of Codico's requests, because both sides number requests from 1; the tool list then came back empty or a tool call returned nothing. Server requests are now answered (`ping`) or declined.
- MCP: writing to a server that had exited could raise an unhandled pipe error and crash the extension host.
- MCP: a server whose handshake failed was left running in the background (on every start and Refresh MCP); it is now stopped.
- MCP: tool results had no size limit, so one large result was resent with every later request of the task. Results are now capped at 20,000 characters, with a note.
- MCP: Stop now cancels a running tool call (and tells the server); calls may run up to 5 minutes instead of failing after 30 seconds.
- MCP: an invalid `.mcp.json` was silently ignored as if missing; a warning now explains why its servers did not start.
- The loop guard flagged normal work as a loop: re-reading a file after editing it, or re-running the tests after a fix, was blocked from the 4th time in a task. Repeats now only count while nothing has changed (a write resets reads, searches and commands; a command resets reads); identical writes and edits still count.

## 0.3.4 - 2026-10-09

### Fixed
- Stop was ignored while a turn was still preparing its request (reading keys, building context, `/pr` and `@agent` lookups), so the whole task ran anyway; a thread switch or Clear in that window waited for the entire task. Stop now cancels the turn from its first moment.
- A failing panel action (accepting an edit, Undo/Redo, previewing a diff, refreshing MCP) during a running task marked the agent idle, so a queued message started while the task was still running. The running task is no longer affected.
- Errors while starting a queued message or a resumed session were silently lost; they are now shown in the panel.
- Turning Edits mode on or off, or refreshing MCP servers, during a running task now takes effect when the task ends, instead of discarding its pending proposals or disconnecting a server it was calling.
- Undo, Redo and accepting an Edits-mode proposal overwrote the file even if it had changed since (hand edits were silently lost). Codico now asks before overwriting a changed file.
- Approving a write or edit applied content computed before the prompt, overwriting changes the user made while it was open. Edits are now re-applied to the current file, and a write to a file that changed is not made (the model is told to re-read it).
- Files open with unsaved changes were read and edited on disk, so the model saw stale content and saving ended in a conflict. Codico now reads the editor's buffer and writes through it.
- write_file reported a failed write (and skipped Undo) when the file was written but could not be shown as text.
- After a repeated tool call was detected, later tool calls in the same response still ran; they are now skipped.
- Non-English text and emoji could be corrupted ("�") when a character arrived split across two network chunks, in the chat and in files the agent wrote. All providers, terminal output and helper requests now decode text across chunk boundaries.
- A provider that kept the connection open but stopped sending hung the task until Stop. After 5 minutes of silence (`codico.streamStallTimeoutSeconds`) the connection is now treated as dropped and the agent reconnects.
- Undo, Redo and Edits-mode proposals used the wrong file when the model gave an absolute path or a path in another folder of a multi-root workspace (Undo wrote a stray copy; accepting failed with "Unsafe file path rejected").
- Security: a symbolic link inside the workspace (e.g. `docs -> ~/.ssh`) let tools read or write files outside it. Paths that lead outside the workspace through a link, or through a dangling link, are now refused.
- A `<think>` tag split across chunks leaked the model's reasoning into the reply as raw text.

## 0.3.3 - 2026-10-09

### Changed
- Plan mode shows the plan as a card: numbered step badges, a bold title per step with its full description underneath, and inline code and bold rendered instead of raw markdown. Description lines written under a step heading are now kept; every step and its complete text are shown. The execution tracker shows each step in full.

### Fixed
- Bold text inside a plan step no longer loses its formatting.
- Switching, creating, deleting or clearing a thread while the agent was working let the running turn write into the other thread. These actions now stop the running turn first.
- A plan queued behind another plan could run without read-only mode; queued work now starts after the previous turn has fully finished.
- Edits mode kept only the last of several edits to the same file, and could not edit a file created by a pending write; edits now build on the pending proposal.
- Approve & Execute, follow-up chips, clarify answers, Review and editor commands were silently dropped while the agent was finishing a turn; they are now queued.
- Approval diffs were empty when every change was below line 500; diffs now cover the whole file.
- Pressing Stop just before a checkpoint could leave the turn waiting for a click.
- An error after mid-task compaction could corrupt the history with empty entries.
- Stop now also cancels an in-progress compaction summary (no further request is billed and the history is left unchanged).
- The Compact button could run at the same time as a message sent while it was starting.

## 0.3.2 - 2026-10-09

### Fixed
- Plan mode: answering the planner's clarifying question started a normal agent turn that edited files before any plan existed. The answer now continues the plan, read-only, with the original goal.
- Auto-compaction during a long task could erase the user's current request (the agent then lost the goal and answered something else) and leave a tool result without its call. Compaction now keeps the current request verbatim, summarises older work with recent information first, and only cuts between complete exchanges.
- `search_files` patterns like `a|b` sent without regex mode silently found nothing; when a literal search finds nothing and the pattern is clearly a regex, it is searched as one and the result says so.
- The "resume interrupted session" banner now names the latest request, and plan requests appear as "📋 Plan: …" in saved transcripts, thread names and notifications.

### Changed
- Codico marks where its injected `[Context]` ends and the user's own text begins (`[User request]`).

## 0.3.1 - 2026-10-09

### Fixed
- Plan mode withheld Approve & Execute for valid plans whose steps were written in bold, as headings, or as "Step N:" ("No plan steps were produced"). Those formats are now recognised, and a reply ending with "Approve the plan to begin execution" is always approvable.

## 0.3.0 - 2026-10-08

### Added
- Status bar shows the running token total for the current task and, with OpenRouter, its provider-reported cost.
- `codico.taskTokenBudget` (default 0 = off): pause with Continue / Stop each time a task uses that many more tokens.
- Panel UI test suite (`npm run test:ui`) and live scenarios for native tool calls and browser automation.

### Security
- Web pages, browser text and MCP tool output reach the model inside a delimited `<untrusted_content>` block, and the system prompt declares such blocks to be data, never instructions.
- After the agent reads external content in a turn, Allow All no longer auto-approves terminal commands; each is shown again with a note.

### Fixed
- Plan mode could change code before the plan was approved: plans are now generated under Ask-mode rules enforced in code (read-only tools, no "make a code change" reminders), and nothing changes until you click Approve & Execute.
- Plan mode's Approve & Execute button could go missing, or appear on an unrelated reply. It is now tied to the plan's own reply, and is shown only when the plan has numbered steps.
- Plan requests sent while the agent is finishing a turn are queued instead of dropped; Ask mode no longer gets "make a code change" reminders.
- Replies started by the extension (CodeLens, editor commands, `/test`, …) now show the Stop button and a working status.

### Changed
- Activation is much faster: `playwright-core` is loaded only on first browser use, and the extension is bundled with esbuild (load time ~0.7 s to ~0.05 s).
- The VSIX ships only the bundle and its one runtime dependency: 121 files / 2.9 MB, down from about 1,280 files / 9 MB (earlier releases also picked up test-harness packages from the build machine).
- Licensed under MIT.

## 0.2.2 - 2026-10-08

### Fixed
- Runaway verification loop: after a file write, a model that kept ending its turn without running a check was reminded indefinitely, sending model requests without limit (2,363 in 50 seconds in a live test, until the extension host ran out of memory). The turn now ends with a visible notice after 3 consecutive reminders that get no tool call; a model that is still calling tools continues as before.
- Writing documentation or plain-text files (`.md`, `.txt`, `.rst`, `LICENSE`, `CHANGELOG`, …) no longer requires a verification step.

### Added
- Live agent test suite (`npm run test:live`, CI job `live-agent`): 22 scenarios run the real agent loop in VS Code against a local fake model server, covering file edits, security boundaries, terminal limits, provider failures and stream recovery.

## 0.2.1 - 2026-10-08

### Fixed
- Native tool calling: a model calling `clarify` as a function no longer fails with "Provider returned invalid arguments for native tool clarify". The call is shown as the interactive clarifying question and the turn waits for the user's answer.
- Native tool calls naming an unknown tool or carrying unusable arguments now return an explanatory tool result, so the model can correct the call instead of the turn ending.
- Queued follow-up messages are no longer dropped when the previous turn is still finishing (saving history, auto-compacting, or waiting on the completion notification); they run as soon as the agent is free, and Stop cancels them.
- The README logo rendered as a broken image because `media/logo.png` is corrupt; the README now uses the intact `media/logo-128.png`.

### Changed
- The completion notification no longer keeps the agent busy until it is dismissed.
- Evaluation tasks and scripts (`eval/`, `scripts/`) are no longer shipped in the VSIX.

## 0.2.0 - 2026-10-08

### Added
- Optional local ACCO provider-boundary optimization for OpenRouter requests, disabled by default and fail-open without changing Codico's canonical history, agent loop, mutations, or verification state.
- ACCO evaluation telemetry for optimization attempts, changed requests, fail-open events, input/output characters, characters saved, and latency.
- Multi-root-aware `.codicoignore` enforcement across Codico file reads, listings, searches, writes, edits, and diagnostics, with `.copilotignore` retained for compatibility.
- Centralized workspace path/security policy shared by file tools and diagnostics.
- Paired ACCO-on / ACCO-off frozen-holdout validation and regression coverage for provider optimization behavior.

### Changed
- Agent evidence access stays available through mutation and verification instead of being hard-blocked by exploration counters.
- Stream-resume overlap verification now accepts correct recovery integration through exported wrappers while preserving the same behavioral overlap contract.
- `AgentProvider` sheds duplicated workspace-path/security logic into dedicated modules and remains below the architecture budget.
- README security, ACCO, release, and workspace-policy documentation now matches the shipped behavior.

### Security
- Browser automation now fails closed on malformed URLs and rejects non-HTTP(S) schemes such as `file:`, `data:`, `javascript:`, and `chrome:`.
- Terminal subprocesses no longer inherit the full VS Code process environment; only execution/toolchain/system variables are passed through by default.
- Workspace file access is centrally confined and multi-root aware.
- The misleading no-op `FileManager.requestPermission()` API was removed.

### Validation
- Frozen paired `stream-resume-overlap` runs produced the same 5/6 success rate with ACCO enabled and disabled; in that experiment median successful-run provider tokens fell from 1,362,844 to 672,686 with ACCO enabled.
- CI continues to cover Ubuntu, Windows, macOS, a real VS Code Extension Host, VSIX packaging, and packaged-extension smoke installation.

## 0.1.1 - 2026-10-05

### Fixed
- Chat panel was unresponsive in 0.1.0: a syntax error in the webview script left every button, input and message handler unwired.

### Added
- Regression test that parses every webview script (`chat.html` inline scripts and `media/*.js`), so a webview syntax error fails CI.
- Marketplace `AI` / `Chat` categories and search keywords.

## 0.1.0 - 2026-10-05

### Added
- Provider-native tool/function calling for OpenRouter and supported direct providers, with fenced tools retained as a compatibility fallback.
- Provider-native tool-call/result history round-tripping across iterations for OpenAI/OpenRouter, Anthropic, and Gemini.
- Automatic fallback to fenced compatibility mode when OpenRouter or a direct provider rejects native tools.
- DNS-resolved and DNS-pinned `fetch_url` protection against private-address redirects and DNS rebinding.
- Browser public-network enforcement for navigation, redirects, and subresources, with explicit `codico.browserAllowPrivateNetwork` opt-in for localhost/internal apps.
- Minimal MCP child-process environment inheritance.
- Fault/integration coverage for real SSE disconnects, native tool fragments, provider serializers, browser/DNS policy, MCP environment policy, and terminal timeout/abort behavior.
- Real VS Code Extension Host activation smoke test.
- VSIX install/list smoke test in CI and release workflows.
- VSIX packaging on pull requests plus tag/manual release automation for GitHub Releases, Visual Studio Marketplace, and Open VSX.

### Changed
- Secure URL fetching, terminal process lifecycle, MCP environment policy, provider conversation serialization, workspace diagnostics, agent history mutation, Markdown rendering, and stream notice rendering are split out of the main provider/webview monoliths.
- Codico package version moves from prototype `0.0.1` to release candidate `0.1.0`.
