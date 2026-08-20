const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    parseRbxmDom,
    collectAssetRefs,
    isRuntimeScriptName,
    RbxmParseError,
} = require('../dist/src/rbxm/index.js');
const vectors = require('../contracts/rbxm-rules.vectors.json');

const FIXTURES = path.join(__dirname, 'fixtures', 'rbxm');

function loadFixture(name) {
    return fs.readFileSync(path.join(FIXTURES, name));
}

/*
    Synthetic builder with PROP support, spec-written like the scanner
    builder in rbxm.test.js. Uncompressed chunks only.
*/
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

function chunk(name, body) {
    const nameBuf = Buffer.alloc(4);
    nameBuf.write(name, 'latin1');
    return Buffer.concat([nameBuf, u32(0), u32(body.length), Buffer.alloc(4), body]);
}

function bstr(s) {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([u32(b.length), b]);
}

function instChunk(classId, className, referents) {
    return chunk('INST', Buffer.concat([
        u32(classId), bstr(className), Buffer.from([0]), u32(referents.length), encodeReferents(referents),
    ]));
}

function stringPropChunk(classId, propName, values) {
    return chunk('PROP', Buffer.concat([u32(classId), bstr(propName), Buffer.from([0x01]), ...values.map(bstr)]));
}

function prntChunk(links) {
    return chunk('PRNT', Buffer.concat([
        Buffer.from([0]),
        u32(links.length),
        encodeReferents(links.map(([child]) => child)),
        encodeReferents(links.map(([, parent]) => parent)),
    ]));
}

function endChunk() {
    return chunk('END\0', Buffer.from('</roblox>', 'ascii'));
}

