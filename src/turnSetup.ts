import * as vscode from 'vscode';
import { directSecretKey, getDirectProvider, parseDirectModelId } from './directProviderClient';
import { isCliModel } from './cliProviders';
import { usableModel } from './modelFallback';

/** The model of a turn and what reaching it takes. */
export interface ModelAccess {
    model: string;
    isOllama: boolean;
    /** Through a command the user is signed in to (claude, codex): no key. */
    isCli: boolean;
    isDirect: boolean;
    ollamaModel: string;
    ollamaBaseUrl: string;
    directParsed: ReturnType<typeof parseDirectModelId>;
    /** OpenRouter's key, when the model goes through OpenRouter. */
    apiKey: string;
    /** The provider's own key, for a direct model. */
    directApiKey: string;
}

/** The model the settings name, with its key; or what is missing, said for the user. */
export async function resolveModelAccess(context: vscode.ExtensionContext, config: vscode.WorkspaceConfiguration): Promise<ModelAccess | { error: string }> {
    // Without an OpenRouter key but with a direct provider key, that provider's model is used
    const model = await usableModel(context, config.get<string>('model', 'deepseek/deepseek-v4-flash'));
    const isOllama = model.startsWith('ollama/');
    const isCli = isCliModel(model);
    const isDirect = model.startsWith('direct:');
    const access: ModelAccess = {
        model, isOllama, isCli, isDirect, ollamaModel: model.slice('ollama/'.length), ollamaBaseUrl: config.get<string>('ollamaBaseUrl', 'http://localhost:11434'),
        directParsed: isDirect ? parseDirectModelId(model) : null, apiKey: '', directApiKey: '',
    };
    if (isOllama || isCli) { return access; }
    if (isDirect) {
        if (!access.directParsed) { return { error: `Invalid direct model ID: "${model}"` }; }
        access.directApiKey = await context.secrets.get(directSecretKey(access.directParsed.providerId)) ?? '';
        if (!access.directApiKey) {
            const provider = getDirectProvider(access.directParsed.providerId);
            return { error: `No API key for ${provider?.name ?? access.directParsed.providerId}. Run "Codico: Set Direct Provider API Key" from the command palette.` };
        }
        return access;
    }
    access.apiKey = await context.secrets.get('openRouterApiKey') ?? '';
    if (!access.apiKey) { return { error: 'No API key set. Click the ⚙ icon to add an OpenRouter key or a direct provider key (Anthropic, OpenAI, DeepSeek…).' }; }
    return access;
}

export const EDITS_MODE_NOTE = '[EDITS MODE] You are in multi-file edits mode. Use write_file and edit_file tools to propose changes across as many files as needed. All changes will be shown as diffs for user review before being applied. Emit every required file change in this single response — do not wait for confirmation between files.';
export const SUMMARY_NOTE = 'Only at the very end of the entire task — in your final reply when you have no more tool calls to make and the work is fully complete — add a single `---` horizontal rule followed by a **Summary** section (2–4 concise bullet points) and a one-sentence **Conclusion**. Never add this block mid-task, after individual tool calls, or in intermediate responses. Do NOT add it for single-sentence answers, tool-only responses, or clarifying questions.';

/**
 * What goes in front of Codico's own system prompt for a turn, in this order: the repository's
 * instructions, the user's own prompt, the MCP tools, the project's skills, the project memory,
 * and the notes for Edits Mode and for the closing summary. Undefined when there is none.
 */
export function systemPrefix(parts: { repoInstructions?: string | null; customPrefix?: string; mcpSection?: string; skillsSection?: string; memorySection?: string; editsMode?: boolean; summary?: boolean }): string | undefined {
    const sections = [
        parts.repoInstructions ? `[Repository Instructions]\n${parts.repoInstructions}` : '',
        parts.customPrefix ?? '', parts.mcpSection ?? '', parts.skillsSection ?? '', parts.memorySection ?? '',
        parts.editsMode ? EDITS_MODE_NOTE : '', parts.summary ? SUMMARY_NOTE : '',
    ].filter(Boolean);
    return sections.length > 0 ? sections.join('\n\n') : undefined;
}
