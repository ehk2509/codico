import * as crypto from 'crypto';

export interface PersistedIndexChunk {
    file: string;
    startLine: number;
    vector?: number[];
    textHash?: string;
}

export function hashIndexText(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function canReusePersistedVector(text: string, chunk?: PersistedIndexChunk): boolean {
    return Boolean(
        chunk?.vector &&
        chunk.vector.length > 0 &&
        chunk.textHash &&
        chunk.textHash === hashIndexText(text)
    );
}
