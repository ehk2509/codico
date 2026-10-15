import * as crypto from 'crypto';
import * as zlib from 'zlib';

/**
 * Reading a package from GitHub's tarball of a commit, and the hash that identifies its
 * content. Nothing is written to disk here: a package is checked whole before any of it is.
 */

export interface PackageFile { path: string; data: Buffer }

export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PACKAGE_FILES = 500;

const field = (block: Buffer, start: number, length: number) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
const octal = (block: Buffer, start: number, length: number) => parseInt(field(block, start, length).trim() || '0', 8);

/** The "path" record of a pax extended header, when it has one. */
function paxPath(data: Buffer): string | undefined {
    for (const record of data.toString('utf8').split('\n')) {
        const match = /^\d+ path=(.*)$/.exec(record);
        if (match) { return match[1]; }
    }
    return undefined;
}

/**
 * The regular files of a .tar.gz, by path. Links, devices and anything that would leave the
 * folder (absolute paths, "..") are refused, not skipped: a package with them is not installed.
 */
export function readTarGz(archive: Buffer): PackageFile[] {
    if (archive.length > MAX_ARCHIVE_BYTES) { throw new Error('the archive is too large'); }
    const tar = zlib.gunzipSync(archive, { maxOutputLength: MAX_ARCHIVE_BYTES * 4 });
    const files: PackageFile[] = [];
    let offset = 0;
    let longName: string | undefined;
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) { break; }
        const size = octal(header, 124, 12);
        const type = String.fromCharCode(header[156] || 48);
        const data = tar.subarray(offset + 512, offset + 512 + size);
        offset += 512 + Math.ceil(size / 512) * 512;
        if (type === 'g') { continue; }                       // global pax header (GitHub puts the commit there)
        if (type === 'x') { longName = paxPath(data); continue; }
        if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
        const prefix = field(header, 345, 155);
        const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
        longName = undefined;
        if (type === '5') { continue; }                       // directory
        if (type !== '0' && type !== '\0' && type !== '7') { throw new Error(`"${name}" is a link or a special file; packages contain plain files only`); }
        if (name.startsWith('/') || name.split('/').includes('..') || /^[A-Za-z]:/.test(name)) { throw new Error(`"${name}" would be written outside the package`); }
        files.push({ path: name, data: Buffer.from(data) });
    }
    return files;
}

/** The files under `folder` of an archive made by GitHub (whose first folder is "<repo>-<commit>"), relative to it. */
export function packageFiles(files: PackageFile[], folder: string): PackageFile[] {
    const base = folder.replace(/^\/+|\/+$/g, '');
    const result = files.map(file => ({ ...file, path: file.path.split('/').slice(1).join('/') }))
        .filter(file => !base || file.path === base || file.path.startsWith(`${base}/`))
        .map(file => ({ ...file, path: base ? file.path.slice(base.length + 1) : file.path }))
        .filter(file => file.path);
    if (result.length > MAX_PACKAGE_FILES) { throw new Error(`the package has ${result.length} files; at most ${MAX_PACKAGE_FILES}`); }
    if (result.reduce((sum, file) => sum + file.data.length, 0) > MAX_PACKAGE_BYTES) { throw new Error('the package is larger than 5 MB'); }
    return result;
}

/**
 * The hash that identifies a package's content: SHA-256 over its files in path order. The
 * registry records it for each version; what is installed must have the same.
 */
export function contentHash(files: PackageFile[]): string {
    const hash = crypto.createHash('sha256');
    for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
        hash.update(file.path); hash.update('\0'); hash.update(String(file.data.length)); hash.update('\0'); hash.update(file.data);
    }
    return `sha256-${hash.digest('hex')}`;
}
