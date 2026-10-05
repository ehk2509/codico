import type { ChatMessage, MessageContentPart } from './openRouterClient';
import type { NativeToolCall } from './nativeTools';

export type PlainChatMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string | MessageContentPart[];
};

function textContent(content: string | MessageContentPart[]): string {
    if (typeof content === 'string') { return content; }
    return content
        .map(part => part.type === 'text' ? part.text : '[image]')
        .join('\n')
        .trim();
}

type AssistantChatMessage = {
    role: 'assistant';
    content: string | MessageContentPart[];
    nativeToolCalls?: NativeToolCall[];
};

function compatibilityAssistantText(message: AssistantChatMessage): string | MessageContentPart[] {
    if (!message.nativeToolCalls?.length) { return message.content; }
    const marker = `[Native tool calls executed: ${message.nativeToolCalls.map(call => call.name).join(', ')}]`;
    if (typeof message.content === 'string') {
        return message.content.trim() ? `${message.content}\n\n${marker}` : marker;
    }
    return [...message.content, { type: 'text', text: marker }];
}

/**
 * Removes provider-native metadata for compatibility-only transports such as
 * Ollama or an OpenRouter model that rejected the tools field.
 */
export function flattenChatHistory(history: ChatMessage[]): PlainChatMessage[] {
    return history.map(message => {
        if (message.role === 'tool') {
            return {
                role: 'user',
                content: `[Tool Result: ${message.toolName}]\n${message.content}`,
            };
        }
        if (message.role === 'assistant') {
            return {
                role: 'assistant',
                content: compatibilityAssistantText(message),
            };
        }
        return { role: message.role, content: message.content };
    });
}

export function toOpenAIMessages(history: ChatMessage[], useNativeTools: boolean): unknown[] {
    if (!useNativeTools) { return flattenChatHistory(history); }

    return history.map(message => {
        if (message.role === 'tool') {
            return {
                role: 'tool',
                tool_call_id: message.toolCallId,
                content: message.content,
            };
        }

        if (message.role === 'assistant' && message.nativeToolCalls?.length) {
            const content = typeof message.content === 'string' && !message.content
                ? null
                : message.content;
            return {
                role: 'assistant',
                content,
                tool_calls: message.nativeToolCalls.map(call => ({
                    id: call.id,
                    type: 'function',
                    function: {
                        name: call.name,
                        arguments: JSON.stringify(call.arguments),
                    },
                })),
            };
        }

        return { role: message.role, content: message.content };
    });
}

type AnthropicBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string };

function anthropicContentBlocks(content: string | MessageContentPart[]): AnthropicBlock[] {
    if (typeof content === 'string') {
        return content ? [{ type: 'text', text: content }] : [];
    }

    const blocks: AnthropicBlock[] = [];
    for (const part of content) {
        if (part.type === 'text') {
            if (part.text) { blocks.push({ type: 'text', text: part.text }); }
        } else if (part.type === 'image_url') {
            const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
                blocks.push({
                    type: 'image',
                    source: { type: 'base64', media_type: match[1], data: match[2] },
                });
            }
        }
    }
    return blocks;
}

export function toAnthropicMessages(history: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> {
    const messages: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = [];

    const append = (role: 'user' | 'assistant', content: AnthropicBlock[]): void => {
        if (content.length === 0) { return; }
        const previous = messages[messages.length - 1];
        if (previous?.role === role) {
            previous.content.push(...content);
        } else {
            messages.push({ role, content: [...content] });
        }
    };

    for (const message of history) {
        if (message.role === 'system') { continue; }

        if (message.role === 'tool') {
            append('user', [{
                type: 'tool_result',
                tool_use_id: message.toolCallId,
                content: message.content,
            }]);
            continue;
        }

        const blocks = anthropicContentBlocks(message.content);
        if (message.role === 'assistant' && message.nativeToolCalls?.length) {
            for (const call of message.nativeToolCalls) {
                blocks.push({
                    type: 'tool_use',
                    id: call.id ?? `codico_${call.name}`,
                    name: call.name,
                    input: call.arguments,
                });
            }
        }
        append(message.role, blocks);
    }

    return messages;
}

type GeminiPart =
    | { text: string }
    | { inlineData: { mimeType: string; data: string } }
    | { functionCall: { name: string; args: Record<string, unknown> } }
    | { functionResponse: { name: string; response: Record<string, unknown> } };

function geminiContentParts(content: string | MessageContentPart[]): GeminiPart[] {
    if (typeof content === 'string') {
        return content ? [{ text: content }] : [];
    }

    const parts: GeminiPart[] = [];
    for (const part of content) {
        if (part.type === 'text') {
            if (part.text) { parts.push({ text: part.text }); }
        } else if (part.type === 'image_url') {
            const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
                parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
            }
        }
    }
    return parts;
}

export function toGeminiMessages(history: ChatMessage[]): Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> {
    const messages: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> = [];

    const append = (role: 'user' | 'model', parts: GeminiPart[]): void => {
        if (parts.length === 0) { return; }
        const previous = messages[messages.length - 1];
        if (previous?.role === role) {
            previous.parts.push(...parts);
        } else {
            messages.push({ role, parts: [...parts] });
        }
    };

    for (const message of history) {
        if (message.role === 'system') { continue; }

        if (message.role === 'tool') {
            append('user', [{
                functionResponse: {
                    name: message.toolName,
                    response: { result: message.content },
                },
            }]);
            continue;
        }

        const parts = geminiContentParts(message.content);
        if (message.role === 'assistant' && message.nativeToolCalls?.length) {
            for (const call of message.nativeToolCalls) {
                parts.push({
                    functionCall: {
                        name: call.name,
                        args: call.arguments,
                    },
                });
            }
        }
        append(message.role === 'assistant' ? 'model' : 'user', parts);
    }

    return messages;
}

export function chatMessageText(message: ChatMessage): string {
    if (message.role === 'tool') { return message.content; }
    return textContent(message.content);
}
