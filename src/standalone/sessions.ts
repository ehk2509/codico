/** Private, workspace-scoped history for the standalone terminal agent. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { ChatMessage } from '../openRouterClient';

const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES = 300;
const SESSION_ID = /^[a-f0-9-]{36}$/i;

export interface SavedSession {
    version: 1;
    id: string;
    workspace: string;
    model: string;
    updatedAt: string;
    history: ChatMessage[];
}

export class SessionStore {
    readonly root: string;
    readonly workspace: string;

    constructor(workspace: string, baseDir: string = path.join(os.homedir(), '.codico', 'sessions')) {
        this.workspace = fs.realpathSync(workspace);
        const digest = createHash('sha256').update(process.platform === 'win32' ? this.workspace.toLowerCase() : this.workspace).digest('hex').slice(0, 24);
        this.root = path.join(baseDir, digest);
    }

    private ensureDir(): void {
        // A symlink in the private session hierarchy could redirect the files elsewhere.
        const parent = path.dirname(this.root);
        if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) {
            throw new Error('Session parent cannot be a symlink');
        }
        fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
        if (!fs.lstatSync(this.root).isDirectory()) { throw new Error('Session directory must not be a symlink'); }
        if (process.platform !== 'win32') { fs.chmodSync(this.root, 0o700); }
    }

    private file(id: string): string {
        if (!SESSION_ID.test(id)) { throw new Error('Invalid session ID'); }
        return path.join(this.root, id + '.json');
    }

    create(model: string): SavedSession {
        return { version: 1, id: randomUUID(), workspace: this.workspace, model, updatedAt: new Date().toISOString(), history: [] };
    }

    save(session: SavedSession): void {
        if (session.workspace !== this.workspace || session.version !== 1) { throw new Error('Session workspace mismatch'); }
        const target = this.file(session.id);
        this.ensureDir();
        const updated: SavedSession = { ...session, updatedAt: new Date().toISOString(),
            history: session.history.slice(-MAX_MESSAGES) };
        const serialized = JSON.stringify(updated);
        if (Buffer.byteLength(serialized) > MAX_SESSION_BYTES) { throw new Error('Session too large to persist'); }
        const temp = path.join(this.root, '.' + randomUUID() + '.tmp');
        try {
            fs.writeFileSync(temp, serialized, { mode: 0o600, flag: 'wx' });
            fs.renameSync(temp, target);
            if (process.platform !== 'win32') { fs.chmodSync(target, 0o600); }
        } finally {
            try { fs.unlinkSync(temp); } catch { /* already renamed */ }
        }
    }

    load(id: string): SavedSession {
        const filename = this.file(id);
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.size > MAX_SESSION_BYTES) { throw new Error('Invalid session file'); }
        const parsed = JSON.parse(fs.readFileSync(filename, 'utf8')) as Partial<SavedSession>;
        if (parsed.version !== 1 || parsed.id !== id || parsed.workspace !== this.workspace ||
            typeof parsed.model !== 'string' || !Array.isArray(parsed.history) || parsed.history.length > MAX_MESSAGES) {
            throw new Error('Invalid or foreign session data');
        }
        for (const message of parsed.history) {
            if (!message || !['system','user','assistant','tool'].includes(message.role) ||
                !(typeof message.content === 'string' || Array.isArray(message.content))) {
                throw new Error('Malformed session message');
            }
        }
        return parsed as SavedSession;
    }

    list(): Array<Pick<SavedSession,'id'|'model'|'updatedAt'>> {
        if (!fs.existsSync(this.root)) { return []; }
        this.ensureDir();
        const result: Array<Pick<SavedSession,'id'|'model'|'updatedAt'>> = [];
        for (const name of fs.readdirSync(this.root).filter(x => SESSION_ID.test(x.replace(/\.json$/, '')) && x.endsWith('.json')).slice(0, 300)) {
            try {
                const session = this.load(name.slice(0, -5));
                result.push({ id: session.id, model: session.model, updatedAt: session.updatedAt });
            } catch { /* ignore corrupt sessions */ }
        }
        return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    latest(): SavedSession | undefined {
        const id = this.list()[0]?.id;
        return id ? this.load(id) : undefined;
    }

    remove(id: string): void {
        if (!fs.existsSync(this.root)) { return; }
        fs.unlinkSync(this.file(id));
    }
}
