import * as https from 'https';
import { ChatMessage } from './openRouterClient';
import { ollamaChatCompletion } from './ollamaClient';
import { directSingleCompletion } from './directProviderClient';

export interface FollowUpProvider {
    apiKey: string;
    model: string;
    isOllama: boolean;
    ollamaBaseUrl: string;
    ollamaModel: string;
    isDirect: boolean;
    directKey: string;
    directProviderId: string;
    directModelId: string;
}

/** Parses the model's reply into at most 3 suggestions; anything unparseable yields none. */
export function parseFollowUps(raw: string): string[] {
    const cleaned = raw.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim();
    try {
        const arr = JSON.parse(cleaned);
        if (Array.isArray(arr)) { return (arr as unknown[]).slice(0, 3).map(String); }
    } catch { /* not JSON */ }
    return [];
}

/** Asks the configured model for 3 short follow-up suggestions. Best effort: failures yield []. */
export async function generateFollowUps(history: ChatMessage[], provider: FollowUpProvider, signal: AbortSignal): Promise<string[]> {
    const { apiKey, model, isOllama, ollamaBaseUrl, ollamaModel, isDirect, directKey, directProviderId, directModelId } = provider;
    try {
        // Take last 6 turns, filtering out injected tool-result messages so the model
        // sees the actual conversation, not raw terminal/file output.
        const recent = history.slice(-8).filter(m => {
            if (m.role === 'tool') { return false; }
            if (typeof m.content !== 'string') { return true; }
            return !m.content.startsWith('[Tool Results]');
        }).slice(-6);
        if (recent.length === 0) { return []; }

        const contextStr = recent.map(m => {
            const text = typeof m.content === 'string'
                ? m.content.slice(0, 500)
                : (m.content as { type: string; text?: string }[])
                    .filter(p => p.type === 'text').map(p => p.text ?? '').join('').slice(0, 500);
            return `${m.role}: ${text}`;
        }).join('\n');

        const prompt = `Given this conversation, suggest exactly 3 short, distinct follow-up questions or requests the user might make next. Output ONLY a JSON array of 3 strings. No explanation, no markdown fences.\n\nConversation:\n${contextStr}`;

        let raw = '';
        if (isOllama) {
            raw = await ollamaChatCompletion(
                ollamaBaseUrl,
                [{ role: 'user', content: prompt }],
                ollamaModel,
                300,
                signal
            );
        } else if (isDirect) {
            raw = await directSingleCompletion(directKey, directProviderId, directModelId, prompt, 300, signal);
        } else {
            const body = JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 300,
                temperature: 0.3,
            });

            raw = await new Promise<string>((resolve) => {
                if (signal.aborted) { resolve(''); return; }
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
                            if (totalBytes > 64 * 1024) { res.destroy(); resolve(''); return; }
                            data += c.toString();
                        });
                        res.on('end', () => {
                            try {
                                resolve(JSON.parse(data)?.choices?.[0]?.message?.content ?? '');
                            } catch { resolve(''); }
                        });
                        res.on('error', () => resolve(''));
                    }
                );
                req.setTimeout(15_000, () => { req.destroy(); resolve(''); });
                signal.addEventListener('abort', () => { req.destroy(); resolve(''); }, { once: true });
                req.on('error', () => resolve(''));
                req.write(body);
                req.end();
            });
        }

        return parseFollowUps(raw);
    } catch {
        return [];
    }
}
