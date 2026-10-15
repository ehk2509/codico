import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { latestVersion, parseRegistry, PackageManifest, readManifest, RegistryPackage, sourceProblem } from './marketplace';
import { contentHash, packageFiles, PackageFile, readTarGz } from './packageArchive';
import { scanPackage, ScanResult } from './packageScan';
import { githubArchive } from './marketplaceInstaller';
import { parseGitHubRemote } from './pullRequests';

/**
 * The publisher's and the registry's tools, run by `codico package check` and
 * `codico registry verify` (bundled apart from the extension: no editor needed).
 */

const git = (cwd: string, ...args: string[]) => { try { return cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return undefined; } };

/** The package's files as GitHub will serve them for a commit: what git tracks under the folder (all files outside a repository). */
function filesOf(dir: string): { files: PackageFile[]; root?: string } {
    const root = git(dir, 'rev-parse', '--show-toplevel');
    const tracked = root ? git(dir, 'ls-files', '-z', '--', '.') : undefined;
    const names = tracked !== undefined ? tracked.split('\0').filter(Boolean)
        : (function walk(d: string, prefix = ''): string[] { return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.name === '.git' ? [] : e.isDirectory() ? walk(path.join(d, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]); })(dir);
    return { files: names.map(name => ({ path: name, data: fs.readFileSync(path.join(dir, name)) })), root: root ?? undefined };
}

export interface CheckResult {
    problems: string[];
    warnings: string[];
    manifest?: PackageManifest;
    hash?: string;
    scan?: ScanResult;
    /** The registry entry to submit for this version. */
    entry?: Record<string, unknown>;
}

/** `codico package check [dir]`: is the package valid, what does the scan find, and its registry entry. */
export function checkPackage(dir: string): CheckResult {
    const result: CheckResult = { problems: [], warnings: [] };
    const { files, root } = filesOf(dir);
    const manifest = readManifest(files);
    if ('error' in manifest) { result.problems.push(manifest.error); return result; }
    result.manifest = manifest;
    result.hash = contentHash(files);
    result.scan = scanPackage(manifest, files);
    if (!root) { result.warnings.push('not in a git repository: the registry needs the package in a public GitHub repository, at a commit'); return result; }
    if (git(dir, 'status', '--porcelain', '--', '.')) { result.problems.push('the folder has uncommitted changes: the registry pins a commit, and its content would differ'); }
    if (fs.existsSync(path.join(root, '.gitattributes')) && /export-ignore/.test(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'))) { result.warnings.push('.gitattributes has export-ignore: GitHub leaves those files out of the download, so the hash would differ'); }
    const repo = parseGitHubRemote(git(dir, 'config', '--get', 'remote.origin.url') ?? '');
    const commit = git(dir, 'rev-parse', 'HEAD');
    if (!repo) { result.problems.push('the repository\'s origin is not on github.com'); }
    else if (repo.owner.toLowerCase() !== manifest.id.split('/')[0]) { result.problems.push(`the id ${manifest.id} must start with the repository owner's account (${repo.owner.toLowerCase()}/…)`); }
    const folder = path.relative(root, path.resolve(dir)).split(path.sep).join('/');
    result.entry = {
        id: manifest.id, description: manifest.description, publisher: { github: repo?.owner ?? manifest.id.split('/')[0], verified: false },
        contains: { skills: manifest.skills?.length ?? 0, agents: manifest.agents?.length ?? 0, mcpServers: Object.keys(manifest.mcpServers ?? {}).length, hooks: manifest.hooks?.length ?? 0 },
        versions: [{ version: manifest.version, repo: repo ? `${repo.owner}/${repo.repo}` : '', commit: commit ?? '', path: folder, hash: result.hash, published: new Date().toISOString().slice(0, 10) }],
    };
    return result;
}

export interface VerifyResult { id: string; version: string; ok: boolean; problems: string[]; risk?: ScanResult['risk']; findings?: ScanResult['findings'] }

/**
 * `codico registry verify <index.json>`: for each package (or those named), the latest
 * version is downloaded at its commit and checked — content hash, manifest, publisher's
 * account, scan. The registry's CI runs it on every pull request.
 */
export async function verifyRegistry(indexText: string, download: (url: string) => Promise<Buffer>, only?: string[], archiveUrl = githubArchive): Promise<{ results: VerifyResult[]; problems: string[] }> {
    let value: unknown;
    try { value = JSON.parse(indexText); } catch (error) { return { results: [], problems: [`index.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }; }
    const { packages, problems } = parseRegistry(value);
    const ids = new Set<string>();
    for (const pkg of packages) { if (ids.has(pkg.id)) { problems.push(`${pkg.id} is listed twice`); } ids.add(pkg.id); }
    const results: VerifyResult[] = [];
    for (const pkg of packages.filter((p: RegistryPackage) => !only?.length || only.includes(p.id))) {
        const version = latestVersion(pkg)!;
        const result: VerifyResult = { id: pkg.id, version: version.version, ok: false, problems: [] };
        results.push(result);
        const source = sourceProblem(pkg, version);
        if (source) { result.problems.push(source); }
        let files: PackageFile[];
        try { files = packageFiles(readTarGz(await download(archiveUrl(version.repo, version.commit))), version.path); } catch (error) { result.problems.push(`download: ${error instanceof Error ? error.message : String(error)}`); continue; }
        const hash = contentHash(files);
        if (hash !== version.hash) { result.problems.push(`content hash is ${hash}, the index says ${version.hash}`); }
        const manifest = readManifest(files);
        if ('error' in manifest) { result.problems.push(manifest.error); continue; }
        if (manifest.id !== pkg.id || manifest.version !== version.version) { result.problems.push(`the package says ${manifest.id} ${manifest.version}`); }
        const scan = scanPackage(manifest, files);
        result.risk = scan.risk; result.findings = scan.findings;
        result.ok = result.problems.length === 0;
    }
    return { results, problems };
}
