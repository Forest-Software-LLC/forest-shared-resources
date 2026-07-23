# forest-shared-resources

Shared **contracts and definitions** for the [forestpm](https://forest.dev) ecosystem. This is the single source of truth for anything that would otherwise be mirrored across forest-backend, forest-trust-gateway, and forest-cli.

## Structure

```
contracts/          Language-neutral JSON: the actual contracts.
                    Rust (forest-cli) consumes these directly.
  verse-rules.json           UEFN/Verse identifier rules + platform constants
  verse-rules.vectors.json   Canonical test vectors every consumer asserts
  licenses.json              SPDX allow-list, ratings + caveats, text fingerprints
  licenses.vectors.json      Rating + inference vectors

src/                TypeScript modules wrapping the contracts for TS/Node consumers.
  index.ts                   Aggregate entry
  verse/index.ts             Deep-importable as forest-shared-resources/verse
  licenses/index.ts          Deep-importable as forest-shared-resources/licenses

tests/              Vector assertions against the built output.
dist/               Build output (gitignored; created by the prepare script).
```

Authored in TypeScript with no committed build artifacts: the `prepare` script runs `tsc` automatically when npm installs this package as a git dependency, emitting to `dist/` (gitignored; only `dist/` and `contracts/` ship in the pack). The `exports` map serves runtime resolution and `typesVersions` serves consumers on classic node10 module resolution. If a consumer's build environment ever proves unable to run `prepare`, the fallback is committing the build output; note it here if that day comes.

## Charter: what belongs here (and what doesn't)

This repo exists to kill sync-comment duplication, **not** to become a grab-bag. Rules of admission:

1. **At least 2 consumer repos**, actually consuming it. Nothing lands here speculatively.
2. **Contract-shaped**: data, constants, schemas, validation rules with stable semantics. Things that change *deliberately* (with a version bump), not continuously.
3. **Data-first**: the source of truth is JSON wherever possible, so the Rust CLI can consume it. TS wrappers stay thin and dependency-free.
4. **Not allowed**: general utilities, app logic, anything one repo could reasonably own outright. Fast-evolving *logic* stays duplicated-with-vectors in its consumers; the velocity tax of a shared bump cycle costs more than small guarded duplication.

## Consuming

**TypeScript/Node** (forest-backend, forest-trust-gateway): npm git-dependency pinned to a tag. Public repo, so no auth anywhere (Docker/CI included):

```json
"forest-shared-resources": "github:Forest-Software-LLC/forest-shared-resources#v0.1.0"
```

```ts
import { mapScopeToVerseIdentifier, VERSE_RESERVED_WORDS } from 'forest-shared-resources/verse';
import { SPDX_LICENSES, inferLicenseFromText } from 'forest-shared-resources/licenses';
```

**Rust** (forest-cli): vendor the `contracts/*.json` files (copy or git submodule) + `include_str!`; re-implement any thin logic and assert the `*.vectors.json` in unit tests. The vectors are the cross-language drift guard.

## Current modules

### `verse`: UEFN/Verse rules

| Export | What |
|---|---|
| `VERSE_RESERVED_WORDS` | Verse keywords (lowercase). Package names matching one are rejected; new user/org slugs matching one are blocked at registration. |
| `mapScopeToVerseIdentifier(slug)` | Kebab scope slug to Verse identifier (`-` to `_`; `_` prefix for digit-led/reserved). Injective. |
| `validateUefnPackageName(name)` | Full-rejection validation (names are never auto-renamed). |
| `isReservedSlug(slug)` | Registration guard. |
| `EPIC_PATH_ROOTS` | Absolute Verse paths packages may reference; all else rejected at publish. |
| `PACKAGES_MOUNT` | `ForestPackages`: the canonical install mount and portability contract. |
| `RECEIPT_FILE_NAME` | `.forest-receipt`: forest-cli's install receipt; never in published tarballs. |

### `licenses`: license safety knowledge

| Export | What |
|---|---|
| `SPDX_LICENSES` | The allowed SPDX ids (CLI sends one of these or a `SEE LICENSE IN <file>` pointer). |
| `LICENSE_RATINGS` / `getStaticRating(id)` | safe/caution/unsafe ratings + user-facing caveats. Unknown ids rate `unknown`. |
| `inferLicenseFromText(text)` | Deterministic text-to-SPDX identification via the ordered fingerprint table in `contracts/licenses.json`. Data-driven, so forest-cli runs the same table instead of hand-mirroring `infer_license`. |

All copy shown to users must present ratings as automated review, not legal advice.

## Changing a contract

1. Edit the JSON (+ vectors if behavior changes); `npm test`.
2. Bump `version`, tag `vX.Y.Z`, push.
3. Bump the pinned tag in each consumer. **All consumers in the same change window**: version skew between deployed services is the failure mode that replaces source drift, so don't let pins diverge for long.

The Verse reserved-word list should be re-verified against the Verse grammar per major UEFN release. Over-inclusion is cheap (a publisher picks another name); a miss means an uninstallable package.