function buildRbxm(classCount, instanceCount, chunks) {
    return Buffer.concat([
        Buffer.from('<roblox!', 'ascii'),
        Buffer.from([0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
        i32(classCount), i32(instanceCount), Buffer.alloc(8),
        ...chunks,
    ]);
}

// --- real fixtures -----------------------------------------------------------

test('tree structure and names from a real nested save', () => {
    const dom = parseRbxmDom(loadFixture('three-nested-folders.rbxm'));
    assert.equal(dom.instanceCount, 3);
    assert.equal(dom.roots.length, 1);
    assert.equal(dom.roots[0].name, 'Grandparent');
    assert.equal(dom.roots[0].children[0].name, 'Parent');
    assert.equal(dom.roots[0].children[0].children[0].name, 'Child');
});

test('CFrame rotation ids match the XML ground truth', () => {
    const dom = parseRbxmDom(loadFixture('cframe-special-cases.rbxm'));
    const xml = fs.readFileSync(path.join(FIXTURES, 'cframe-special-cases.rbxmx'), 'utf8');
    const expected = new Map();
    const itemRe = /<string name="Name">([^<]+)<\/string>[\s\S]*?<CoordinateFrame name="Value">([\s\S]*?)<\/CoordinateFrame>/g;
    for (const m of xml.matchAll(itemRe)) {
        const comp = {};
        for (const c of m[2].matchAll(/<(\w+)>([^<]+)<\/\1>/g)) comp[c[1]] = parseFloat(c[2]);
        expected.set(m[1], ['R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'].map(k => comp[k]));
    }
    assert.equal(dom.roots.length, 24);
    for (const node of dom.roots) {
        const got = node.properties['Value'];
        const want = expected.get(node.name);
        assert.equal(got?.type, 'cframe', node.name);
        got.value.rotation.forEach((v, i) => {
            assert.ok(Math.abs(v - want[i]) < 1e-6, `${node.name}[${i}]: ${v} vs ${want[i]}`);
        });
    }
});

test('part geometry properties decode from a real save', () => {
    const dom = parseRbxmDom(loadFixture('three-unique-parts.rbxm'));
    for (const part of dom.roots) {
        assert.equal(part.className, 'Part');
        const size = part.properties['size'] ?? part.properties['Size'];
        assert.equal(size?.type, 'vector3', part.name);
        assert.ok(size.value.x > 0 && size.value.y > 0 && size.value.z > 0, part.name);
        const cf = part.properties['CFrame'];
        assert.equal(cf?.type, 'cframe', part.name);
        assert.equal(cf.value.rotation.length, 9);
    }
});

test('script Source is reachable through the DOM (read path only)', () => {
    const dom = parseRbxmDom(loadFixture('default-inserted-modulescript.rbxm'));
    const source = dom.roots[0].properties['Source'];
    assert.equal(source?.type, 'string');
    assert.match(source.value, /module/i);
});

test('unions with SharedString data parse without materializing blobs', () => {
    const dom = parseRbxmDom(loadFixture('sharedstring.rbxm'));
    assert.equal(dom.instanceCount, 9);
    const union = dom.roots[0].children[0];
    const shared = Object.values(union.properties).find(v => v.type === 'sharedString');
    assert.ok(shared, 'expected at least one sharedString property');
});

// --- synthetic ---------------------------------------------------------------

test('asset references are collected from string properties', () => {
    const buf = buildRbxm(1, 1, [
        instChunk(0, 'MeshPart', [0]),
        stringPropChunk(0, 'Name', ['Rock']),
        stringPropChunk(0, 'MeshId', ['rbxassetid://12345']),
        stringPropChunk(0, 'TextureID', ['http://www.roblox.com/asset/?id=678']),
        prntChunk([[0, -1]]),
        endChunk(),
    ]);
    const refs = collectAssetRefs(parseRbxmDom(buf));
    assert.deepEqual(
        refs.map(r => [r.assetId, r.property, r.instanceName]).sort((a, b) => a[0] - b[0]),
        [[678, 'TextureID', 'Rock'], [12345, 'MeshId', 'Rock']],
    );
});

test('unknown chunk types are tolerated on the read path', () => {
    const buf = buildRbxm(1, 1, [
        chunk('SIGN', Buffer.from('whatever')),
        instChunk(0, 'Folder', [0]),
        stringPropChunk(0, 'Name', ['F']),
        prntChunk([[0, -1]]),
        endChunk(),
    ]);
    const dom = parseRbxmDom(buf);
    assert.equal(dom.roots[0].name, 'F');
});

test('unknown property types are recorded as unsupported, not fatal', () => {
    const physProp = chunk('PROP', Buffer.concat([
        u32(0), bstr('CustomPhysicalProperties'), Buffer.from([0x19]), Buffer.from([0]),
    ]));
    const buf = buildRbxm(1, 1, [
        instChunk(0, 'Part', [0]),
        stringPropChunk(0, 'Name', ['P']),
        physProp,
        prntChunk([[0, -1]]),
        endChunk(),
    ]);
    const dom = parseRbxmDom(buf);
    assert.deepEqual(dom.roots[0].properties['CustomPhysicalProperties'], { type: 'unsupported', typeId: 0x19 });
});

test('instances missing from PRNT surface as roots', () => {
    const buf = buildRbxm(1, 2, [
        instChunk(0, 'Folder', [0, 1]),
        stringPropChunk(0, 'Name', ['A', 'B']),
        prntChunk([[0, -1]]),
        endChunk(),
    ]);
    const dom = parseRbxmDom(buf);
    assert.equal(dom.roots.length, 2);
});

test('structural damage still throws', () => {
    assert.throws(() => parseRbxmDom(Buffer.from('not a model')), RbxmParseError);
    const truncated = loadFixture('three-nested-folders.rbxm').subarray(0, 40);
    assert.throws(() => parseRbxmDom(truncated), RbxmParseError);
});

// --- runtime-script contract -------------------------------------------------

test('runtime-script name vectors', () => {
    for (const [basename, rejected] of vectors.runtimeScriptNames) {
        assert.equal(isRuntimeScriptName(basename), rejected, basename);
    }
});
