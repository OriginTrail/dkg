// Compile-time proof that the strict finalized RPC public API — both values and
// types — is reachable through the package barrel `src/index.ts`. This runs via
// `pnpm --filter @origintrail-official/dkg-chain run test:types`, which is wired
// into `build`. vitest alone cannot protect the type re-exports: type-only
// imports and annotations are erased before runtime, so a Vitest assertion still
// passes after a type export is dropped. `tsc` over this file does not.
//
// Removing `type CurrentFinalizedEvmBlockReferenceProfileV1` or
// `type StrictCurrentFinalizedEvmRpcConfigV1`, or either value export, from
// `src/index.ts` makes this file fail to typecheck ("has no exported member").

import {
  CURRENT_FINALIZED_EVM_BLOCK_REFERENCE_PROFILES_V1,
  createStrictCurrentFinalizedEvmChainAdapterV1,
  type CurrentFinalizedEvmBlockReferenceProfileV1,
  type StrictCurrentFinalizedEvmRpcConfigV1,
} from '../src/index.js';

type IsTrue<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// The exported block-reference profile union must remain exactly the two
// supported profiles, reachable through the barrel.
export type ProfileExportIsCanonical = IsTrue<
  Equals<
    CurrentFinalizedEvmBlockReferenceProfileV1,
    'eip1898' | 'trusted-block-number-hash-sandwich'
  >
>;

// The exported config type must stay structurally usable by consumers.
export type ConfigExportCarriesEndpoints = IsTrue<
  StrictCurrentFinalizedEvmRpcConfigV1 extends { readonly endpoints: readonly string[] }
    ? true
    : false
>;

// The value re-exports must be present with their real implementation types.
export const strictAdapterFactoryExport: typeof createStrictCurrentFinalizedEvmChainAdapterV1 =
  createStrictCurrentFinalizedEvmChainAdapterV1;
export const blockReferenceProfilesExport: readonly CurrentFinalizedEvmBlockReferenceProfileV1[] =
  CURRENT_FINALIZED_EVM_BLOCK_REFERENCE_PROFILES_V1;
