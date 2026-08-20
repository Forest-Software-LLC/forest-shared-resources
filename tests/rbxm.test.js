const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const {
    scanRbxm,
    checkRbxmPolicy,
    isForbiddenClassName,
    RbxmParseError,
} = require('../dist/src/rbxm/index.js');
const { decodeLz4Block, Lz4Error } = require('../dist/src/rbxm/lz4.js');
const vectors = require('../contracts/rbxm-rules.vectors.json');

/*
    Fixture builder. Writes rbxm files from the spec (dom.rojo.space/binary)
    rather than from any serializer, so the tests are an independent check on
    the parser. Uncompressed chunks are legal per spec (compressedLength 0),
    which keeps most fixtures compressor-free; lz4 and zstd paths get their
    own dedicated fixtures.
*/

const MAGIC = Buffer.concat([
    Buffer.from('<roblox!', 'ascii'),
    Buffer.from([0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a]),
]);

function u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    return b;
}

function i32(n) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(n);
    return b;
}

// delta -> zigzag -> byte interleave (big-endian per value)
function encodeReferents(values) {
    const deltas = values.map((v, i) => (i === 0 ? v : (v - values[i - 1]) | 0));
    const transformed = deltas.map((d) => ((d << 1) ^ (d >> 31)) >>> 0);
    const n = values.length;
    const out = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
        out[i] = (transformed[i] >>> 24) & 0xff;
        out[n + i] = (transformed[i] >>> 16) & 0xff;
        out[2 * n + i] = (transformed[i] >>> 8) & 0xff;
        out[3 * n + i] = transformed[i] & 0xff;
    }
    return out;
}

function chunk(name, body, { compress } = {}) {
    const nameBuf = Buffer.alloc(4);
    nameBuf.write(name, 'latin1');
    let payload = body;
    let compressedLength = 0;
    if (compress === 'lz4') {
        payload = lz4CompressLiterals(body);
        compressedLength = payload.length;
    } else if (compress === 'zstd') {
        payload = zlib.zstdCompressSync(body);
        compressedLength = payload.length;
    }
    return Buffer.concat([nameBuf, u32(compressedLength), u32(body.length), Buffer.alloc(4), payload]);
}

// A pure-literal sequence is a valid lz4 block
function lz4CompressLiterals(body) {
    const parts = [];
    let litLen = body.length;
    if (litLen < 15) {
        parts.push(Buffer.from([litLen << 4]));
    } else {
        parts.push(Buffer.from([0xf0]));
        let rest = litLen - 15;
        while (rest >= 255) {
            parts.push(Buffer.from([255]));
            rest -= 255;
        }
        parts.push(Buffer.from([rest]));
    }
    parts.push(body);
    return Buffer.concat(parts);
}

function instChunk({ classId, className, referents, isService = false, compress }) {
    const nameBuf = Buffer.from(className, 'utf8');
    const body = Buffer.concat([
        u32(classId),
        u32(nameBuf.length),
        nameBuf,
        Buffer.from([isService ? 1 : 0]),
        u32(referents.length),
        encodeReferents(referents),
        isService ? Buffer.alloc(referents.length, 1) : Buffer.alloc(0),
    ]);
    return chunk('INST', body, { compress });
}

function prntChunk(links, { compress } = {}) {
    const body = Buffer.concat([
        Buffer.from([0]),
        u32(links.length),
        encodeReferents(links.map(([child]) => child)),
        encodeReferents(links.map(([, parent]) => parent)),
    ]);
    return chunk('PRNT', body, { compress });
}

function endChunk() {
    return chunk('END\0', Buffer.from('</roblox>', 'ascii'));
}

function buildRbxm({ classCount, instanceCount, chunks }) {
    return Buffer.concat([MAGIC, Buffer.from([0, 0]), i32(classCount), i32(instanceCount), Buffer.alloc(8), ...chunks]);
}

