import * as crypto from 'crypto';
import { appendAssistantIteration } from './agentHistory';
import { NativeToolCall, NativeToolDefinition, nativeToolCallToToolCall, getNativeToolDefinitions, invalidNativeCallResult } from './nativeTools';
import { ChatMessage, CHAT_SYSTEM_PROMPT, StreamChunk } from './openRouterClient';
import { parseToolBody, scanToolFences, ToolCall } from './toolParser';

/**
 * A subagent: a second agent with a conversation of its own, started by the main agent's
 * `delegate` tool to look something up. It reads and searches as much as the question needs
 * and returns a report; only the report enters the main conversation, which therefore stays
 * small however much had to be read.
 *
 * Subagents are read-only: they cannot edit files, run commands or delegate further.
 */

/** What a subagent may use. No edits, no commands, no web, and no `delegate`. */
export const SUBAGENT_TOOLS: ReadonlySet<ToolCall['type']> = new Set(['read_file', 'list_directory', 'search_files', 'find_files', 'get_diagnostics', 'lsp_symbol']);

export const SUBAGENT_DEFAULT_MAX_STEPS = 10;
/** After this many tool calls a subagent is reminded, once, that it may already be able to answer. */
export const SUBAGENT_NUDGE_AFTER_CALLS = 12;
const NUDGE = `[System] You have made ${SUBAGENT_NUDGE_AFTER_CALLS} tool calls. If you can answer the task now, write your report in this response instead of looking further; keep going only for something the task asked for that you still do not know.`;
/** A report longer than this is cut: the point of a subagent is a short answer. */
export const SUBAGENT_MAX_REPORT_CHARS = 8000;

const SUBAGENT_RULES = `## You are a subagent

Another agent has delegated one task to you. It will not see anything you read: it only receives your final message. Make that message a complete report.

- Do the task you were given and nothing else. You cannot ask questions; if the task is ambiguous, say what you assumed.
- You are read-only: you cannot change files or run commands, and nothing you write is applied.
- Look only as far as the task needs. Issue independent reads and searches together in one response.
- Stop as soon as you can answer. Once a search has shown where something is, do not confirm it again by other routes, and do not go on to related topics, tests or documentation the task did not ask about. One targeted search that answers the question is a complete job.
- Finish with the report: the answer first, then the evidence as file paths with line numbers, quoting only the lines that matter. Say plainly what you could not find or did not check.
- Keep the report short (well under 800 words). Do not paste whole files.`;

/** The system prompt of a subagent: the read-only agent's tools, the subagent rules, and its role if it has one. */
export function subagentSystemPrompt(role?: { name: string; instructions: string }): string {
    const roleText = role ? `\n\n## Your role: ${role.name}\n\n${role.instructions}` : '';
    return `${CHAT_SYSTEM_PROMPT}\n\n${SUBAGENT_RULES}${roleText}`;
}

export interface SubagentDeps {
    /** One model request with the subagent's own conversation and system prompt. */
    request(history: ChatMessage[], systemPrompt: string, tools: NativeToolDefinition[]): AsyncIterable<StreamChunk>;
    /** Runs one of the allowed tools and returns its result text. */
    runTool(tool: ToolCall): Promise<string>;
    /** Whether the provider is given native tool definitions (otherwise tools are fenced blocks in the text). */
    nativeTools: boolean;
    signal: AbortSignal;
    maxSteps?: number;
    onUsage?(usage: Extract<StreamChunk, { type: 'usage' }>): void;
}

export interface SubagentResult {
    report: string;
    /** Model requests made. */
    requests: number;
    /** Tool calls executed. */
    toolCalls: number;
    outcome: 'done' | 'step-limit' | 'stopped' | 'failed';
}

/** A tool call in a syntax other than Codico's fenced blocks. */
const PSEUDO_TOOL_CALL_RE = /<invoke\b|<function_calls>|<tool_call>|<tool_use>/;

function refusal(type: string): string {
    return `[${type}] Not available to a subagent: it can only read and search (${[...SUBAGENT_TOOLS].join(', ')}). Report what you found instead.`;
}

