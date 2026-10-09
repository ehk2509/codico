import { resolveWorkspaceToolPath } from './workspaceSecurity';
import { revealFile, writeCurrentBytes } from './workspaceText';

export class FileManager {
    async writeFile(filepath: string, content: string): Promise<void> {
        const target = await resolveWorkspaceToolPath(filepath);

        await writeCurrentBytes(target.uri, new TextEncoder().encode(content));
        // Only a display step: a file VS Code cannot show as text was still written
        await revealFile(target.uri);
    }
}
