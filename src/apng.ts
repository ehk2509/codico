/**
 * Animated PNG from PNG frames of one size: the replay of a browser check, played by any
 * browser and by VS Code's image preview. Frames are not decoded: each frame's compressed
 * image data is reused as it is, so this needs no image library.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(data: Buffer): number {
    let c = 0xffffffff;
    for (const byte of data) { c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); }
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
}

interface Png { ihdr: Buffer; width: number; height: number; idat: Buffer[]; other: Buffer[] }

/** The chunks of a PNG that matter here; undefined when it is not one. */
export function readPng(png: Buffer): Png | undefined {
    if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) { return undefined; }
    let offset = 8;
    let ihdr: Buffer | undefined;
    const idat: Buffer[] = [];
    const other: Buffer[] = [];
    while (offset + 12 <= png.length) {
        const length = png.readUInt32BE(offset);
        const type = png.toString('ascii', offset + 4, offset + 8);
        const data = png.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') { ihdr = Buffer.from(data); }
        else if (type === 'IDAT') { idat.push(Buffer.from(data)); }
        else if (type === 'PLTE' || type === 'tRNS' || type === 'sRGB' || type === 'gAMA') { other.push(png.subarray(offset, offset + 12 + length)); }
        else if (type === 'IEND') { break; }
        offset += 12 + length;
    }
    if (!ihdr || idat.length === 0) { return undefined; }
    return { ihdr, width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4), idat, other };
}

/**
 * The frames as one animated PNG, each shown for `delayMs`; frames of another size or
 * another pixel format than the first are left out. Undefined when there is no usable frame.
 */
export function animatedPng(frames: Buffer[], delayMs = 1200): Buffer | undefined {
    const pngs = frames.map(readPng).filter((png): png is Png => !!png);
    if (pngs.length === 0) { return undefined; }
    const first = pngs[0];
    const usable = pngs.filter(png => png.ihdr.equals(first.ihdr));
    const parts: Buffer[] = [SIGNATURE, chunk('IHDR', first.ihdr), ...first.other];
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(usable.length, 0);
    actl.writeUInt32BE(0, 4); // plays forever
    parts.push(chunk('acTL', actl));
    let sequence = 0;
    usable.forEach((png, index) => {
        const fctl = Buffer.alloc(26);
        fctl.writeUInt32BE(sequence++, 0);
        fctl.writeUInt32BE(png.width, 4);
        fctl.writeUInt32BE(png.height, 8);
        fctl.writeUInt32BE(0, 12); fctl.writeUInt32BE(0, 16);
        fctl.writeUInt16BE(Math.max(1, Math.min(65535, Math.round(delayMs))), 20);
        fctl.writeUInt16BE(1000, 22);
        fctl.writeUInt8(0, 24); fctl.writeUInt8(0, 25);
        parts.push(chunk('fcTL', fctl));
        for (const data of png.idat) {
            if (index === 0) { parts.push(chunk('IDAT', data)); continue; }
            const seq = Buffer.alloc(4);
            seq.writeUInt32BE(sequence++, 0);
            parts.push(chunk('fdAT', Buffer.concat([seq, data])));
        }
    });
    parts.push(chunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(parts);
}
