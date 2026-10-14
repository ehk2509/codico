import * as vscode from 'vscode';
import * as path from 'path';
import * as nodeCrypto from 'crypto';
import { streamOpenRouter, testOpenRouterEndpoint, ChatMessage, StreamChunk } from './openRouterClient';
import { streamOllama } from './ollamaClient';
import { streamDirect, parseDirectModelId } from './directProviderClient';
import { parseToolBody, scanToolFences, ToolCall } from './toolParser';
import { Approvals } from './approvals';
import { Compaction } from './compaction';
import { STOPPED_NOTE, addSteer, steerNote } from './steering';
import { isRecoverableStreamInterruption, isUnfulfilledActionAnnouncement, normalizeFinishReason, repeatedPrefixLength, RESUME_OVERLAP_WINDOW } from './streamCompletion';
import { getNativeToolDefinitions, nativeToolCallToToolCall, nativeClarifyBlock, invalidNativeCallResult, NativeToolCall, NativeToolDefinition } from './nativeTools';
import { SubagentHost } from './subagent';
import { appendAssistantIteration, NativeToolExecution } from './agentHistory';
import { DisplayMessage, ExtensionMessage } from './chatProtocol';
import { EvaluationToolTraceEvent } from './evaluationMetrics';
import { projectHistoryForModel } from './contextProjection';
import { evaluationToolTarget } from './evaluationTrace';
import { ExplorationController } from './explorationController';
import { shouldRunAgentIteration } from './iterationBudget';
import { accoOptimizerFromConfiguration } from './accoProviderOptimizer';
import { TaskUsage } from './taskUsage';
import { appendPhaseNote, splitPhasePrompt } from './agentPhasePrompt';
import { ReminderLog } from './leanContext';
import { ToolLoopGuard } from './toolLoopGuard';
import { streamCliModel } from './cliProviders';

/**
 * One turn of the agent: requests to the model, the tools it calls, recovery from cut-off
 * replies, verification reminders and the stop rules, until the reply is complete. What it
 * needs from the conversation and the editor comes through the host, so the loop itself
 * knows nothing of the panel or of how threads are stored.
 */
export interface TurnHost {
    readonly approvals: Approvals;
    readonly autoCompact: boolean;
    compactRetryAt: number;
    readonly compaction: Compaction;
    displayMessages: DisplayMessage[];
    evalBudgetExceeded: boolean;
    evalCompletionTokens: number;
    evalProjectedCharsOmitted: number;
    evalPromptTokens: number;
    evalSteps: number;
    evalToolCalls: number;
    evalTrace: EvaluationToolTraceEvent[];
    readonly evaluationMode: boolean;
    readonly evaluationTokenBudget: number;
    history: ChatMessage[];
    lastInlineResult: string | undefined;
    lastPromptTokens: number;
    readonly readOnly: boolean;
    steer: string;
    subagentHost: SubagentHost | undefined;
    readonly thinkingEffort: 'high' | 'medium' | 'low';
    post(message: ExtensionMessage): void;
    /** Runs one tool call; its result is left in lastInlineResult. */
    dispatchTool(tool: ToolCall, msgId: string, signal: AbortSignal): Promise<void>;
}

/** What the turn was set up with: the model and its keys, the system prompt, limits and accounting. */
export interface TurnSetup {
    accoOptimizer: ReturnType<typeof accoOptimizerFromConfiguration>;
    apiKey: string;
    config: vscode.WorkspaceConfiguration;
    directApiKey: string;
    directParsed: ReturnType<typeof parseDirectModelId>;
    displayRollbackLen: number;
    effectivePrefix: string | undefined;
    historyRollbackLen: number;
    isCli: boolean;
    isDirect: boolean;
    isOllama: boolean;
    maxIterations: number;
    model: string;
    msgId: string;
    mutationGraceIterations: number;
    nativeToolCalling: boolean;
    ollamaBaseUrl: string;
    ollamaModel: string;
    rawText: string;
    taskUsage: TaskUsage;
    verificationGraceIterations: number;
    signal: AbortSignal;
}

export class AgentTurn {
    constructor(private readonly _host: TurnHost) {}

