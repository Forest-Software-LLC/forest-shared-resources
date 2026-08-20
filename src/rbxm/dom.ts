/*
    forest-shared-resources / rbxm / dom

    Tolerant DOM parser for rbxm files: full instance tree with names and
    decoded properties, for read paths (tree views, model rendering, asset
    reference audits). Unknown chunk types are skipped and unknown property
    types are recorded as unsupported instead of failing, because this
    parser also reads files that predate publish validation. Structural
    damage (truncation, bad counts, undecodable compression) still throws
    RbxmParseError.

    Property decoders cover the types needed for tree rendering, part
    geometry, and string audits. Format reference: dom.rojo.space/binary.
*/

import {
    Reader,
    fail,
    toBuffer,
    readFileHeader,
    readChunkHeader,
    decompressChunk,
    readReferentArray,
    readInterleavedU32,
    readInterleavedI32,
    readInterleavedI64,
    readInterleavedF32,
    END_CONTENT,
} from './binary';
import contract from '../../contracts/rbxm-rules.json';

const limits = contract.rbxm.limits;

export type RbxmValue =
    | { type: 'string'; value: string }
    | { type: 'bool'; value: boolean }
    | { type: 'int'; value: number }
    | { type: 'float'; value: number }
    | { type: 'vector2'; value: { x: number; y: number } }
    | { type: 'vector3'; value: { x: number; y: number; z: number } }
    | { type: 'color3'; value: { r: number; g: number; b: number } }
    | { type: 'brickColor'; value: number }
    | { type: 'enum'; value: number }
    | { type: 'udim'; value: { scale: number; offset: number } }
    | { type: 'udim2'; value: { x: { scale: number; offset: number }; y: { scale: number; offset: number } } }
    | { type: 'cframe'; value: { position: { x: number; y: number; z: number }; rotation: number[] } }
    | { type: 'ref'; value: number }
    | { type: 'sharedString'; value: { index: number } }
    | { type: 'unsupported'; typeId: number };

export interface RbxmDomInstance {
    referent: number;
    className: string;
    isService: boolean;
    name: string;
    properties: Record<string, RbxmValue>;
    children: RbxmDomInstance[];
}

export interface RbxmDom {
    roots: RbxmDomInstance[];
    instanceCount: number;
}

// Rotation shorthand: id - 1 encodes the X and Y column normals
// (6 * xNormal + yNormal), Z is their cross product. Normals 0..5 are
// +X +Y +Z -X -Y -Z. Matrix is row-major R00..R22 with basis vectors as
// columns.
const NORMALS = [
    [1, 0, 0], [0, 1, 0], [0, 0, 1],
    [-1, 0, 0], [0, -1, 0], [0, 0, -1],
];

function rotationFromId(id: number): number[] {
    const n = id - 1;
    const x = NORMALS[Math.floor(n / 6)];
    const y = NORMALS[n % 6];
    if (x === undefined || y === undefined) fail(`invalid CFrame rotation id ${id}`);
    const z = [
        x[1] * y[2] - x[2] * y[1],
        x[2] * y[0] - x[0] * y[2],
        x[0] * y[1] - x[1] * y[0],
    ];
    return [
        x[0], y[0], z[0],
        x[1], y[1], z[1],
        x[2], y[2], z[2],
    ];
}

type PropertyColumn = { name: string; values: RbxmValue[] | { type: 'unsupported'; typeId: number } };

