const test = require('node:test');
const assert = require('node:assert/strict');
const {
    UEFN_NAME_REGEX,
    validateUefnPackageName,
    mapScopeToVerseIdentifier,
    isReservedSlug,
} = require('../dist/src/verse/index.js');
const vectors = require('../contracts/verse-rules.vectors.json');

test('scope mapping vectors', () => {
    for (const [input, expected] of vectors.scopeMapping) {
        assert.equal(mapScopeToVerseIdentifier(input), expected, input);
    }
});

test('mapping always yields a valid identifier', () => {
    for (const [input] of vectors.scopeMapping) {
        assert.match(mapScopeToVerseIdentifier(input), UEFN_NAME_REGEX, input);
    }
});

test('valid package names', () => {
    for (const name of vectors.validPackageNames) {
        assert.equal(validateUefnPackageName(name), null, name);
    }
});

test('invalid package names', () => {
    for (const name of vectors.invalidPackageNames) {
        assert.notEqual(validateUefnPackageName(name), null, JSON.stringify(name));
    }
});

test('reserved package names', () => {
    for (const name of vectors.reservedPackageNames) {
        const error = validateUefnPackageName(name);
        assert.ok(error !== null && /reserved word/.test(error), name);
        assert.equal(isReservedSlug(name), true, name);
    }
});
