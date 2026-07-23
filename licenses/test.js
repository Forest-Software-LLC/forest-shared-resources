const test = require('node:test');
const assert = require('node:assert/strict');
const {
    SPDX_LICENSES,
    LICENSE_RATINGS,
    getStaticRating,
    inferLicenseFromText,
} = require('./index.js');
const vectors = require('../contracts/licenses.vectors.json');

test('every allowed SPDX id has a ratings entry', () => {
    for (const id of SPDX_LICENSES) {
        assert.ok(LICENSE_RATINGS[id], `missing rating for ${id}`);
    }
});

test('every rated id is in the allow-list (no orphan ratings)', () => {
    for (const id of Object.keys(LICENSE_RATINGS)) {
        assert.ok(SPDX_LICENSES.includes(id), `orphan rating: ${id}`);
    }
});

test('rating lookup vectors', () => {
    for (const [id, expected] of vectors.ratingLookups) {
        assert.equal(getStaticRating(id).rating, expected, id);
    }
});

test('unknown ids carry no caveats', () => {
    assert.deepEqual(getStaticRating('NotARealLicense').caveats, []);
});

test('text inference vectors (order-sensitive)', () => {
    for (const [text, expected] of vectors.inference) {
        assert.equal(inferLicenseFromText(text), expected, JSON.stringify(text.slice(0, 60)));
    }
});
