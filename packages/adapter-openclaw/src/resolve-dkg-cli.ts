/**
 * Backwards-compat re-export of `resolveDkgCli` from
 * `@origintrail-official/dkg-core`. The canonical implementation moved to
 * `packages/core/src/resolve-dkg-cli.ts` in S1 of issue #386 because
 * adapter-hermes also needs to spawn `dkg start` and the dependency
 * direction is `cli → adapters → core`.
 *
 * Existing in-tree consumers (notably `setup.ts` and the
 * `setup-start-daemon.test.ts` mock) import from this path; preserving the
 * re-export keeps their import sites and `vi.mock('../src/resolve-dkg-cli.js')`
 * targets stable.
 */

export { resolveDkgCli, type ResolvedDkgCli } from '@origintrail-official/dkg-core';