/** Runs a subagent to completion and returns its report. Never throws: a failure is reported in the result. */
export async function runSubagent(task: string, deps: SubagentDeps, role?: { name: string; instructions: string }): Promise<SubagentResult> {
    const maxSteps = Math.max(1, deps.maxSteps ?? SUBAGENT_DEFAULT_MAX_STEPS);
    const systemPrompt = subagentSystemPrompt(role);
    const tools = deps.nativeTools ? getNativeToolDefinitions(true).filter(tool => SUBAGENT_TOOLS.has(tool.name as ToolCall['type'])) : [];
    const history: ChatMessage[] = [{ role: 'user', content: `[Delegated task]\n${task.trim()}` }];
    let requests = 0;
    let toolCalls = 0;
    let lastText = '';
    let corrections = 0;
    let nudged = false;
    /** True once, when the call count first reaches the reminder point. */
    const nudgeDue = (): boolean => { if (nudged || toolCalls < SUBAGENT_NUDGE_AFTER_CALLS) { return false; } nudged = true; return true; };

    const finish = (outcome: SubagentResult['outcome'], report: string): SubagentResult => {
        const text = report.trim();
        const cut = text.length > SUBAGENT_MAX_REPORT_CHARS ? `${text.slice(0, SUBAGENT_MAX_REPORT_CHARS)}\n… (report cut at ${SUBAGENT_MAX_REPORT_CHARS.toLocaleString('en-US')} characters)` : text;
        return { report: cut, requests, toolCalls, outcome };
    };

    try {
        for (let step = 0; step <= maxSteps; step++) {
            if (deps.signal.aborted) { return finish('stopped', lastText); }
            // The step after the last: no tools are offered, only the report is asked for
            const lastChance = step === maxSteps;
            if (lastChance) {
                history.push({ role: 'user', content: '[System] You have used all your steps. Do not call any tool. Write your report now from what you have found, and say what is still unknown.' });
            }

            let content = '';
            let reasoning = '';
            let failure = '';
            const calls: Array<NativeToolCall & { id: string }> = [];
            requests++;
            for await (const chunk of deps.request(history, systemPrompt, lastChance ? [] : tools)) {
                if (deps.signal.aborted) { break; }
                if (chunk.type === 'content') { content += chunk.text; }
                else if (chunk.type === 'native_tool') { calls.push({ ...chunk.call, id: chunk.call.id ?? `sub_${crypto.randomBytes(6).toString('hex')}` }); }
                else if (chunk.type === 'reasoning') { reasoning = chunk.text; }
                else if (chunk.type === 'usage') { deps.onUsage?.(chunk); }
                else if (chunk.type === 'stream_error') { failure = chunk.message; }
            }
            if (deps.signal.aborted) { return finish('stopped', content || lastText); }
            if (failure && !content && calls.length === 0) { return finish('failed', `The subagent's request failed: ${failure}${lastText ? `\n\nBefore that it had written:\n${lastText}` : ''}`); }
            if (content.trim()) { lastText = content; }
            if (lastChance) { return finish('step-limit', content || 'The subagent used all its steps without writing a report.'); }

            // Native tool calls: each result is its own tool message
            if (calls.length > 0) {
                const executions = [];
                for (const call of calls) {
                    const tool = nativeToolCallToToolCall(call);
                    const result = !tool ? invalidNativeCallResult(call) : !SUBAGENT_TOOLS.has(tool.type) ? refusal(tool.type) : await deps.runTool(tool);
                    if (tool && SUBAGENT_TOOLS.has(tool.type)) { toolCalls++; }
                    executions.push({ call, result });
                    if (deps.signal.aborted) { break; }
                }
                appendAssistantIteration(history, content, executions, '', reasoning);
                if (nudgeDue()) { history.push({ role: 'user', content: NUDGE }); }
                continue;
            }

            // Fenced tool calls in the text: the results go back together in one user message
            const scan = scanToolFences(content, 0, true);
            const fenced = scan.fences.flatMap(fence => parseToolBody(fence.type, fence.body).slice(0, 1));
            if (fenced.length === 0) {
                // A tool call written in a syntax Codico does not read (seen with models used to XML calls),
                // often followed by results the model made up: not a report. Say so and let it try again.
                if (PSEUDO_TOOL_CALL_RE.test(content) && corrections < 2) {
                    corrections++;
                    appendAssistantIteration(history, content, [], '', reasoning);
                    history.push({ role: 'user', content: '[System] That was not a tool call Codico can run, so nothing was executed and any results you wrote are not real. Call tools only with the fenced code block formats from the instructions (for example a block opened with ```read_file), then wait for the real results.' });
                    continue;
                }
                return finish('done', content || 'The subagent finished without writing a report.');
            }
            const results: string[] = [];
            for (const tool of fenced) {
                if (SUBAGENT_TOOLS.has(tool.type)) { toolCalls++; results.push(await deps.runTool(tool)); } else { results.push(refusal(tool.type)); }
                if (deps.signal.aborted) { break; }
            }
            appendAssistantIteration(history, content, [], '', reasoning);
            history.push({ role: 'user', content: `[Tool Results]\n\n${results.join('\n\n---\n\n')}${nudgeDue() ? `\n\n${NUDGE}` : ''}` });
        }
    } catch (err) {
        return finish('failed', `The subagent failed: ${err instanceof Error ? err.message : String(err)}${lastText ? `\n\nBefore that it had written:\n${lastText}` : ''}`);
    }
    return finish('step-limit', lastText);
}

