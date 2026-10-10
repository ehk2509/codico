/**
 * The MCP catalog: a short list of known servers that can be added in one step. This module
 * is the data shapes and the edits to configuration; the prompts and file access are in
 * mcpCatalogCommands.
 */

export interface McpCatalogEntry {
    /** The name the server is configured under. */
    id: string;
    name: string;
    publisher: string;
    description: string;
    command: string;
    args: string[];
    /** What must be installed for the command to work, in words. */
    requires: string;
    /** How many tools the server offered when it was checked; each is described to the model on every request. */
    tools: number;
    homepage: string;
}

export interface McpCatalogRow extends McpCatalogEntry {
    /** The exact command line that would run. */
    commandLine: string;
    /** Where a server of this name is configured already, if anywhere. */
    added: 'project' | 'user' | null;
}

/** A command line as text, with arguments that contain spaces quoted. Display only: it is never run through a shell. */
export function commandLine(command: string, args: string[] = []): string {
    return [command, ...args].map(part => /^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`).join(' ');
}

/** The entries of the bundled catalog that are well formed. Anything else is dropped. */
export function parseCatalog(text: string): McpCatalogEntry[] {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return []; }
    if (!Array.isArray(raw)) { return []; }
    const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
    return raw.filter((entry): entry is McpCatalogEntry => !!entry && typeof entry === 'object' &&
        isText(entry.id) && /^[a-z0-9][a-z0-9-]*$/.test(entry.id) && isText(entry.name) && isText(entry.publisher) && isText(entry.description) &&
        isText(entry.command) && Array.isArray(entry.args) && entry.args.every((arg: unknown) => typeof arg === 'string') &&
        isText(entry.requires) && Number.isInteger(entry.tools) && isText(entry.homepage));
}

/** The catalog as the panel shows it. */
export function catalogRows(entries: McpCatalogEntry[], configured: Array<{ name: string; source?: 'settings' | 'workspace' }>): McpCatalogRow[] {
    return entries.map(entry => {
        const existing = configured.find(config => config.name === entry.id);
        return { ...entry, commandLine: commandLine(entry.command, entry.args), added: !existing ? null : existing.source === 'workspace' ? 'project' : 'user' };
    });
}

type McpJson = { mcpServers?: Record<string, unknown> } & Record<string, unknown>;

function parseMcpJson(text: string | undefined): McpJson {
    if (text === undefined || !text.trim()) { return {}; }
    const json = JSON.parse(text) as unknown;
    if (!json || typeof json !== 'object' || Array.isArray(json)) { throw new Error('it is not a JSON object'); }
    const servers = (json as McpJson).mcpServers;
    if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) { throw new Error('"mcpServers" is not an object'); }
    return json as McpJson;
}

/**
 * The text of a `.mcp.json` with one server added, everything else in the file kept.
 * @throws when the existing file cannot be understood: it is never overwritten
 */
export function addToMcpJson(text: string | undefined, entry: Pick<McpCatalogEntry, 'id' | 'command' | 'args'>): string {
    const json = parseMcpJson(text);
    json.mcpServers = { ...json.mcpServers, [entry.id]: { command: entry.command, args: entry.args } };
    return JSON.stringify(json, null, 2) + '\n';
}

/** The text of a `.mcp.json` with one server removed; unchanged text when it was not there. */
export function removeFromMcpJson(text: string, name: string): string {
    const json = parseMcpJson(text);
    if (!json.mcpServers || !(name in json.mcpServers)) { return text; }
    const servers = { ...json.mcpServers };
    delete servers[name];
    json.mcpServers = servers;
    return JSON.stringify(json, null, 2) + '\n';
}
