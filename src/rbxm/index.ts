/*
    forest-shared-resources / rbxm

    Scanner for Roblox binary model files (.rbxm), shared by
    forest-trust-gateway (publish enforcement) and forest-backend (wally
    mirror scan, retro sweep). Format reference: dom.rojo.space/binary.

    This is deliberately not a full DOM reader. Enforcement needs the class
    census (INST) and the parent structure (PRNT); property payloads are
    length-skipped without decompression, which also sidesteps decompression
    bombs for the bulk of the file. Everything is fail closed: unknown
    chunks, truncation, count mismatches, or undecodable compression reject
    the file rather than passing it through.

    scanRbxm parses and reports; checkRbxmPolicy applies forest's rules
    (no script classes, no services, exactly one root instance). The split
    keeps the parser reusable for read paths like the Code tab tree view.
*/

import { decompress as zstdDecompress } from 'fzstd';
import { decodeLz4Block } from './lz4';
import contract from '../../contracts/rbxm-rules.json';

const rules = contract.rbxm;

export const MODEL_FILE_EXTENSIONS: readonly string[] = Object.freeze([...rules.modelFileExtensions]);
export const REJECTED_MODEL_EXTENSIONS: readonly string[] = Object.freeze([...rules.rejectedModelExtensions]);
export const FORBIDDEN_CLASS_NAME_SUFFIX: string = rules.forbiddenClassNameSuffix;
export const MIN_LUAU_SOURCE_BYTES_WITH_MODELS: number = rules.minLuauSourceBytesWithModels;
export const RBXM_LIMITS = Object.freeze({ ...rules.limits });

export class RbxmParseError extends Error {}

export interface RbxmClassEntry {
    className: string;
    count: number;
    isService: boolean;
}

export interface RbxmScan {
    instanceCount: number;
    rootCount: number;
    classes: RbxmClassEntry[];
}

/** Case-sensitive suffix rule: catches Script, LocalScript, ModuleScript and future *Script variants. */
export function isForbiddenClassName(className: string): boolean {
    return className.endsWith(FORBIDDEN_CLASS_NAME_SUFFIX);
}

// --- binary primitives -------------------------------------------------------

const MAGIC = Buffer.from('<roblox!', 'ascii');
const SIGNATURE = Buffer.from([0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a]);
const END_CONTENT = Buffer.from('</roblox>', 'ascii');
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function fail(message: string): never {
    throw new RbxmParseError(message);
}

class Reader {
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

    string(maxLength: number): string {
        const len = this.u32();
        if (len > maxLength) fail(`string length ${len} exceeds limit ${maxLength}`);
        return this.bytes(len).toString('utf8');
    }
}

/**
 * Referent arrays store interleaved big-endian i32s (byte 0 of every value,
 * then byte 1 of every value, ...), each zigzag transformed, and referent
 * semantics additionally accumulate deltas.
 */
function readReferentArray(reader: Reader, count: number): number[] {
    const raw = reader.bytes(count * 4);
    const values: number[] = new Array(count);
    let acc = 0;
    for (let i = 0; i < count; i++) {
        const transformed =
            ((raw[i] << 24) | (raw[count + i] << 16) | (raw[2 * count + i] << 8) | raw[3 * count + i]) | 0;
        const delta = (transformed >>> 1) ^ -(transformed & 1);
        acc = (acc + delta) | 0;
        values[i] = acc;
    }
    return values;
}

// --- chunk walk --------------------------------------------------------------

interface ChunkHeader {
    name: string;
    compressedLength: number;
    uncompressedLength: number;
}