/** The `delegate` tool's result, as the main agent reads it. */
export function delegateResultText(task: string, result: SubagentResult): string {
    const how = `${result.requests} request${result.requests === 1 ? '' : 's'}, ${result.toolCalls} tool call${result.toolCalls === 1 ? '' : 's'}`;
    const note = result.outcome === 'step-limit' ? ' It ran out of steps: the report may be incomplete.'
        : result.outcome === 'stopped' ? ' It was stopped before it finished.'
        : result.outcome === 'failed' ? ' It did not complete.' : '';
    return `[delegate] The subagent has reported (${how}).${note} Its reads are not in this conversation: rely on the report, and read a file yourself only for what you are about to edit.\n\nTask: ${task.trim().split('\n')[0].slice(0, 200)}\n\n## Subagent report\n\n${result.report || '(empty)'}`;
}

/** What the turn in progress gives its subagents: how to reach the model, and where usage is counted. */
export type SubagentHost = Pick<SubagentDeps, 'request' | 'nativeTools' | 'onUsage'>;

/**
 * Runs the `delegate` tool: resolves the optional project agent, runs the subagent, and
 * returns the text for the main agent with a one-line outcome for the panel.
 */
export async function runDelegate(
    tool: { task: string; agent?: string },
    host: SubagentHost | undefined,
    agents: Array<{ name: string; instructions: string }>,
    run: Pick<SubagentDeps, 'runTool' | 'signal' | 'maxSteps'>,
): Promise<{ text: string; label: string; success: boolean; error?: string }> {
    const label = tool.task.trim().split('\n')[0].slice(0, 80);
    if (!host) {
        return { text: '[delegate] ERROR: no task is running to delegate from. Do the reading yourself.', label, success: false, error: 'No task is running' };
    }
    const role = tool.agent ? agents.find(agent => agent.name === tool.agent?.trim().toLowerCase().replace(/^@/, '')) : undefined;
    if (tool.agent && !role) {
        const known = agents.length > 0 ? `The project's agents are: ${agents.map(agent => agent.name).join(', ')}.` : 'This project defines no agents.';
        return { text: `[delegate] ERROR: there is no project agent named "${tool.agent}". ${known} Call delegate again without "agent", or with one of those names.`, label, success: false, error: `No agent "${tool.agent}"` };
    }
    const result = await runSubagent(tool.task, { ...host, ...run }, role);
    const summary = `${label} \u2014 ${result.requests} request${result.requests === 1 ? '' : 's'}, ${result.toolCalls} tool call${result.toolCalls === 1 ? '' : 's'}`;
    const failed = result.outcome === 'failed' || result.outcome === 'stopped';
    return { text: delegateResultText(tool.task, result), label: summary, success: !failed, error: failed ? (result.outcome === 'stopped' ? 'Stopped' : 'Did not complete') : undefined };
}