// Decodes one PROP chunk body (already past classId/name/typeId) into one
// value per instance of the class. Returns null for types this parser does
// not decode.
function decodeValues(body: Reader, typeId: number, count: number): RbxmValue[] | null {
    switch (typeId) {
        case 0x01: { // String
            const out: RbxmValue[] = new Array(count);
            for (let i = 0; i < count; i++) {
                out[i] = { type: 'string', value: body.string(limits.maxChunkDecompressedBytes) };
            }
            return out;
        }
        case 0x02: { // Bool
            const raw = body.bytes(count);
            return [...raw].map(b => ({ type: 'bool', value: b !== 0 } as RbxmValue));
        }
        case 0x03: // Int32
            return readInterleavedI32(body, count).map(v => ({ type: 'int', value: v }));
        case 0x04: // Float32
            return readInterleavedF32(body, count).map(v => ({ type: 'float', value: v }));
        case 0x05: { // Float64, sequential little-endian
            const out: RbxmValue[] = new Array(count);
            for (let i = 0; i < count; i++) out[i] = { type: 'float', value: body.f64() };
            return out;
        }
        case 0x06: { // UDim
            const scale = readInterleavedF32(body, count);
            const offset = readInterleavedI32(body, count);
            return scale.map((s, i) => ({ type: 'udim', value: { scale: s, offset: offset[i] } }));
        }
        case 0x07: { // UDim2
            const sx = readInterleavedF32(body, count);
            const sy = readInterleavedF32(body, count);
            const ox = readInterleavedI32(body, count);
            const oy = readInterleavedI32(body, count);
            return sx.map((s, i) => ({
                type: 'udim2',
                value: { x: { scale: s, offset: ox[i] }, y: { scale: sy[i], offset: oy[i] } },
            }));
        }
        case 0x0b: // BrickColor
            return readInterleavedU32(body, count).map(v => ({ type: 'brickColor', value: v }));
        case 0x0c: { // Color3
            const r = readInterleavedF32(body, count);
            const g = readInterleavedF32(body, count);
            const b = readInterleavedF32(body, count);
            return r.map((v, i) => ({ type: 'color3', value: { r: v, g: g[i], b: b[i] } }));
        }
        case 0x0d: { // Vector2
            const x = readInterleavedF32(body, count);
            const y = readInterleavedF32(body, count);
            return x.map((v, i) => ({ type: 'vector2', value: { x: v, y: y[i] } }));
        }
        case 0x0e: { // Vector3
            const x = readInterleavedF32(body, count);
            const y = readInterleavedF32(body, count);
            const z = readInterleavedF32(body, count);
            return x.map((v, i) => ({ type: 'vector3', value: { x: v, y: y[i], z: z[i] } }));
        }
        case 0x10: { // CFrame
            const rotations: number[][] = new Array(count);
            for (let i = 0; i < count; i++) {
                const id = body.u8();
                if (id === 0) {
                    const m: number[] = new Array(9);
                    for (let c = 0; c < 9; c++) m[c] = body.f32();
                    rotations[i] = m;
                } else {
                    rotations[i] = rotationFromId(id);
                }
            }
            const x = readInterleavedF32(body, count);
            const y = readInterleavedF32(body, count);
            const z = readInterleavedF32(body, count);
            return rotations.map((rot, i) => ({
                type: 'cframe',
                value: { position: { x: x[i], y: y[i], z: z[i] }, rotation: rot },
            }));
        }
        case 0x12: // Enum
            return readInterleavedU32(body, count).map(v => ({ type: 'enum', value: v }));
        case 0x13: // Ref
            return readReferentArray(body, count).map(v => ({ type: 'ref', value: v }));
        case 0x1a: { // Color3uint8
            const r = body.bytes(count);
            const g = body.bytes(count);
            const b = body.bytes(count);
            const out: RbxmValue[] = new Array(count);
            for (let i = 0; i < count; i++) {
                out[i] = { type: 'color3', value: { r: r[i] / 255, g: g[i] / 255, b: b[i] / 255 } };
            }
            return out;
        }
        case 0x1b: // Int64
            return readInterleavedI64(body, count).map(v => ({ type: 'int', value: v }));
        case 0x1c: // SharedString reference
            return readInterleavedU32(body, count).map(v => ({ type: 'sharedString', value: { index: v } }));
        default:
            return null;
    }
}

