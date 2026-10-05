export interface EvaluationRunMetrics {
    durationMs: number;
    steps: number;
    toolCalls: number;
    filesWritten: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    historyMessages: number;
}
