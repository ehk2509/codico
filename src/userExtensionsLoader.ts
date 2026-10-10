import * as vscode from 'vscode';
import {
    collectUserExtensions, nameProblem, NO_USER_EXTENSIONS, parseAgentFile, parseSkillFile, templateFor, UserExtensions,
} from './userExtensions';

const FOLDER = '.codico';

/**
 * Reads the project's agents and skills from its `.codico` folder, keeps them until a file
 * there changes, and tells the listener when they do.
 */
export class UserExtensionsLoader implements vscode.Disposable {
    private _loaded: Promise<UserExtensions> | undefined;
    private _reported = '';
    private readonly _watcher: vscode.FileSystemWatcher;

    constructor(private readonly _onChange: (extensions: UserExtensions) => void) {
        this._watcher = vscode.workspace.createFileSystemWatcher(`**/${FOLDER}/{agents,skills}/**`);
        const reload = (): void => { this._loaded = undefined; void this.get().then(this._onChange); };
        this._watcher.onDidChange(reload);
        this._watcher.onDidCreate(reload);
        this._watcher.onDidDelete(reload);
    }

    dispose(): void { this._watcher.dispose(); }

    get(): Promise<UserExtensions> {
        this._loaded ??= this._load().catch(() => NO_USER_EXTENSIONS);
        return this._loaded;
    }

    private async _load(): Promise<UserExtensions> {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        // Instructions from a folder the user has not trusted are not followed
        if (!root || !vscode.workspace.isTrusted) { return NO_USER_EXTENSIONS; }
        const decoder = new TextDecoder();
        const read = async (uri: vscode.Uri): Promise<string | undefined> => {
            try { return decoder.decode(await vscode.workspace.fs.readFile(uri)); } catch { return undefined; }
        };
        const list = async (uri: vscode.Uri): Promise<Array<[string, vscode.FileType]>> => {
            try { return (await vscode.workspace.fs.readDirectory(uri)).sort((a, b) => a[0].localeCompare(b[0])); } catch { return []; }
        };
        const isFile = (type: vscode.FileType): boolean => (type & vscode.FileType.File) !== 0;
        const isFolder = (type: vscode.FileType): boolean => (type & vscode.FileType.Directory) !== 0;

        const agentsDir = vscode.Uri.joinPath(root, FOLDER, 'agents');
        const agents = [];
        for (const [name, type] of await list(agentsDir)) {
            if (!isFile(type) || !/\.md$/i.test(name)) { continue; }
            const text = await read(vscode.Uri.joinPath(agentsDir, name));
            if (text !== undefined) { agents.push(parseAgentFile(`${FOLDER}/agents/${name}`, name, text)); }
        }

        const skillsDir = vscode.Uri.joinPath(root, FOLDER, 'skills');
        const skills = [];
        for (const [name, type] of await list(skillsDir)) {
            if (isFolder(type)) {
                const text = await read(vscode.Uri.joinPath(skillsDir, name, 'SKILL.md'));
                if (text !== undefined) { skills.push(parseSkillFile(`${FOLDER}/skills/${name}/SKILL.md`, name, text)); }
            } else if (isFile(type) && /\.md$/i.test(name)) {
                const text = await read(vscode.Uri.joinPath(skillsDir, name));
                if (text !== undefined) { skills.push(parseSkillFile(`${FOLDER}/skills/${name}`, name, text)); }
            }
        }

        const extensions = collectUserExtensions(agents, skills);
        this._reportProblems(extensions.problems);
        return extensions;
    }

    /** Tells the user about skipped files, once per distinct set of problems. */
    private _reportProblems(problems: string[]): void {
        const key = problems.join('\n');
        if (key === this._reported) { return; }
        this._reported = key;
        if (problems.length === 0) { return; }
        const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
        void vscode.window.showWarningMessage(`Codico skipped a project skill or agent: ${problems[0]}${more}`);
    }
}

/** "Codico: New Skill" / "Codico: New Agent": asks for a name, writes a starting file and opens it. */
export async function createUserExtension(kind: 'agent' | 'skill'): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) { void vscode.window.showErrorMessage('Open a folder first: skills and agents belong to a project.'); return; }
    const name = (await vscode.window.showInputBox({
        title: kind === 'agent' ? 'New Codico agent' : 'New Codico skill',
        prompt: kind === 'agent' ? 'Name of the agent (you will call it with @name)' : 'Name of the skill (you can run it with /name)',
        placeHolder: kind === 'agent' ? 'reviewer' : 'add-migration',
        validateInput: value => nameProblem(kind, value.trim()),
    }))?.trim();
    if (!name) { return; }
    const file = kind === 'agent'
        ? vscode.Uri.joinPath(root, FOLDER, 'agents', `${name}.md`)
        : vscode.Uri.joinPath(root, FOLDER, 'skills', name, 'SKILL.md');
    let exists = true;
    try { await vscode.workspace.fs.stat(file); } catch { exists = false; }
    if (!exists) { await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(templateFor(kind, name))); }
    await vscode.window.showTextDocument(file);
}