function decompressChunk(header: ChunkHeader, payload: Buffer): Buffer {
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

export function scanRbxm(data: Uint8Array): RbxmScan {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const reader = new Reader(buf);

    if (!reader.bytes(MAGIC.length).equals(MAGIC)) fail('not an rbxm file (bad magic)');
    if (!reader.bytes(SIGNATURE.length).equals(SIGNATURE)) fail('not an rbxm file (bad signature)');
    const version = reader.u16();
    if (version !== 0) fail(`unsupported rbxm version ${version}`);
    const declaredClassCount = reader.i32();
    const declaredInstanceCount = reader.i32();
    reader.bytes(8); // reserved

    if (declaredClassCount < 0 || declaredClassCount > rules.limits.maxClasses) {
        fail(`class count ${declaredClassCount} outside allowed range`);
    }
    if (declaredInstanceCount < 0 || declaredInstanceCount > rules.limits.maxInstances) {
        fail(`instance count ${declaredInstanceCount} outside allowed range`);
    }

    const classes: RbxmClassEntry[] = [];
    const seenClassIds = new Set<number>();
    const allReferents = new Set<number>();
    // referent -> parent referent, -1 for root
    const parentOf = new Map<number, number>();
    let totalDecompressed = 0;
    let sawEnd = false;

    while (!sawEnd) {
        if (reader.remaining === 0) fail('missing END chunk');
        const name = reader.bytes(4).toString('latin1');
        const compressedLength = reader.u32();
        const uncompressedLength = reader.u32();
        reader.bytes(4); // reserved
        const header: ChunkHeader = { name: name.replace(/\0+$/, ''), compressedLength, uncompressedLength };

        if (uncompressedLength > rules.limits.maxChunkDecompressedBytes) {
            fail(`${header.name} chunk declares ${uncompressedLength} bytes, over the per-chunk limit`);
        }
        const payloadLength = compressedLength === 0 ? uncompressedLength : compressedLength;
        const payload = reader.bytes(payloadLength);

        switch (header.name) {
            case 'END': {
                if (compressedLength !== 0 || !payload.equals(END_CONTENT)) {
                    fail('malformed END chunk');
                }
                sawEnd = true;
                break;
            }
            case 'META':
            case 'SSTR':
            case 'PROP':
                // Length-skipped without decompression; nothing enforced here
                // needs their contents
                break;
            case 'INST': {
                totalDecompressed += uncompressedLength;
                if (totalDecompressed > rules.limits.maxTotalDecompressedBytes) {
                    fail('total decompressed size exceeds limit');
                }
                const body = new Reader(decompressChunk(header, payload));
                const classId = body.u32();
                if (seenClassIds.has(classId)) fail(`duplicate INST chunk for class id ${classId}`);
                seenClassIds.add(classId);
                const className = body.string(rules.limits.maxClassNameLength);
                const objectFormat = body.u8();
                if (objectFormat !== 0 && objectFormat !== 1) {
                    fail(`INST ${className}: unknown object format ${objectFormat}`);
                }
                const count = body.u32();
                if (count > rules.limits.maxInstances) fail(`INST ${className}: instance count over limit`);
                const referents = readReferentArray(body, count);
                for (const ref of referents) {
                    if (allReferents.has(ref)) fail(`duplicate instance referent ${ref}`);
                    allReferents.add(ref);
                }
                if (objectFormat === 1) body.bytes(count); // service markers
                if (body.remaining !== 0) fail(`INST ${className}: trailing bytes in chunk`);
                classes.push({ className, count, isService: objectFormat === 1 });
                break;
            }
            case 'PRNT': {
                totalDecompressed += uncompressedLength;
                if (totalDecompressed > rules.limits.maxTotalDecompressedBytes) {
                    fail('total decompressed size exceeds limit');
                }
                const body = new Reader(decompressChunk(header, payload));
                const prntVersion = body.u8();
                if (prntVersion !== 0) fail(`unsupported PRNT version ${prntVersion}`);
                const linkCount = body.u32();
                if (linkCount > rules.limits.maxInstances) fail('PRNT link count over limit');
                const children = readReferentArray(body, linkCount);
                const parents = readReferentArray(body, linkCount);
                if (body.remaining !== 0) fail('PRNT: trailing bytes in chunk');
                for (let i = 0; i < linkCount; i++) {
                    if (parentOf.has(children[i])) fail(`instance ${children[i]} parented twice`);
                    parentOf.set(children[i], parents[i]);
                }
                break;
            }
            default:
                fail(`unknown chunk type "${header.name}"`);
        }
    }

    if (reader.remaining !== 0) fail('trailing bytes after END chunk');

    // Cross-checks against the header and between chunks
    if (classes.length !== declaredClassCount) {
        fail(`header declares ${declaredClassCount} classes, found ${classes.length}`);
    }
    const totalInstances = classes.reduce((sum, c) => sum + c.count, 0);
    if (totalInstances !== declaredInstanceCount) {
        fail(`header declares ${declaredInstanceCount} instances, found ${totalInstances}`);
    }
    if (parentOf.size !== totalInstances) {
        fail(`${totalInstances} instances but ${parentOf.size} parent links`);
    }

    let rootCount = 0;
    for (const [child, parent] of parentOf) {
        if (!allReferents.has(child)) fail(`PRNT references unknown instance ${child}`);
        if (parent === -1) {
            rootCount++;
        } else if (!allReferents.has(parent)) {
            fail(`instance ${child} parented to unknown instance ${parent}`);
        }
    }

    // Walk every instance to a root so parent cycles cannot hide subtrees
    // from tools that traverse top-down
    const reachesRoot = new Set<number>();
    for (const start of parentOf.keys()) {
        const trail = new Set<number>();
        let node = start;
        while (node !== -1 && !reachesRoot.has(node)) {
            if (trail.has(node)) fail('parent cycle detected');
            trail.add(node);
            node = parentOf.get(node)!;
        }
        for (const seen of trail) reachesRoot.add(seen);
    }

    return { instanceCount: totalInstances, rootCount, classes };
}

// --- forest policy -----------------------------------------------------------

/**
 * Forest's rules for a model file that has already parsed cleanly. Returns
 * author-facing error messages; empty array means the file is acceptable.
 */
export function checkRbxmPolicy(scan: RbxmScan, fileName: string): string[] {
    const errors: string[] = [];

    const forbidden = scan.classes.filter(c => isForbiddenClassName(c.className));
    if (forbidden.length > 0) {
        const list = forbidden.map(c => `${c.className} x${c.count}`).join(', ');
        errors.push(
            `${fileName}: contains script instances (${list}). `
            + `Model files must be code-free; ship code as .luau files instead.`
        );
    }

    const services = scan.classes.filter(c => c.isService);
    if (services.length > 0) {
        const list = services.map(c => c.className).join(', ');
        errors.push(`${fileName}: contains service instances (${list}), which cannot ship in a model file.`);
    }

    if (scan.rootCount !== 1) {
        errors.push(
            `${fileName}: has ${scan.rootCount} root instances; a model file must contain exactly one `
            + `root instance so it maps predictably into consumer projects.`
        );
    }

    return errors;
}
