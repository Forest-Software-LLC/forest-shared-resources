/*
    forest-shared-resources / rbxm

    Roblox package rules and the rbxm binary scanner, used by the forest
    registry's publish validation. Format reference: dom.rojo.space/binary.

    scanRbxm is the enforcement path: class census (INST) and parent
    structure (PRNT) only, property payloads length-skipped without
    decompression. Fail closed: unknown chunks, truncation, count
    mismatches, or undecodable compression reject the file.

    checkRbxmPolicy applies the registry rules (no script classes, no
    services, exactly one root instance). isRuntimeScriptName applies the
    filename rule from the shared contract. parseRbxmDom (dom.ts) is the
    tolerant read path for rendering.
*/

import {
    Reader,
    RbxmParseError,
    fail,
    toBuffer,
    readFileHeader,
    readChunkHeader,
    readReferentArray,
    decompressChunk,
    END_CONTENT,
} from './binary';
import contract from '../../contracts/rbxm-rules.json';

const rules = contract.rbxm;

export { RbxmParseError };
export { parseRbxmDom, collectAssetRefs } from './dom';
export type { RbxmDom, RbxmDomInstance, RbxmValue, RbxmAssetRef } from './dom';

export const MODEL_FILE_EXTENSIONS: readonly string[] = Object.freeze([...rules.modelFileExtensions]);
export const REJECTED_MODEL_EXTENSIONS: readonly string[] = Object.freeze([...rules.rejectedModelExtensions]);
export const FORBIDDEN_CLASS_NAME_SUFFIX: string = rules.forbiddenClassNameSuffix;
export const MIN_LUAU_SOURCE_BYTES_WITH_MODELS: number = rules.minLuauSourceBytesWithModels;
export const RBXM_LIMITS = Object.freeze({ ...rules.limits });
export const RUNTIME_SCRIPT_SUFFIXES: readonly string[] = Object.freeze([...contract.runtimeScripts.rejectedSuffixes]);

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

/**
 * Filename rule from the shared contract: Rojo-convention runtime-script
 * names. Case-insensitive; bare server.lua/client.lua exempt by
 * construction (the suffixes carry a leading dot). Pass a basename.
 */
export function isRuntimeScriptName(basename: string): boolean {
    const lower = basename.toLowerCase();
    return RUNTIME_SCRIPT_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

export function scanRbxm(data: Uint8Array): RbxmScan {
    const reader = new Reader(toBuffer(data));
    const { declaredClassCount, declaredInstanceCount } = readFileHeader(reader);

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
        const header = readChunkHeader(reader);

        if (header.uncompressedLength > rules.limits.maxChunkDecompressedBytes) {
            fail(`${header.name} chunk declares ${header.uncompressedLength} bytes, over the per-chunk limit`);
        }
        const payloadLength = header.compressedLength === 0 ? header.uncompressedLength : header.compressedLength;
        const payload = reader.bytes(payloadLength);

        switch (header.name) {
            case 'END': {
                if (header.compressedLength !== 0 || !payload.equals(END_CONTENT)) {
                    fail('malformed END chunk');
                }
                sawEnd = true;
                break;
            }
            case 'META':
            case 'SSTR':
            case 'PROP':
                // Length-skipped without decompression; contents not needed
                // for enforcement
                break;
            case 'INST': {
                totalDecompressed += header.uncompressedLength;
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
                totalDecompressed += header.uncompressedLength;
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

    // Walk every instance to a root; parent cycles must not hide subtrees
    // from top-down traversal
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
 * Registry rules for a cleanly parsed model file. Author-facing error
 * messages; empty means acceptable.
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
