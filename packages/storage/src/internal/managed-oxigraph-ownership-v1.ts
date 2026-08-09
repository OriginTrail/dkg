/**
 * The package's INTERNAL entry point for the managed-Oxigraph ownership
 * authority, published as `@origintrail-official/dkg-storage/internal/…` via
 * the `exports` map (#2165).
 *
 * This file exists so the exported `internal/` namespace is a physical module
 * boundary rather than a `package.json` alias onto a root `*-internal` file:
 * the next internal-only export gets a home under `src/internal/` instead of
 * inventing another alias. It deliberately contains nothing but the
 * re-export — the authority itself lives with its invariants in
 * `../managed-oxigraph-ownership-v1-internal.ts`.
 *
 * NOT covered by semver for external consumers. The one production consumer is
 * the CLI daemon supervisor; tests and the #2052 live gate import it to
 * exercise the authority deliberately.
 */
export * from '../managed-oxigraph-ownership-v1-internal.js';