// Folder root with two Part children, the canonical clean fixture
function cleanModel(compress) {
    return buildRbxm({
        classCount: 2,
        instanceCount: 3,
        chunks: [
            instChunk({ classId: 0, className: 'Folder', referents: [0], compress }),
            instChunk({ classId: 1, className: 'Part', referents: [1, 2], compress }),
            prntChunk([[0, -1], [1, 0], [2, 0]], { compress }),
            endChunk(),
        ],
    });
}

// --- clean parses ------------------------------------------------------------

test('clean model, uncompressed chunks', () => {
    const scan = scanRbxm(cleanModel(undefined));
    assert.equal(scan.instanceCount, 3);
    assert.equal(scan.rootCount, 1);
    assert.deepEqual(
        scan.classes.map((c) => [c.className, c.count, c.isService]),
        [['Folder', 1, false], ['Part', 2, false]],
    );
    assert.deepEqual(checkRbxmPolicy(scan, 'model.rbxm'), []);
});

test('clean model, lz4 chunks', () => {
    const scan = scanRbxm(cleanModel('lz4'));
    assert.equal(scan.instanceCount, 3);
    assert.equal(scan.rootCount, 1);
});

test('clean model, zstd chunks', (t) => {
    if (typeof zlib.zstdCompressSync !== 'function') {
        t.skip('node too old for zstdCompressSync');
        return;
    }
    const scan = scanRbxm(cleanModel('zstd'));
    assert.equal(scan.instanceCount, 3);
    assert.equal(scan.rootCount, 1);
});

test('negative referent deltas round-trip', () => {
    // Descending referents force negative deltas through the zigzag path
    const scan = scanRbxm(buildRbxm({
        classCount: 1,
        instanceCount: 3,
        chunks: [
            instChunk({ classId: 0, className: 'Folder', referents: [5, 2, 9] }),
            prntChunk([[5, -1], [2, 5], [9, 5]]),
            endChunk(),
        ],
    }));
    assert.equal(scan.instanceCount, 3);
    assert.equal(scan.rootCount, 1);
});

// --- policy ------------------------------------------------------------------

test('class policy vectors', () => {
    for (const [className, forbidden] of vectors.classPolicy) {
        assert.equal(isForbiddenClassName(className), forbidden, className);
    }
});

test('script instances are rejected by policy', () => {
    const scan = scanRbxm(buildRbxm({
        classCount: 2,
        instanceCount: 2,
        chunks: [
            instChunk({ classId: 0, className: 'Folder', referents: [0] }),
            instChunk({ classId: 1, className: 'ModuleScript', referents: [1] }),
            prntChunk([[0, -1], [1, 0]]),
            endChunk(),
        ],
    }));
    const errors = checkRbxmPolicy(scan, 'ui.rbxm');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /ModuleScript x1/);
    assert.match(errors[0], /code-free/);
});

test('multiple roots are rejected by policy', () => {
    const scan = scanRbxm(buildRbxm({
        classCount: 1,
        instanceCount: 2,
        chunks: [
            instChunk({ classId: 0, className: 'Part', referents: [0, 1] }),
            prntChunk([[0, -1], [1, -1]]),
            endChunk(),
        ],
    }));
    const errors = checkRbxmPolicy(scan, 'parts.rbxm');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /2 root instances/);
});

test('service instances are rejected by policy', () => {
    const scan = scanRbxm(buildRbxm({
        classCount: 1,
        instanceCount: 1,
        chunks: [
            instChunk({ classId: 0, className: 'Lighting', referents: [0], isService: true }),
            prntChunk([[0, -1]]),
            endChunk(),
        ],
    }));
    const errors = checkRbxmPolicy(scan, 'model.rbxm');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /service instances/);
});

// --- malformed input ---------------------------------------------------------

