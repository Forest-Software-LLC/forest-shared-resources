/*
    forest-shared-resources / rbxm / binary

    Shared low-level primitives for the rbxm binary format: bounded reader,
    chunk decompression (lz4 + zstd), and the interleaved integer and float
    encodings. Used by the enforcement scanner (index.ts) and the DOM
    parser (dom.ts). Format reference: dom.rojo.space/binary.
*/

import { decompress as zstdDecompress } from 'fzstd';
import { decodeLz4Block } from './lz4';

export class RbxmParseError extends Error {}

export function fail(message: string): never {
    throw new RbxmParseError(message);
}

export const MAGIC = Buffer.from('<roblox!', 'ascii');
export const SIGNATURE = Buffer.from([0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a]);
export const END_CONTENT = Buffer.from('</roblox>', 'ascii');
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export class Reader {
    constructor(private readonly buf: Buffer, public pos = 0) {}

    get remaining(): number {
        return this.buf.length - this.pos;
    }

    bytes(n: number): Buffer {
        if (n < 0 || this.pos + n > this.buf.length) fail('unexpected end of data');
        const out = this.buf.subarray(this.pos, this.pos + n);
        this.pos += n;
        return out;
    }

    u8(): number {
        return this.bytes(1)[0];
    }

    u16(): number {
        return this.bytes(2).readUInt16LE(0);
    }

    u32(): number {
        return this.bytes(4).readUInt32LE(0);
    }

    i32(): number {
        return this.bytes(4).readInt32LE(0);
    }

    f32(): number {
        return this.bytes(4).readFloatLE(0);
    }

    f64(): number {
        return this.bytes(8).readDoubleLE(0);
    }

    string(maxLength: number): string {
        const len = this.u32();
        if (len > maxLength) fail(`string length ${len} exceeds limit ${maxLength}`);
        return this.bytes(len).toString('utf8');
    }
}

export function toBuffer(data: Uint8Array): Buffer {
    return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Byte-interleaved big-endian u32 array, no transform. */
export function readInterleavedU32(reader: Reader, count: number): number[] {
    const raw = reader.bytes(count * 4);
    const values: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
        values[i] = ((raw[i] << 24) | (raw[count + i] << 16) | (raw[2 * count + i] << 8) | raw[3 * count + i]) >>> 0;
    }
    return values;
}

/** Interleaved i32s, zigzag transformed (no accumulation). */
export function readInterleavedI32(reader: Reader, count: number): number[] {
    const values = readInterleavedU32(reader, count);
    for (let i = 0; i < count; i++) {
        const v = values[i];
        values[i] = (v >>> 1) ^ -(v & 1);
    }
    return values;
}

/** Interleaved zigzag i32s with referent accumulation semantics. */
export function readReferentArray(reader: Reader, count: number): number[] {
    const values = readInterleavedI32(reader, count);
    let acc = 0;
    for (let i = 0; i < count; i++) {
        acc = (acc + values[i]) | 0;
        values[i] = acc;
    }
    return values;
}

const floatScratch = new DataView(new ArrayBuffer(4));

/** Interleaved f32s with the sign bit rotated to the low bit. */
export function readInterleavedF32(reader: Reader, count: number): number[] {
    const raw = readInterleavedU32(reader, count);
    const values: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
        const enc = raw[i];
        const bits = ((enc >>> 1) | ((enc & 1) << 31)) >>> 0;
        floatScratch.setUint32(0, bits);
        values[i] = floatScratch.getFloat32(0);
    }
    return values;
}

/** Interleaved 8-byte zigzag i64s, returned as numbers. */
export function readInterleavedI64(reader: Reader, count: number): number[] {
    const raw = reader.bytes(count * 8);
    const values: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
        let v = 0n;
        for (let b = 0; b < 8; b++) {
            v = (v << 8n) | BigInt(raw[b * count + i]);
        }
        const decoded = (v >> 1n) ^ -(v & 1n);
        values[i] = Number(decoded);
    }
    return values;
}

export interface ChunkHeader {
    name: string;
    compressedLength: number;
    uncompressedLength: number;
}

export function readChunkHeader(reader: Reader): ChunkHeader {
    const name = reader.bytes(4).toString('latin1').replace(/\0+$/, '');
    const compressedLength = reader.u32();
    const uncompressedLength = reader.u32();
    reader.bytes(4); // reserved
    return { name, compressedLength, uncompressedLength };
}

export function decompressChunk(header: ChunkHeader, payload: Buffer): Buffer {
    if (header.compressedLength === 0) {
        return payload;
    }
    let out: Uint8Array;
    if (payload.length >= 4 && payload.subarray(0, 4).equals(ZSTD_MAGIC)) {
        try {
            out = zstdDecompress(payload, new Uint8Array(header.uncompressedLength));
        } catch (err) {
            fail(`${header.name} chunk: zstd decompression failed (${(err as Error).message})`);
        }
    } else {
        try {
            out = decodeLz4Block(payload, header.uncompressedLength);
        } catch (err) {
            fail(`${header.name} chunk: lz4 decompression failed (${(err as Error).message})`);
        }
    }
    if (out.length !== header.uncompressedLength) {
        fail(`${header.name} chunk: decompressed size mismatch`);
    }
    return Buffer.from(out.buffer, out.byteOffset, out.length);
}

export interface FileHeader {
    declaredClassCount: number;
    declaredInstanceCount: number;
}

export function readFileHeader(reader: Reader): FileHeader {
    if (!reader.bytes(MAGIC.length).equals(MAGIC)) fail('not an rbxm file (bad magic)');
    if (!reader.bytes(SIGNATURE.length).equals(SIGNATURE)) fail('not an rbxm file (bad signature)');
    const version = reader.u16();
    if (version !== 0) fail(`unsupported rbxm version ${version}`);
    const declaredClassCount = reader.i32();
    const declaredInstanceCount = reader.i32();
    reader.bytes(8); // reserved
    return { declaredClassCount, declaredInstanceCount };
}
