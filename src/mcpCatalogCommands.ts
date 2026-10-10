import * as vscode from 'vscode';
import { addToMcpJson, catalogRows, McpCatalogEntry, McpCatalogRow, parseCatalog, removeFromMcpJson } from './mcpCatalog';
import { APPROVED_WORKSPACE_MCP_KEY, loadMcpConfigs, mcpFingerprint, McpServerConfig } from './mcpManager';

const decoder = new TextDecoder();

async function loadCatalog(extensionUri: vscode.Uri): Promise<McpCatalogEntry[]> {
    try {
        return parseCatalog(decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, 'media', 'mcpCatalog.json'))));
    } catch { return []; }
}

/** The catalog for the panel: each known server, its command, and whether it is configured already. */
export async function mcpCatalogMessage(extensionUri: vscode.Uri): Promise<{ type: 'mcpCatalog'; servers: McpCatalogRow[] }> {
    return { type: 'mcpCatalog', servers: catalogRows(await loadCatalog(extensionUri), await loadMcpConfigs()) };
}

/** The project's MCP file: the one that exists, else `.mcp.json`. */
async function projectMcpFile(root: vscode.Uri): Promise<{ uri: vscode.Uri; text: string | undefined }> {
    for (const name of ['.mcp.json', 'mcp.json']) {
        const uri = vscode.Uri.joinPath(root, name);
        try { return { uri, text: decoder.decode(await vscode.workspace.fs.readFile(uri)) }; } catch { /* try the next name */ }
    }
    return { uri: vscode.Uri.joinPath(root, '.mcp.json'), text: undefined };
}

async function addServer(entry: McpCatalogEntry, context: vscode.ExtensionContext): Promise<boolean> {
    if ((await loadMcpConfigs()).some(config => config.name === entry.id)) {
        void vscode.window.showInformationMessage(`Codico: an MCP server named "${entry.id}" is already configured.`);
        return false;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const line = catalogRows([entry], [])[0].commandLine;
    const toProject = 'Add to This Project';
    const forAll = 'Add for All Projects';
    // Asked by VS Code itself, not in the panel: what is approved is exactly what is shown here
    const choice = await vscode.window.showWarningMessage(
        `Add the MCP server "${entry.name}" (${entry.publisher})?`,
        {
            modal: true,
            detail: `Codico will run this command on your machine, now and each time it starts:\n\n    ${line}\n\n` +
                `Requires ${entry.requires}. The command downloads the package and runs it with your user's access: only add servers you trust.\n\n` +
                `It adds ${entry.tools} tool${entry.tools === 1 ? '' : 's'}; each is described to the model on every request.\n\n` +
                `"${toProject}" writes it to .mcp.json, shared with everyone who opens the project. "${forAll}" writes it to your user settings.`,
        },
        ...(root ? [toProject, forAll] : [forAll]),
    );
    if (choice === toProject && root) {
        const file = await projectMcpFile(root);
        let text: string;
        try { text = addToMcpJson(file.text, entry); } catch (err) {
            void vscode.window.showErrorMessage(`Codico: ${vscode.workspace.asRelativePath(file.uri)} could not be updated (${err instanceof Error ? err.message : String(err)}). Fix the file, then add the server again.`);
            return false;
        }
        await vscode.workspace.fs.writeFile(file.uri, new TextEncoder().encode(text));
        // Just approved, with this exact command: no second question when it starts
        const approved = context.workspaceState.get<Record<string, true>>(APPROVED_WORKSPACE_MCP_KEY, {});
        approved[mcpFingerprint({ name: entry.id, command: entry.command, args: entry.args })] = true;
        await context.workspaceState.update(APPROVED_WORKSPACE_MCP_KEY, approved);
        return true;
    }
    if (choice === forAll) {
        const config = vscode.workspace.getConfiguration('codico');
        const servers = config.inspect<McpServerConfig[]>('mcpServers')?.globalValue ?? [];
        await config.update('mcpServers', [...servers, { name: entry.id, command: entry.command, args: entry.args }], vscode.ConfigurationTarget.Global);
        return true;
    }
    return false;
}

async function removeServer(name: string): Promise<boolean> {
    const existing = (await loadMcpConfigs()).find(config => config.name === name);
    if (!existing) { return false; }
    if (existing.source === 'workspace') {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!root) { return false; }
        const file = await projectMcpFile(root);
        if (file.text === undefined) { return false; }
        try {
            await vscode.workspace.fs.writeFile(file.uri, new TextEncoder().encode(removeFromMcpJson(file.text, name)));
        } catch (err) {
            void vscode.window.showErrorMessage(`Codico: ${vscode.workspace.asRelativePath(file.uri)} could not be updated (${err instanceof Error ? err.message : String(err)}).`);
            return false;
        }
        return true;
    }
    const config = vscode.workspace.getConfiguration('codico');
    const inspected = config.inspect<McpServerConfig[]>('mcpServers');
    // The setting can hold the server at more than one level: remove it wherever it is
    for (const [value, target] of [
        [inspected?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
        [inspected?.workspaceValue, vscode.ConfigurationTarget.Workspace],
        [inspected?.globalValue, vscode.ConfigurationTarget.Global],
    ] as Array<[McpServerConfig[] | undefined, vscode.ConfigurationTarget]>) {
        if (value?.some(server => server.name === name)) { await config.update('mcpServers', value.filter(server => server.name !== name), target); }
    }
    return true;
}

/**
 * A request from the panel's MCP catalog.
 * @returns true when the configuration changed, so the servers must be reconnected
 */
export async function handleMcpCatalogAction(
    msg: { action: 'open' | 'add' | 'remove'; id?: string },
    context: vscode.ExtensionContext,
    extensionUri: vscode.Uri,
): Promise<boolean> {
    if (msg.action === 'open' || !msg.id) { return false; }
    // Only what the bundled catalog lists can be added: the panel sends an id, never a command
    const entry = (await loadCatalog(extensionUri)).find(candidate => candidate.id === msg.id);
    if (!entry) { return false; }
    return msg.action === 'add' ? addServer(entry, context) : removeServer(entry.id);
}