function assertRejects(buf, pattern) {
    assert.throws(() => scanRbxm(buf), (err) => {
        assert.ok(err instanceof RbxmParseError, `expected RbxmParseError, got ${err.constructor.name}: ${err.message}`);
        assert.match(err.message, pattern);
        return true;
    });
}

test('bad magic', () => {
    assertRejects(Buffer.from('not an rbxm file at all, clearly'), /bad magic/);
});

test('truncated header', () => {
    assertRejects(MAGIC, /unexpected end of data/);
});

test('missing END chunk', () => {
    const full = cleanModel(undefined);
    const withoutEnd = full.subarray(0, full.length - endChunk().length);
    assertRejects(withoutEnd, /missing END chunk/);
});

test('trailing bytes after END', () => {
    assertRejects(Buffer.concat([cleanModel(undefined), Buffer.from([1])]), /trailing bytes after END/);
});

test('unknown chunk type', () => {
    const buf = buildRbxm({
        classCount: 0,
        instanceCount: 0,
        chunks: [chunk('SIGN', Buffer.from('whatever')), endChunk()],
    });
    assertRejects(buf, /unknown chunk type "SIGN"/);
});

test('header class count mismatch', () => {
    const buf = buildRbxm({
        classCount: 5,
        instanceCount: 3,
        chunks: [
            instChunk({ classId: 0, className: 'Folder', referents: [0] }),
            instChunk({ classId: 1, className: 'Part', referents: [1, 2] }),
            prntChunk([[0, -1], [1, 0], [2, 0]]),
            endChunk(),
        ],
    });
    assertRejects(buf, /declares 5 classes/);
});

test('header instance count mismatch', () => {
    const buf = buildRbxm({
        classCount: 1,
        instanceCount: 7,
        chunks: [
            instChunk({ classId: 0, className: 'Folder', referents: [0] }),
            prntChunk([[0, -1]]),
            endChunk(),
        ],
    });
    assertRejects(buf, /declares 7 instances/);
});

test('duplicate referent across classes', () => {
    const buf = buildRbxm({
        classCount: 2,
        instanceCount: 2,
        chunks: [
            instChunk({ classId: 0, className: 'Folder', referents: [0] }),
            instChunk({ classId: 1, className: 'Part', referents: [0] }),
            prntChunk([[0, -1]]),
            endChunk(),
        ],
    });
    assertRejects(buf, /duplicate instance referent/);
});

test('instance missing from PRNT', () => {
    const buf = buildRbxm({
        classCount: 1,
        instanceCount: 2,
        chunks: [
            instChunk({ classId: 0, className: 'Part', referents: [0, 1] }),
            prntChunk([[0, -1]]),
            endChunk(),
        ],
    });
    assertRejects(buf, /2 instances but 1 parent links/);
});

test('parented to unknown instance', () => {
    const buf = buildRbxm({
        classCount: 1,
        instanceCount: 1,
        chunks: [
            instChunk({ classId: 0, className: 'Part', referents: [0] }),
            prntChunk([[0, 99]]),
            endChunk(),
        ],
    });
    assertRejects(buf, /parented to unknown instance 99/);
});

test('parent cycle', () => {
    const buf = buildRbxm({
        classCount: 1,
        instanceCount: 2,
        chunks: [
            instChunk({ classId: 0, className: 'Part', referents: [0, 1] }),
            prntChunk([[0, 1], [1, 0]]),
            endChunk(),
        ],
    });
    assertRejects(buf, /parent cycle/);
});

test('oversized chunk declaration is rejected before allocation', () => {
    const nameBuf = Buffer.from('INST', 'latin1');
    const huge = Buffer.concat([nameBuf, u32(4), u32(1024 * 1024 * 1024), Buffer.alloc(4), Buffer.alloc(4)]);
    const buf = buildRbxm({ classCount: 1, instanceCount: 1, chunks: [huge, endChunk()] });
    assertRejects(buf, /over the per-chunk limit/);
});

