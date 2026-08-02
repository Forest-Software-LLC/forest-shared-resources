/*
    forest-shared-resources / user-agents

    The single source of truth for User-Agent classification in registry
    usage analytics. forest-cli sends the cli prefix; forest-cdn-worker and
    forest-backend classify traffic with classifyUserAgent. The 'internal'
    class marks forest-backend's own server-side tarball fetches (Code tab),
    which the download rollup excludes from counts.

    Rust (forest-cli) consumes contracts/user-agents.json directly (vendored
    via the shared/ submodule + include_str!) and asserts its USER_AGENT
    constant starts with the cli prefix, checked against
    contracts/user-agents.vectors.json in its unit tests.
*/

import rules from '../../contracts/user-agents.json';

export { rules };

export type UaClass = 'cli' | 'browser' | 'internal' | 'other' | 'none';

/** Sent by forest-cli on every request: `forest-cli/<version>`. */
export const CLI_UA_PREFIX: string = rules.prefixes.cli;

/** Sent by forest-backend's own CDN fetches; excluded from download counts. */
export const INTERNAL_UA_PREFIX: string = rules.prefixes.internal;

/** Prefixes match at the start of the string; the browser token anywhere. */
export function classifyUserAgent(ua: string | null): UaClass {
    if (!ua) return 'none';
    if (ua.startsWith(rules.prefixes.cli)) return 'cli';
    if (ua.startsWith(rules.prefixes.internal)) return 'internal';
    if (ua.includes(rules.browserToken)) return 'browser';
    return 'other';
}
