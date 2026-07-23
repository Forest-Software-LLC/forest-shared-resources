/*
    forest-shared-resources / licenses

    License safety knowledge for the forestpm registry: the SPDX allow-list,
    static ratings + caveats, and the deterministic license-text fingerprint
    table. Source of truth is contracts/licenses.json; this module adds the
    small evaluators TS/Node consumers need.

    Rust (forest-cli) consumes contracts/licenses.json directly and runs the
    same data-driven fingerprint evaluation, asserted against
    contracts/licenses.vectors.json, replacing its hand-mirrored SPDX list
    and infer_license.

    All user-facing copy must present ratings as automated review, not
    legal advice.
*/

import data from '../../contracts/licenses.json';

export type LicenseRating = 'safe' | 'caution' | 'unsafe' | 'pending' | 'unknown';

export interface LicenseRatingEntry {
    rating: LicenseRating;
    caveats: string[];
}

export interface LicenseFingerprintRule {
    id: string;
    allOf?: string[];
    anyOf?: string[];
}

export { data };

/** Allowed SPDX ids (the CLI sends one of these or a "SEE LICENSE IN <file>" pointer). */
export const SPDX_LICENSES: readonly string[] = Object.freeze([...data.spdxLicenses]);

export const LICENSE_RATINGS = data.ratings as Record<string, LicenseRatingEntry>;

const FINGERPRINT_RULES = data.textFingerprints as LicenseFingerprintRule[];

/** Static rating for an SPDX id; unknown ids rate 'unknown' with no caveats. */
export function getStaticRating(spdxId: string): LicenseRatingEntry {
    return LICENSE_RATINGS[spdxId] || { rating: 'unknown', caveats: [] };
}

/**
 * Deterministic license-text identification via the ordered fingerprint
 * table: text is normalized (lowercase, whitespace runs collapsed), then the
 * first rule where every `allOf` substring is present AND (`anyOf` absent or
 * one present) wins. Returns the SPDX id, or null when unrecognized.
 */
export function inferLicenseFromText(text: string): string | null {
    const lc = text.toLowerCase().replace(/\s+/g, ' ');
    for (const rule of FINGERPRINT_RULES) {
        const allOk = !rule.allOf || rule.allOf.every((phrase) => lc.includes(phrase));
        if (!allOk) continue;
        const anyOk = !rule.anyOf || rule.anyOf.some((phrase) => lc.includes(phrase));
        if (anyOk) return rule.id;
    }
    return null;
}
