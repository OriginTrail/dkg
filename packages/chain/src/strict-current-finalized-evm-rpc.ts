/**
 * Public one-shot strict current-finalized RPC surface.
 *
 * Transport orchestration and shared snapshot internals intentionally live in
 * `strict-current-finalized-evm-transport.ts`; this module exposes only the
 * supported one-shot factories, configuration, and read model.
 */
export {
  CURRENT_FINALIZED_EVM_BLOCK_REFERENCE_PROFILES_V1,
  createStrictCurrentFinalizedEvmChainAdapterV1,
  createStrictCurrentFinalizedEvmReadV1,
  type CurrentFinalizedEvmBlockReferenceProfileV1,
  type StrictCurrentFinalizedEvmRpcConfigV1,
} from './strict-current-finalized-evm-transport.js';

export type {
  StrictCurrentFinalizedEvmReadCallV1,
  StrictCurrentFinalizedEvmReadRequestV1,
  StrictCurrentFinalizedEvmReadResultV1,
  StrictCurrentFinalizedEvmReadV1,
} from './current-finalized-evm-read-model.js';
