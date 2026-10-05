export interface EvaluationToolTraceEvent {
    step: number;
    tool: string;
    target: string;
}

export interface EvaluationRunMetrics {
    durationMs: number;
    steps: number;
    toolCalls: number;
    filesWritten: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    historyMessages: number;
    budgetExceeded: boolean;
    projectedCharsOmitted: number;
    trace: EvaluationToolTraceEvent[];
}

export interface EvaluationSnapshotInput {
    startedAt: number;
    steps: number;
    toolCalls: number;
    filesWritten: number;
    promptTokens: number;
    completionTokens: number;
    historyMessages: number;
    budgetExceeded: boolean;
    projectedCharsOmitted: number;
    trace: EvaluationToolTraceEvent[];
}

export function buildEvaluationRunMetrics(
    input: EvaluationSnapshotInput,
    now = Date.now(),
): EvaluationRunMetrics {
    return {
        durationMs: input.startedAt > 0 ? Math.max(0, now - input.startedAt) : 0,
        steps: input.steps,
        toolCalls: input.toolCalls,
        filesWritten: input.filesWritten,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        totalTokens: input.promptTokens + input.completionTokens,
        historyMessages: input.historyMessages,
        budgetExceeded: input.budgetExceeded,
        projectedCharsOmitted: input.projectedCharsOmitted,
        trace: [...input.trace],
    };
}
