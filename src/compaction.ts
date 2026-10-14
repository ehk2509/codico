import * as vscode from 'vscode';
import * as path from 'path';
import * as https from 'https';
import { ChatMessage } from './openRouterClient';
import { ollamaChatCompletion } from './ollamaClient';
import { directSingleCompletion } from './directProviderClient';
import { ExtensionMessage } from './chatProtocol';
import { planCompaction, summarizerPrompt, summaryProblem, buildCompactedHistory } from './historyCompaction';
import { cliModelCompletion, isCliModel } from './cliProviders';

/** What compaction needs from the conversation. */
export interface CompactionHost {
    history: ChatMessage[];
    /** Do not try again before the conversation has this many messages (a failed attempt waits for more). */
    compactRetryAt: number;
    /** Prompt size of the last request: what decides that the conversation is too long. */
    lastPromptTokens: number;
    post(message: ExtensionMessage): void;
    /** Saves the conversation of the open thread. */
    save(history: ChatMessage[]): PromiseLike<void>;
    sessionSignal(): AbortSignal;
}

/**
 * Compaction: the earlier part of a long conversation is replaced by a summary written by the
 * model, keeping the user's requests and the newest messages as they are.
 */
export class Compaction {
    constructor(private readonly _host: CompactionHost) {}

    async run(apiKey: string, model: string, isOllama: boolean, ollamaBaseUrl: string, ollamaModel: string, isDirect = false, directKey = '', directProviderId = '', directModelId = '', signal: AbortSignal = this._host.sessionSignal()): Promise<void> {
        if (signal.aborted) { this._host.post({ type: 'compactCancelled' }); return; }
        const plan = planCompaction(this._host.history);
        if (!plan) {
            this._host.post({ type: 'compactDone', messageCount: 0 });
            return;
        }

        this._host.post({ type: 'compactStart' });
        const prompt = summarizerPrompt(plan);
        // Room for the summary even when a reasoning model spends part of the budget thinking
        const SUMMARY_MAX_TOKENS = 4000;

        const ask = async (): Promise<string> => {
            if (isCliModel(model)) {
                return cliModelCompletion(model, prompt, signal);
            } else if (isOllama) {
                return ollamaChatCompletion(ollamaBaseUrl, [{ role: 'user', content: prompt }], ollamaModel, SUMMARY_MAX_TOKENS, signal);
            } else if (isDirect) {
                return directSingleCompletion(directKey, directProviderId, directModelId, prompt, SUMMARY_MAX_TOKENS, signal);
            } else {
                const body = JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: SUMMARY_MAX_TOKENS,
                    temperature: 0.1,
                    reasoning: { effort: 'low' },
                });
                return new Promise<string>((resolve) => {
                    const req = https.request(
                        {
                            hostname: 'openrouter.ai',
                            path: '/api/v1/chat/completions',
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${apiKey}`,
                                'Content-Type': 'application/json',
                                'HTTP-Referer': 'vscode-codico',
                                'X-Title': 'Codico',
                                'Content-Length': Buffer.byteLength(body),
                            },
                        },
                        (res) => {
                            let data = '';
                            let totalBytes = 0;
                            res.setEncoding('utf8'); // keeps characters split across chunks intact
                            res.on('data', (c: string) => {
                                totalBytes += c.length;
                                if (totalBytes > 256 * 1024) { res.destroy(); resolve(''); return; }
                                data += c.toString();
                            });
                            res.on('end', () => {
                                try { resolve(JSON.parse(data)?.choices?.[0]?.message?.content ?? ''); }
                                catch { resolve(''); }
                            });
                            res.on('error', () => resolve(''));
                        }
                    );
                    req.setTimeout(30_000, () => { req.destroy(); resolve(''); });
                    req.on('error', () => resolve(''));
                    signal.addEventListener('abort', () => { req.destroy(); resolve(''); }, { once: true });
                    req.write(body);
                    req.end();
                });
            }
        };

        // A bad summary would replace the history and the agent would forget its work: check it,
        // retry once, and otherwise keep the history as it is
        let summary = '';
        let problem: string | null = null;
        try {
            for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
                summary = await ask();
                problem = summaryProblem(summary, plan);
                if (!problem) { break; }
            }
        } catch (err: unknown) {
            if (signal.aborted) { this._host.post({ type: 'compactCancelled' }); return; }
            problem = err instanceof Error ? err.message : String(err);
        }

        // Stopped while summarising: keep the history as it was, and don't bill another step
        if (signal.aborted) {
            this._host.post({ type: 'compactCancelled' });
            return;
        }

        if (problem) {
            // Not retried on every step: wait until the history has grown
            this._host.compactRetryAt = this._host.history.length + 10;
            this._host.post({ type: 'compactError', message: `History kept as it is: ${problem}.` });
            return;
        }
        this._host.compactRetryAt = 0;

        // The current request stays verbatim; the kept tail starts at a complete exchange
        this._host.history = buildCompactedHistory(summary, plan);
        this._host.lastPromptTokens = 0;

        await this._host.save(this._host.history);
        this._host.post({ type: 'compactDone', messageCount: this._host.history.length - 1 });
    }
}
