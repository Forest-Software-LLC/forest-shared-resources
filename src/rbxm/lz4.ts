/*
    forest-shared-resources / rbxm / lz4

    Minimal LZ4 raw block decoder for rbxm chunk payloads. Roblox chunks are
    bare LZ4 blocks (no frame header) with the decompressed size declared in
    the chunk header, which is exactly the shape this decoder wants.

    Hand rolled on purpose: the block format is tiny and stable, and this
    code runs on untrusted uploads, so every read and write is bounds
    checked and any malformed input throws instead of overrunning.
*/

export class Lz4Error extends Error {}

function fail(message: string): never {
    throw new Lz4Error(message);
}

export function decodeLz4Block(src: Uint8Array, dstSize: number): Uint8Array {
    const dst = new Uint8Array(dstSize);
    const srcLen = src.length;
    let s = 0;
    let d = 0;

    if (dstSize === 0) {
        if (srcLen !== 0) fail('trailing bytes after empty block');
        return dst;
    }

    while (s < srcLen) {
        const token = src[s++];

        let litLen = token >>> 4;
        if (litLen === 0xf) {
            let b: number;
            do {
                if (s >= srcLen) fail('truncated literal length');
                b = src[s++];
                litLen += b;
            } while (b === 0xff);
        }

        if (s + litLen > srcLen) fail('literal run past end of input');
        if (d + litLen > dstSize) fail('literal run past declared output size');
        dst.set(src.subarray(s, s + litLen), d);
        s += litLen;
        d += litLen;

        // The final sequence is literals only
        if (s === srcLen) break;

        if (s + 2 > srcLen) fail('truncated match offset');
        const offset = src[s] | (src[s + 1] << 8);
        s += 2;
        if (offset === 0) fail('zero match offset');
        if (offset > d) fail('match offset before start of output');

        let matchLen = token & 0xf;
        if (matchLen === 0xf) {
            let b: number;
            do {
                if (s >= srcLen) fail('truncated match length');
                b = src[s++];
                matchLen += b;
            } while (b === 0xff);
        }
        matchLen += 4;

        if (d + matchLen > dstSize) fail('match run past declared output size');
        // Byte-by-byte because overlapping copies (offset < matchLen) are
        // legal LZ4 and must repeat freshly written bytes
        let m = d - offset;
        for (let i = 0; i < matchLen; i++) {
            dst[d++] = dst[m++];
        }
    }

    if (d !== dstSize) fail(`decompressed size mismatch: got ${d}, declared ${dstSize}`);
    return dst;
}