export function parseRbxmDom(data: Uint8Array): RbxmDom {
    const reader = new Reader(toBuffer(data));
    const { declaredClassCount, declaredInstanceCount } = readFileHeader(reader);

    if (declaredClassCount < 0 || declaredClassCount > limits.maxClasses) {
        fail(`class count ${declaredClassCount} outside allowed range`);
    }
    if (declaredInstanceCount < 0 || declaredInstanceCount > limits.maxInstances) {
        fail(`instance count ${declaredInstanceCount} outside allowed range`);
    }

    interface ClassRecord {
        className: string;
        isService: boolean;
        referents: number[];
        properties: PropertyColumn[];
    }
    const classById = new Map<number, ClassRecord>();
    const parentLinks: { child: number; parent: number }[] = [];
    let totalDecompressed = 0;
    let sawEnd = false;

    while (!sawEnd) {
        if (reader.remaining === 0) fail('missing END chunk');
        const header = readChunkHeader(reader);
        if (header.uncompressedLength > limits.maxChunkDecompressedBytes) {
            fail(`${header.name} chunk declares ${header.uncompressedLength} bytes, over the per-chunk limit`);
        }
        const payloadLength = header.compressedLength === 0 ? header.uncompressedLength : header.compressedLength;
        const payload = reader.bytes(payloadLength);

        if (header.name === 'END') {
            if (header.compressedLength !== 0 || !payload.equals(END_CONTENT)) fail('malformed END chunk');
            sawEnd = true;
            continue;
        }
        if (header.name !== 'INST' && header.name !== 'PROP' && header.name !== 'PRNT') {
            continue; // META, SSTR, unknown: tolerated on the read path
        }

        totalDecompressed += header.uncompressedLength;
        if (totalDecompressed > limits.maxTotalDecompressedBytes) {
            fail('total decompressed size exceeds limit');
        }
        const body = new Reader(decompressChunk(header, payload));

        if (header.name === 'INST') {
            const classId = body.u32();
            if (classById.has(classId)) fail(`duplicate INST chunk for class id ${classId}`);
            const className = body.string(limits.maxClassNameLength);
            const objectFormat = body.u8();
            if (objectFormat !== 0 && objectFormat !== 1) fail(`INST ${className}: unknown object format ${objectFormat}`);
            const count = body.u32();
            if (count > limits.maxInstances) fail(`INST ${className}: instance count over limit`);
            const referents = readReferentArray(body, count);
            classById.set(classId, { className, isService: objectFormat === 1, referents, properties: [] });
        } else if (header.name === 'PROP') {
            const classId = body.u32();
            const record = classById.get(classId);
            if (record === undefined) fail(`PROP chunk for unknown class id ${classId}`);
            const propName = body.string(limits.maxClassNameLength);
            const typeId = body.u8();
            const values = decodeValues(body, typeId, record.referents.length);
            record.properties.push({
                name: propName,
                values: values ?? { type: 'unsupported', typeId },
            });
        } else {
            const prntVersion = body.u8();
            if (prntVersion !== 0) fail(`unsupported PRNT version ${prntVersion}`);
            const linkCount = body.u32();
            if (linkCount > limits.maxInstances) fail('PRNT link count over limit');
            const children = readReferentArray(body, linkCount);
            const parents = readReferentArray(body, linkCount);
            for (let i = 0; i < linkCount; i++) {
                parentLinks.push({ child: children[i], parent: parents[i] });
            }
        }
    }

    // Assemble instances
    const byReferent = new Map<number, RbxmDomInstance>();
    let instanceCount = 0;
    for (const record of classById.values()) {
        record.referents.forEach((referent, index) => {
            if (byReferent.has(referent)) fail(`duplicate instance referent ${referent}`);
            const properties: Record<string, RbxmValue> = {};
            for (const column of record.properties) {
                properties[column.name] = Array.isArray(column.values) ? column.values[index] : column.values;
            }
            const nameProp = properties['Name'];
            byReferent.set(referent, {
                referent,
                className: record.className,
                isService: record.isService,
                name: nameProp?.type === 'string' ? nameProp.value : '',
                properties,
                children: [],
            });
            instanceCount++;
        });
    }

    const roots: RbxmDomInstance[] = [];
    const parented = new Set<number>();
    for (const { child, parent } of parentLinks) {
        const node = byReferent.get(child);
        if (node === undefined) fail(`PRNT references unknown instance ${child}`);
        if (parented.has(child)) fail(`instance ${child} parented twice`);
        parented.add(child);
        if (parent === -1) {
            roots.push(node);
        } else {
            const parentNode = byReferent.get(parent);
            if (parentNode === undefined) fail(`instance ${child} parented to unknown instance ${parent}`);
            parentNode.children.push(node);
        }
    }
    // Instances missing from PRNT surface as roots rather than vanishing
    for (const [referent, node] of byReferent) {
        if (!parented.has(referent)) roots.push(node);
    }

    return { roots, instanceCount };
}

// --- asset reference audit ---------------------------------------------------

export interface RbxmAssetRef {
    assetId: number;
    property: string;
    className: string;
    instanceName: string;
}

const ASSET_ID_RE = /rbxassetid:\/\/(\d+)|roblox\.com\/asset\/?\?id=(\d+)/gi;

/** Every marketplace asset id referenced by a string property in the tree. */
export function collectAssetRefs(dom: RbxmDom): RbxmAssetRef[] {
    const refs: RbxmAssetRef[] = [];
    const walk = (node: RbxmDomInstance) => {
        for (const [property, value] of Object.entries(node.properties)) {
            if (value.type !== 'string') continue;
            for (const match of value.value.matchAll(ASSET_ID_RE)) {
                refs.push({
                    assetId: parseInt(match[1] ?? match[2], 10),
                    property,
                    className: node.className,
                    instanceName: node.name,
                });
            }
        }
        node.children.forEach(walk);
    };
    dom.roots.forEach(walk);
    return refs;
}
