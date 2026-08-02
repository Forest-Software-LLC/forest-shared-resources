const test = require('node:test');
const assert = require('node:assert/strict');
const {
    classifyUserAgent,
    CLI_UA_PREFIX,
    INTERNAL_UA_PREFIX,
    rules,
} = require('../dist/src/user-agents/index.js');
const vectors = require('../contracts/user-agents.vectors.json');

test('classification vectors', () => {
    for (const [ua, expected] of vectors.classifications) {
        assert.equal(classifyUserAgent(ua), expected, JSON.stringify(ua));
    }
});

test('every vector class is a declared class', () => {
    for (const [, expected] of vectors.classifications) {
        assert.ok(rules.classes.includes(expected), expected);
    }
});

test('exported prefix constants mirror the contract', () => {
    assert.equal(CLI_UA_PREFIX, rules.prefixes.cli);
    assert.equal(INTERNAL_UA_PREFIX, rules.prefixes.internal);
    // Trailing slash is what makes prefix matching version-proof.
    assert.ok(CLI_UA_PREFIX.endsWith('/'));
    assert.ok(INTERNAL_UA_PREFIX.endsWith('/'));
});
