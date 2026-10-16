import { getAccoProviderTelemetry, AccoProviderTelemetry } from './accoProviderOptimizer';
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
    acco: AccoProviderTelemetry;
    trace: EvaluationToolTraceEvent[];
    /** The cost the provider reported for the task (cache discounts and every model included), when it reports one. */
    costUsd?: number;
    /** Prompt tokens served from the provider's cache. */
    cachedTokens: number;
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
    costUsd?: number;
    cachedTokens?: number;
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
        acco: getAccoProviderTelemetry(),
        trace: [...input.trace],
        ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
        cachedTokens: input.cachedTokens ?? 0,
    };
}