test('instance count over limit is rejected from the header', () => {
    const buf = Buffer.concat([MAGIC, Buffer.from([0, 0]), i32(1), i32(500000), Buffer.alloc(8)]);
    assertRejects(buf, /outside allowed range/);
});

// --- lz4 decoder -------------------------------------------------------------

test('lz4 match sequences decode, including overlapping copies', () => {
    // 4 literals then a match of length 8 at offset 4 repeats "abcd" twice
    const block = Buffer.concat([Buffer.from([0x44]), Buffer.from('abcd'), Buffer.from([0x04, 0x00])]);
    assert.equal(Buffer.from(decodeLz4Block(block, 12)).toString(), 'abcdabcdabcd');
    // offset 1 with match length 8 repeats a single byte, the classic overlap
    const overlap = Buffer.concat([Buffer.from([0x14]), Buffer.from('x'), Buffer.from([0x01, 0x00])]);
    assert.equal(Buffer.from(decodeLz4Block(overlap, 9)).toString(), 'xxxxxxxxx');
});

test('lz4 rejects malformed blocks', () => {
    assert.throws(() => decodeLz4Block(Buffer.from([0x44, 0x61]), 12), Lz4Error); // truncated literals
    assert.throws(() => decodeLz4Block(Buffer.from([0x14, 0x61, 0x05, 0x00]), 9), Lz4Error); // offset past start
    assert.throws(() => decodeLz4Block(Buffer.from([0x14, 0x61, 0x00, 0x00]), 9), Lz4Error); // zero offset
    assert.throws(() => decodeLz4Block(lz4CompressLiterals(Buffer.from('abc')), 99), Lz4Error); // size mismatch
});

test('long literal runs use the extension byte path', () => {
    const body = Buffer.alloc(300, 7);
    assert.deepEqual(Buffer.from(decodeLz4Block(lz4CompressLiterals(body), 300)), body);
});

// --- real serializer output --------------------------------------------------
// Committed fixtures from rojo-rbx/rbx-test-files (MIT): actual Studio and
// rbx-dom saves, so the parser is checked against real chunk layouts, real
// lz4 blocks, SSTR chunks, and attribute blobs, not just our own builder.

const fs = require('node:fs');
const path = require('node:path');
const FIXTURES = path.join(__dirname, 'fixtures', 'rbxm');

function loadFixture(name) {
    return fs.readFileSync(path.join(FIXTURES, name));
}

test('real fixtures parse and report the expected census', () => {
    const expectations = [
        ['default-inserted-folder.rbxm', { instances: 1, roots: 1, clean: true }],
        ['attributes.rbxm', { instances: 1, roots: 1, clean: true }],
        ['three-nested-folders.rbxm', { instances: 3, roots: 1, clean: true }],
        ['ref-parent.rbxm', { instances: 2, roots: 1, clean: true }],
        ['sharedstring.rbxm', { instances: 9, roots: 1, clean: true }],
    ];
    for (const [name, expected] of expectations) {
        const scan = scanRbxm(loadFixture(name));
        assert.equal(scan.instanceCount, expected.instances, name);
        assert.equal(scan.rootCount, expected.roots, name);
        assert.equal(checkRbxmPolicy(scan, name).length === 0, expected.clean, name);
    }
});

test('real ModuleScript save is caught by policy', () => {
    const scan = scanRbxm(loadFixture('default-inserted-modulescript.rbxm'));
    const errors = checkRbxmPolicy(scan, 'm.rbxm');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /ModuleScript x1/);
});

test('real multi-root saves are caught by policy', () => {
    for (const name of ['three-screengui.rbxm', 'two-particleemitters.rbxm', 'unions.rbxm']) {
        const scan = scanRbxm(loadFixture(name));
        const errors = checkRbxmPolicy(scan, name);
        assert.equal(errors.length, 1, name);
        assert.match(errors[0], /root instances/, name);
    }
});
