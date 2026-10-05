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
