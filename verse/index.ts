/*
    forest-shared-resources / verse

    The single source of truth for UEFN (Verse) identifier rules and
    cross-repo platform constants shared by forest-backend,
    forest-trust-gateway, and (data-only) forest-cli.

    Authored in TypeScript; consumers install via npm git-dependency, which
    runs this package's `prepare` script (tsc) at install time. No committed
    build artifacts.

    Rust (forest-cli) consumes contracts/verse-rules.json directly (vendored
    copy or git submodule + include_str!) and re-implements the small mapping
    logic, asserted against contracts/verse-rules.vectors.json in its unit
    tests.
*/

import rules from '../contracts/verse-rules.json';

export { rules };

export const UEFN_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Verse keywords/primitive names, all lowercase. */
export const VERSE_RESERVED_WORDS: ReadonlySet<string> = new Set(rules.uefn.reservedWords);

/** Absolute Verse path roots that packages MAY reference (Epic APIs). */
export const EPIC_PATH_ROOTS: readonly string[] = Object.freeze([...rules.uefn.epicPathRoots]);

/** The canonical package mount folder inside Content/, i.e. the portability contract. */
export const PACKAGES_MOUNT: string = rules.uefn.packagesMount;

/** forest-cli's install-receipt filename; must never appear in published tarballs. */
export const RECEIPT_FILE_NAME: string = rules.uefn.receiptFileName;

/**
 * Package names are NEVER auto-renamed: anything that can't be a Verse
 * identifier as-typed is rejected at publish.
 * Returns an error message, or null when the name is valid.
 */
export function validateUefnPackageName(name: string): string | null {
    if (!UEFN_NAME_REGEX.test(name)) {
        return `Invalid package name "${name}" for UEFN. Names become Verse module identifiers: `
            + 'they must start with a letter or underscore and contain only letters, digits, and underscores (no hyphens).';
    }
    if (VERSE_RESERVED_WORDS.has(name)) {
        return `Invalid package name "${name}": it is a Verse reserved word.`;
    }
    return null;
}

/**
 * Map a kebab-case scope slug to a valid Verse identifier: '-' to '_', then
 * a '_' prefix when the result would start with a digit or be a reserved
 * word. Injective because kebab slugs can never contain underscores.
 */
export function mapScopeToVerseIdentifier(slug: string): string {
    let mapped = slug.replace(/-/g, '_');
    if (/^[0-9]/.test(mapped) || VERSE_RESERVED_WORDS.has(mapped)) {
        mapped = `_${mapped}`;
    }
    return mapped;
}

/**
 * Registration-time guard: new usernames/org slugs may not BE a Verse
 * reserved word (slugs are already lowercase).
 */
export function isReservedSlug(slug: string): boolean {
    return VERSE_RESERVED_WORDS.has(slug);
}