    async run(setup: TurnSetup): Promise<void> {
        const { accoOptimizer, apiKey, config, directApiKey, directParsed, displayRollbackLen, effectivePrefix, historyRollbackLen, isCli, isDirect, isOllama, maxIterations, model, msgId, mutationGraceIterations, nativeToolCalling, ollamaBaseUrl, ollamaModel, rawText, taskUsage, verificationGraceIterations, signal } = setup;
        const MAX_STREAM_RECOVERY_ATTEMPTS = 5;
        let streamRecoveryAttempts = 0;
        // Visible text just before a cutoff; the resumed response is checked against it
        // so any restarted sentence is dropped and the seam stays invisible.
        let resumeTail: string | null = null;
        let recoveryStatusShown = false;
        const MAX_ACTION_NUDGES = 2; let actionNudges = 0;
        // Reminders answered without any tool call before the turn stops instead of
        // re-sending them (each reminder is another paid model request).
        const MAX_STALLED_VERIFICATION_NUDGES = 3;
        let verificationNudges = 0;
        // Iterations in a row in which no tool call could run (repeats, blocked calls): ends a stuck
        // model, since there is no iteration limit while a change awaits verification
        const MAX_BLOCKED_ONLY_ITERATIONS = 3;
        let blockedOnlyIterations = 0;
        let currentPhaseNote: string | undefined = ''; // undefined: compaction may have dropped the note
        const nativeTools = !isOllama && !isCli && nativeToolCalling
            ? getNativeToolDefinitions(this._host.readOnly)
            : [];

        // Circuit breaker for a model repeating the same call while nothing changes
        const loopGuard = new ToolLoopGuard();
        // Read-only turns (Ask mode, planning) must not be nudged to "make the code change"
        const exploration = new ExplorationController(this._host.readOnly ? '' : rawText, maxIterations);
        const reminders = new ReminderLog();
        try {
            // One request to the selected provider. The main loop and its subagents share it.
            const requestModel = (history: ChatMessage[], prefix: string | undefined, override: string | undefined, tools: NativeToolDefinition[]): AsyncIterable<StreamChunk> => isCli
                ? streamCliModel(model, history, prefix, signal, this._host.thinkingEffort, override)
                : isOllama
                ? streamOllama(ollamaBaseUrl, history, ollamaModel, prefix, signal, override)
                : isDirect && directParsed
                    ? streamDirect(directApiKey, history, directParsed.providerId, directParsed.modelId, prefix, signal, this._host.thinkingEffort, override, tools, this._host.evaluationMode ? testOpenRouterEndpoint(process.env.CODICO_TEST_DIRECT_URL) : undefined, accoOptimizer)
                    : streamOpenRouter(apiKey, history, model, prefix, signal, this._host.thinkingEffort, override, tools, this._host.evaluationMode ? testOpenRouterEndpoint(process.env.CODICO_TEST_OPENROUTER_URL) : undefined, accoOptimizer);
            // A subagent has its own conversation and system prompt; its usage counts toward this task
            this._host.subagentHost = {
                request: (history, systemPrompt, tools) => requestModel(history, undefined, systemPrompt, tools),
                nativeTools: nativeTools.length > 0,
                onUsage: usage => { taskUsage.add(usage.totalTokens, usage.costUsd, usage.cachedTokens, usage.promptTokens, usage.completionTokens, 'subagent'); this._host.post({ type: 'tokenUsage', subagent: true, taskRequests: taskUsage.requests, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens, taskTokens: taskUsage.tokens, taskCostUsd: taskUsage.costUsd, cachedTokens: usage.cachedTokens, taskCachedTokens: taskUsage.cachedTokens }); },
            };

            for (let i = 0; shouldRunAgentIteration(i, maxIterations, exploration.verificationPending, verificationGraceIterations, exploration.mutationGracePending, mutationGraceIterations, exploration.lastMutationIteration); i++) {
                if (signal.aborted) { break; }
                if (this._host.evaluationMode && this._host.evaluationTokenBudget > 0 &&
                    this._host.evalPromptTokens + this._host.evalCompletionTokens >= this._host.evaluationTokenBudget) {
                    this._host.evalBudgetExceeded = true;
                    this._host.post({
                        type: 'appendContent',
                        id: msgId,
                        text: `\n\n⚠ Evaluation token budget reached (${this._host.evaluationTokenBudget.toLocaleString()} cumulative tokens).\n`,
                    });
                    break;
                }
                this._host.evalSteps = Math.max(this._host.evalSteps, i + 1);
                exploration.beginIteration();
                this._host.post({ type: 'stepProgress', id: msgId, step: i + 1 });

                let fullContent = '';
                let lastSentPos = 0;    // how far into fullContent we've sent as appendContent
                let dispatchedUpTo = 0; // how far into fullContent we've dispatched tool fences
                const inlineToolResults: string[] = [];
                const fencedToolResults: string[] = [];
                const nativeToolExecutions: NativeToolExecution[] = [];
                let recoverableStreamInterruption: string | null = null;
                let recoverableFinishReason: string | null = null;

                let resumeBuffer = '';
                let iterationReasoning = ''; // the reply's reasoning, when the provider needs it back (DeepSeek)

                // Large write_file/edit_file bodies are hidden until complete; show their
                // progress in the status bar so a long write never looks idle.
                let draftReported = false;
                let draftLines = 0;
                const reportDraftProgress = (fence: string) => {
                    const m = /^```(write_file|edit_file)\r?\nfilepath:\s*(.+)/.exec(fence);
                    if (!m) { return; }
                    const lines = fence.split('\n').length;
                    if (draftReported && lines - draftLines < 10) { return; }
                    draftReported = true;
                    draftLines = lines;
                    const name = path.basename(m[2].trim());
                    const verb = m[1] === 'write_file' ? 'Writing' : 'Editing';
                    this._host.post({ type: 'activity', text: `${verb} ${name}\u2026 ${lines} lines` });
                };

                // Once a loop is detected, the rest of this response is not executed either
                let loopDetected = false;
                let ranTool = false;
                const dispatchToolCall = async (tool: ToolCall): Promise<{ keepGoing: boolean; result: string }> => {
                    if (loopDetected) {
                        const skipped = `[System] Not executed: \`${tool.type}\` came after a repeated tool call in the same response. Change your approach first.`;
                        inlineToolResults.push(skipped);
                        return { keepGoing: false, result: skipped };
                    }
                    const { count: callCount, loop } = loopGuard.check(tool);
                    if (loop) {
                        loopDetected = true;
                        const nudge = `[System] The tool call \`${tool.type}\` with the same arguments has been issued ${callCount} times. You are in a loop. Stop repeating this call. Either the information you need does not exist, or you should try a completely different approach.`;
                        inlineToolResults.push(nudge);
                        this._host.post({ type: 'appendContent', id: msgId, text: `\n⚠️ Loop detected — same tool call issued ${callCount} times. Stopping repetition.\n` });
                        return { keepGoing: false, result: nudge };
                    }

                    const explorationCheck = exploration.before(tool, this._host.readOnly);
                    if (explorationCheck.block) {
                        if (this._host.evaluationMode) {
                            this._host.evalTrace.push({
                                step: this._host.evalSteps,
                                tool: 'exploration_block',
                                target: evaluationToolTarget(tool),
                            });
                        }
                        inlineToolResults.push(explorationCheck.block);
                        return { keepGoing: true, result: explorationCheck.block };
                    }

                    if (explorationCheck.isExploration) {
                        this._host.evalToolCalls++;
                        if (this._host.evaluationMode) {
                            this._host.evalTrace.push({
                                step: this._host.evalSteps,
                                tool: tool.type,
                                target: evaluationToolTarget(tool),
                            });
                        }
                        ranTool = true;
                        await this._host.dispatchTool(tool, msgId, signal);
                        loopGuard.ran(tool);
                        let result = this._host.lastInlineResult ?? `[${tool.type}] completed`;
                        this._host.lastInlineResult = undefined;
                        if (explorationCheck.guidance) { result += `\n\n${reminders.say(explorationCheck.guidance)}`; }
                        inlineToolResults.push(result);
                        return { keepGoing: true, result };
                    }

                    if (exploration.blocksTerminal(tool)) {
                        const result = '[System] Source-inspection terminal commands are disabled in the current focused phase. ' +
                            'Use the edited-file read tool, edit/write tools, or tests/builds/diagnostics for verification.';
                        if (this._host.evaluationMode) {
                            this._host.evalTrace.push({
                                step: this._host.evalSteps,
                                tool: 'exploration_block',
                                target: evaluationToolTarget(tool),
                            });
                        }
                        inlineToolResults.push(result);
                        return { keepGoing: true, result };
                    }

                    this._host.evalToolCalls++;
                    if (this._host.evaluationMode) {
                        this._host.evalTrace.push({
                            step: this._host.evalSteps,
                            tool: tool.type,
                            target: evaluationToolTarget(tool),
                        });
                    }
                    ranTool = true;
                    await this._host.dispatchTool(tool, msgId, signal);
                    loopGuard.ran(tool);
                    let result = this._host.lastInlineResult ?? `[${tool.type}] completed`;
                    this._host.lastInlineResult = undefined;
                    const followThrough = exploration.after(tool, result);
                    if (tool.type === 'write_file' || tool.type === 'edit_file' || !exploration.verificationPending) { verificationNudges = 0; }
                    if (followThrough) { result += `\n\n${reminders.say(followThrough)}`; }
                    inlineToolResults.push(result);
                    return { keepGoing: true, result };
                };

                // Dispatch every newly complete tool fence, sending the text before each first.
                // `final` accepts a closing line that is the last thing in the stream.
                const dispatchFences = async (final: boolean): Promise<void> => {
                    for (const fence of scanToolFences(fullContent, dispatchedUpTo, final).fences) {
                        const fenceStart = fence.start;
                        const fenceEnd = fence.end;

                        // Send text before this fence (strips the fence from display)
                        if (fenceStart > lastSentPos) {
                            this._host.post({ type: 'appendContent', id: msgId, text: fullContent.slice(lastSentPos, fenceStart) });
                        }
                        lastSentPos = fenceEnd;
                        dispatchedUpTo = fenceEnd;

                        // Dispatch tool — toolStart is posted inside _dispatchTool,
                        // which causes the webview to finalize the current text segment
                        // and create a new one after the pill
                        const tools = parseToolBody(fence.type, fence.body);
                        if (tools.length > 0) {
                            const dispatched = await dispatchToolCall(tools[0]);
                            fencedToolResults.push(dispatched.result);
                            if (!dispatched.keepGoing) { return; }
                        }
                    }
                };

                const processContent = async (text: string): Promise<void> => {
                    fullContent += text;

                    // Dispatch any newly complete tool fences, sending pre-fence text first
                    await dispatchFences(false);

                    // Determine safe send boundary: hold back only the last ``` if it could
                    // still become a tool fence (nothing after it, or a tool-name first letter
                    // with no newline yet). Once a newline is received after ```, the name is
                    // confirmed and we know whether it's a tool fence or not — no more holdback.
                    // This avoids freezing content during common language fences like ```bash,
                    // ```rust, ```shell, etc. for the entire duration of the code block.
                    const tail = fullContent.slice(dispatchedUpTo);
                    const lastTripleIdx = tail.lastIndexOf('```');
                    let safeEnd: number;
                    if (lastTripleIdx === -1) {
                        // No ``` at all — hold back 1-2 trailing backticks that could start one
                        const trailingTicks = tail.match(/`+$/)?.[0].length ?? 0;
                        safeEnd = trailingTicks > 0 && trailingTicks < 3
                            ? fullContent.length - trailingTicks
                            : fullContent.length;
                    } else {
                        const afterTriple = tail.slice(lastTripleIdx + 3);
                        // Unresolved if nothing follows, or a tool-name letter without a newline yet
                        const unresolved = afterTriple.length === 0 ||
                            (/^[wrslfesgbmdu]/.test(afterTriple) && !afterTriple.includes('\n'));
                        safeEnd = unresolved ? dispatchedUpTo + lastTripleIdx : fullContent.length;
                    }
                    // Never display the body of a tool fence that is still open: it is either
                    // dispatched once complete or dropped if the stream is cut off.
                    const openFence = scanToolFences(fullContent, dispatchedUpTo, false).unclosedStart;
                    if (openFence !== -1) {
                        safeEnd = Math.min(safeEnd, openFence);
                        reportDraftProgress(fullContent.slice(openFence));
                    } else if (draftReported) {
                        draftReported = false;
                        this._host.post({ type: 'activity', text: null });
                    }
                    if (safeEnd > lastSentPos) {
                        this._host.post({ type: 'appendContent', id: msgId, text: fullContent.slice(lastSentPos, safeEnd) });
                        lastSentPos = safeEnd;
                    }
                };

                // The system prompt and tool list stay the same for the whole task so providers can reuse
                // their prompt cache. A phase change is added to the conversation instead (append-only).
                const { systemPrompt: systemPromptOverride, phaseNote } = splitPhasePrompt(exploration.systemPrompt(this._host.readOnly));
                if (phaseNote !== currentPhaseNote && (phaseNote || currentPhaseNote)) { appendPhaseNote(this._host.history, phaseNote); currentPhaseNote = phaseNote; }
                const projectedHistory = projectHistoryForModel(this._host.history);
                const requestHistory = projectedHistory.history;
                if (this._host.evaluationMode) {
                    this._host.evalProjectedCharsOmitted += projectedHistory.omittedChars;
                }
                for await (const chunk of requestModel(requestHistory, effectivePrefix, systemPromptOverride, nativeTools)) {
                    if (signal.aborted) { break; }
                    if (recoveryStatusShown) {
                        recoveryStatusShown = false;
                        this._host.post({ type: 'activity', text: null });
                    }
                    if (chunk.type === 'thinking') {
                        this._host.post({ type: 'appendThinking', id: msgId, text: chunk.text });
                    } else if (chunk.type === 'content') {
                        let text = chunk.text;
                        if (resumeTail !== null) {
                            // Buffer the start of a resumed response until it can be
                            // compared with the pre-cutoff text, then drop any repetition.
                            resumeBuffer += text;
                            if (resumeBuffer.length < resumeTail.length + 20) { continue; }
                            text = resumeBuffer.slice(repeatedPrefixLength(resumeTail, resumeBuffer));
                            resumeTail = null;
                            resumeBuffer = '';
                        }
                        if (text) { await processContent(text); }
                    } else if (chunk.type === 'native_tool') {
                        const call: NativeToolCall & { id: string } = {
                            ...chunk.call,
                            id: chunk.call.id ?? `codico_${nodeCrypto.randomBytes(8).toString('hex')}`,
                        };
                        // A native `clarify` call becomes the <clarify> block the panel renders.
                        // It is not recorded as a tool call: the turn ends waiting for the user.
                        const clarifyBlock = nativeClarifyBlock(call);
                        if (clarifyBlock) {
                            await processContent(`${fullContent.trim() ? '\n\n' : ''}${clarifyBlock}\n`);
                            continue;
                        }
                        const tool = nativeToolCallToToolCall(call);
                        if (!tool) {
                            // Unknown tool or unusable arguments: return the error as the tool
                            // result so the model can correct the call and the turn continues.
                            const result = invalidNativeCallResult(call);
                            nativeToolExecutions.push({ call, result });
                            inlineToolResults.push(result);
                            continue;
                        }
                        const dispatched = await dispatchToolCall(tool);
                        nativeToolExecutions.push({ call, result: dispatched.result });
                    } else if (chunk.type === 'reasoning') {
                        iterationReasoning = chunk.text;
                    } else if (chunk.type === 'usage') {
                        this._host.lastPromptTokens = chunk.promptTokens;
                        this._host.evalPromptTokens += chunk.promptTokens;
                        this._host.evalCompletionTokens += chunk.completionTokens;
                        if (this._host.evaluationMode && this._host.evaluationTokenBudget > 0 && this._host.evalPromptTokens + this._host.evalCompletionTokens >= this._host.evaluationTokenBudget) { this._host.evalBudgetExceeded = true; }
                        taskUsage.add(chunk.totalTokens, chunk.costUsd, chunk.cachedTokens, chunk.promptTokens, chunk.completionTokens);
                        this._host.post({ type: 'tokenUsage', taskRequests: taskUsage.requests, promptTokens: chunk.promptTokens, completionTokens: chunk.completionTokens, totalTokens: chunk.totalTokens, taskTokens: taskUsage.tokens, taskCostUsd: taskUsage.costUsd, cachedTokens: chunk.cachedTokens, taskCachedTokens: taskUsage.cachedTokens });
                    } else if (chunk.type === 'finish') {
                        const reason = normalizeFinishReason(chunk.reason);
                        if (reason === 'length') {
                            recoverableFinishReason = reason;
                        } else {
                            this._host.post({ type: 'streamFinishReason', id: msgId, reason });
                        }
                    } else if (chunk.type === 'stream_error') {
                        if (isRecoverableStreamInterruption(chunk.message)) {
                            recoverableStreamInterruption = chunk.message;
                        } else {
                            this._host.post({ type: 'streamError', id: msgId, message: chunk.message });
                        }
                    }
                }

                if (draftReported) { this._host.post({ type: 'activity', text: null }); }

                // Stream ended while the start of a resumed response was still buffered
                if (resumeTail !== null && resumeBuffer) {
                    const text = resumeBuffer.slice(repeatedPrefixLength(resumeTail, resumeBuffer));
                    resumeTail = null;
                    resumeBuffer = '';
                    if (text && !signal.aborted) { await processContent(text); }
                }

                // On a cutoff, drop an incomplete trailing tool fence: it was never shown or
                // executed, and the model re-issues it in full when it resumes.
                const isCutoff = !signal.aborted && (recoverableStreamInterruption !== null || recoverableFinishReason === 'length');
                let droppedToolCall = false;
                if (isCutoff) {
                    const openFence = scanToolFences(fullContent, dispatchedUpTo, false).unclosedStart;
                    if (openFence !== -1) {
                        fullContent = fullContent.slice(0, Math.max(openFence, lastSentPos));
                        droppedToolCall = true;
                    }
                }

                // A model can end its response cleanly without writing the closing ``` of
                // its last tool fence. Close it and dispatch the call instead of silently
                // treating the turn as finished. Cut-off streams are left to recovery.
                const cleanEnd = !signal.aborted && !recoverableStreamInterruption && recoverableFinishReason !== 'length';
                // A closing fence line that is the very last thing in the stream
                if (cleanEnd) { await dispatchFences(true); }
                const unclosed = cleanEnd ? scanToolFences(fullContent, dispatchedUpTo, true) : null;
                const unclosedFenceStart = unclosed ? unclosed.unclosedStart : -1;
                if (unclosed && unclosedFenceStart !== -1) {
                    const ticks = /^`+/.exec(fullContent.slice(unclosedFenceStart))?.[0] ?? '```';
                    const tools = parseToolBody(unclosed.unclosedType ?? '', (unclosed.unclosedBody ?? '').replace(/\r?\n$/, ''));
                    if (!fullContent.endsWith('\n')) { fullContent += '\n'; }
                    fullContent += ticks;
                    if (tools.length > 0) {
                        if (unclosedFenceStart > lastSentPos) {
                            this._host.post({ type: 'appendContent', id: msgId, text: fullContent.slice(lastSentPos, unclosedFenceStart) });
                        }
                        lastSentPos = fullContent.length;
                        dispatchedUpTo = fullContent.length;
                        const dispatched = await dispatchToolCall(tools[0]);
                        fencedToolResults.push(dispatched.result);
                    }
                }

                // Flush any remaining content after stream ends
                if (lastSentPos < fullContent.length) {
                    this._host.post({ type: 'appendContent', id: msgId, text: fullContent.slice(lastSentPos) });
                }

                if (signal.aborted) {
                    // Preserve completed native tool calls/results even when the user stops
                    // the turn after a tool has already finished.
                    if (fullContent.trim() || inlineToolResults.length > 0) {
                        appendAssistantIteration(this._host.history, fullContent, nativeToolExecutions, '(interrupted)', iterationReasoning);
                        // Text-format tools: what the finished calls returned is kept too (an applied edit, a command's output)
                        if (fencedToolResults.length > 0) { this._host.history.push({ role: 'user', content: `[Tool Results]\n\n${fencedToolResults.join('\n\n---\n\n')}` }, { role: 'assistant', content: STOPPED_NOTE }); }
                    }
                    break;
                }

                appendAssistantIteration(
                    this._host.history,
                    fullContent,
                    nativeToolExecutions,
                    recoverableStreamInterruption
                        ? '[Stream interrupted before content]'
                        : '[Assistant turn completed without text]',
                    iterationReasoning
                );

                // Unexpected transport EOFs are recoverable: preserve the partial
                // assistant response and any tool results, then ask the model to
                // continue from the exact cutoff point. This avoids replaying tools or
                // discarding useful partial output. Recovery is deliberately bounded.
                if (recoverableStreamInterruption || recoverableFinishReason === 'length') {
                    if (streamRecoveryAttempts < MAX_STREAM_RECOVERY_ATTEMPTS) {
                        streamRecoveryAttempts++;

                        const recoveryParts: string[] = [];
                        if (fencedToolResults.length > 0) {
                            recoveryParts.push(`[Tool Results]\n\n${fencedToolResults.join('\n\n---\n\n')}`);
                        }

                        const cause = recoverableStreamInterruption
                            ? 'The previous assistant response was interrupted by the network/stream transport.'
                            : 'The previous assistant response reached the provider output-token limit.';

                        recoveryParts.push(
                            '[System Recovery]\n' +
                            cause + ' ' +
                            'Your output is appended directly after what was already shown to the user, so continue exactly ' +
                            'from where it stopped, even mid-sentence. Do not repeat text that was already produced, do not ' +
                            'mention the interruption, and do not repeat tool calls that already completed.' +
                            (droppedToolCall
                                ? ' Your last tool call was cut off before it was complete and was NOT executed: issue it again in full as one complete valid fence.'
                                : '')
                        );
                        this._host.history.push({ role: 'user', content: recoveryParts.join('\n\n') });

                        // Compare the resumed response against the text shown just before the cutoff
                        const visibleTail = fullContent.slice(dispatchedUpTo).slice(-RESUME_OVERLAP_WINDOW);
                        resumeTail = visibleTail.trim() ? visibleTail : null;

                        this._host.post({ type: 'activity', text: recoverableStreamInterruption ? 'Reconnecting\u2026' : 'Continuing\u2026' });
                        recoveryStatusShown = true;

                        // Give a dropped connection a moment before reconnecting
                        if (recoverableStreamInterruption) {
                            await new Promise(resolve => setTimeout(resolve, 1000 * streamRecoveryAttempts));
                        }

                        // Recovery should not consume an agentic tool iteration.
                        i--;
                        continue;
                    }

                    if (recoverableFinishReason === 'length') {
                        this._host.post({ type: 'streamFinishReason', id: msgId, reason: 'length' });
                    } else {
                        this._host.post({
                            type: 'streamError',
                            id: msgId,
                            message: `${recoverableStreamInterruption} Automatic recovery failed after ${MAX_STREAM_RECOVERY_ATTEMPTS} attempts.`,
                        });
                    }
                    break;
                }

                streamRecoveryAttempts = 0;
                if (inlineToolResults.length === 0) {
                    // A clarifying question ends the turn: wait for the user's answer
                    if (/<clarify>[\s\S]*?<\/clarify>/.test(fullContent)) { break; }
                    const verificationGuidance = exploration.completionGuidance();
                    if (verificationGuidance) {
                        if (verificationNudges >= MAX_STALLED_VERIFICATION_NUDGES) {
                            const pendingWork = verificationGuidance.startsWith('[System Action]')
                                ? 'make the code change this task requires'
                                : 'verify its change';
                            this._host.post({
                                type: 'appendContent',
                                id: msgId,
                                text: `\n\n> ⚠️ Stopped after ${verificationNudges} reminders: the model kept ending its turn without trying to ${pendingWork}, so this task is not verified as complete.`,
                            });
                            break;
                        }
                        verificationNudges++;
                        this._host.history.push({ role: 'user', content: verificationGuidance });
                        this._host.post({ type: 'appendContent', id: msgId, text: '\n\n' }); continue;
                    }
                    // Some models announce an action ("I'll locate the file.") and end the
                    // turn without emitting the tool fence. Ask them to issue it rather than
                    // treating the announcement as the final answer. Bounded per request.
                    if (isUnfulfilledActionAnnouncement(fullContent) && actionNudges < MAX_ACTION_NUDGES) {
                        actionNudges++;
                        this._host.history.push({
                            role: 'user',
                            content: '[System] Your previous response announced an action but contained no tool call, so nothing was executed. ' +
                                'Issue that tool call now as one complete tool fence. If no action is needed, give your final answer instead.',
                        });
                        this._host.post({ type: 'appendContent', id: msgId, text: '\n\n' });
                        continue;
                    }
                    break;
                }

                actionNudges = 0;
                // The model is calling tools again, so reminders are no longer "stalled"
                verificationNudges = 0;
                blockedOnlyIterations = ranTool ? 0 : blockedOnlyIterations + 1;
                if (blockedOnlyIterations >= MAX_BLOCKED_ONLY_ITERATIONS) {
                    this._host.post({ type: 'appendContent', id: msgId, text: '\n\n> ⚠️ Stopped: none of the model\'s tool calls could run (repeated or blocked) in several attempts in a row.' }); break;
                }

                // ── Mid-stream auto-compact ────────────────────────────────────────
                // Compact between iterations while the agent loop is still running so
                // the stream never terminates due to context overflow. The compact runs
                // silently between the current and next iteration; the UI stays in the
                // streaming state and continues as soon as compaction finishes.
                const autoCompactThresholdMid = config.get<number>('autoCompactThreshold', 60_000);
                if (this._host.autoCompact && this._host.lastPromptTokens > autoCompactThresholdMid && this._host.history.length >= this._host.compactRetryAt) {
                    const sizeBefore = this._host.history.length;
                    await this._host.compaction.run(apiKey, model, isOllama, ollamaBaseUrl, ollamaModel, isDirect, directApiKey, directParsed?.providerId ?? '', directParsed?.modelId ?? '', signal);
                    if (this._host.history.length < sizeBefore) { taskUsage.markCompaction(); }
                    currentPhaseNote = undefined; // a phase note may be in the summarised part: re-add it
                }

                // Fenced compatibility tools return results as a normal user message.
                // Native calls already have provider-native tool result turns above.
                if (fencedToolResults.length > 0) {
                    const resultText = `[Tool Results]\n\n${fencedToolResults.join('\n\n---\n\n')}`;
                    this._host.history.push({ role: 'user', content: resultText });
                }

                // Token budget: pause each time the task crosses another budget's worth
                if (taskUsage.budgetExceeded) {
                    if (!await this._host.approvals.askCheckpoint(msgId, i + 1, signal, taskUsage.budgetPrompt())) { break; }
                    taskUsage.extendBudget();
                }
                // The agent goes on to another request: a message queued meanwhile goes with it
                if (this._host.steer) { addSteer(this._host.history, this._host.steer); this._host.post({ type: 'appendContent', id: msgId, text: steerNote(this._host.steer) }); this._host.post({ type: 'queuedDelivered' }); this._host.steer = ''; }

            }
        } catch (err: unknown) {
            // Only roll back if no tool calls have completed yet.  If the history already
            // contains assistant replies (length > rollback+1), those iterations wrote files
            // that are now on disk — wiping them from history would make chat state diverge
            // from the file system.  Keep completed history; only trim an orphaned user message.
            // Only ever shorten: if mid-turn compaction already replaced the history it can be
            // shorter than historyRollbackLen, and assigning length would pad it with holes.
            if (this._host.history.length > historyRollbackLen && this._host.history.length <= historyRollbackLen + 1) {
                this._host.history.length = historyRollbackLen;
            }
            if (this._host.displayMessages.length > displayRollbackLen) {
                this._host.displayMessages.length = displayRollbackLen;
            }
            if (!signal.aborted) {
                const message = err instanceof Error ? err.message : String(err);
                this._host.post({ type: 'error', message });
            }
        }
    }
}
