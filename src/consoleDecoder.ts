/**
 * Decodes command output on Windows. cmd.exe and many console programs write in the console's OEM code
 * page (850 on Western-European systems, 437 in the US), not UTF-8, so reading them as UTF-8 turned
 * "exécutable" into "ex�cutable". Each chunk is read as UTF-8 when it is valid UTF-8 (node, git, npm…)
 * and otherwise in the OEM code page; a UTF-8 sequence split across chunks is carried over, not broken.
 */
import { spawnSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';

const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const CP850 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ';

let cachedCodePage: number | undefined;

/** The console's OEM code page (asked once from `chcp`), e.g. 850. */
export function oemCodePage(): number {
    if (cachedCodePage !== undefined) { return cachedCodePage; }
    cachedCodePage = 437;
    if (process.platform === 'win32') {
        try {
            const out = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'chcp'], { encoding: 'latin1', windowsHide: true, timeout: 3000 }).stdout;
            const match = /(\d{3,5})\s*$/.exec((out ?? '').trim());
            if (match) { cachedCodePage = Number(match[1]); }
        } catch { /* keep 437 */ }
    }
    return cachedCodePage;
}

/** Decode bytes in a DOS/OEM code page. */
export function decodeOem(bytes: Buffer, codePage = oemCodePage()): string {
    const table = codePage === 850 ? CP850 : codePage === 437 ? CP437 : undefined;
    if (table) {
        let out = '';
        for (const byte of bytes) { out += byte < 0x80 ? String.fromCharCode(byte) : table[byte - 0x80]; }
        return out;
    }
    const label = codePage === 866 ? 'ibm866' : codePage >= 1250 && codePage <= 1258 ? `windows-${codePage}` : codePage === 65001 ? 'utf-8' : 'windows-1252';
    try { return new TextDecoder(label).decode(bytes); } catch { return bytes.toString('latin1'); }
}

/** Length of an incomplete UTF-8 sequence at the end of the buffer (0 to 3 bytes). */
function incompleteTail(bytes: Buffer): number {
    for (let back = 1; back <= Math.min(3, bytes.length); back++) {
        const byte = bytes[bytes.length - back];
        if ((byte & 0xc0) === 0x80) { continue; } // continuation byte: keep looking for the lead byte
        const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
        return need > back ? back : 0;
    }
    return 0;
}

export class ConsoleDecoder {
    private carry: Buffer = Buffer.alloc(0);
    constructor(private readonly codePage?: number) { }

    write(chunk: Buffer): string {
        const bytes = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
        const cut = bytes.length - incompleteTail(bytes);
        const head = bytes.subarray(0, cut);
        this.carry = Buffer.from(bytes.subarray(cut));
        if (!head.length) { return ''; }
        return isUtf8(head) ? head.toString('utf8') : decodeOem(head, this.codePage);
    }

    end(): string {
        const rest = this.carry;
        this.carry = Buffer.alloc(0);
        if (!rest.length) { return ''; }
        return isUtf8(rest) ? rest.toString('utf8') : decodeOem(rest, this.codePage);
    }
}
