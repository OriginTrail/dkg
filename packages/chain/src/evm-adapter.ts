// SPDX-License-Identifier: Apache-2.0

/**
 * EVMChainAdapter — public entrypoint for the EVM chain adapter. This file was
 * split into focused sibling modules to stay within AI context windows:
 *   - evm-adapter-base.ts        shared state + constructor + plumbing
 *   - evm-adapter-{identity,publish,context-graph,conviction,ack-sign,
 *     random-sampling,storage-reads,events}.ts   per-domain method groups
 *   - evm-adapter-{abi,errors,rpc,allowance,types,constants}.ts  free helpers
 *
 * The class is assembled below from EVMChainAdapterBase + the holder mixins
 * (standard TS mixin pattern, identical to the DKGAgent split). The public
 * API — every symbol previously exported here — is preserved: class members
 * are unchanged externally, and the module-local helpers/types are re-exported.
 */

import type { ChainAdapter } from './chain-adapter.js';
import { applyMixins } from './evm-adapter-apply-mixins.js';
import { EVMChainAdapterBase } from './evm-adapter-base.js';
import { IdentityMethods } from './evm-adapter-identity.js';
import { PublishMethods } from './evm-adapter-publish.js';
import { ContextGraphMethods } from './evm-adapter-context-graph.js';
import { ConvictionMethods } from './evm-adapter-conviction.js';
import { AckSignMethods } from './evm-adapter-ack-sign.js';
import { RandomSamplingMethods } from './evm-adapter-random-sampling.js';
import { StorageReadMethods } from './evm-adapter-storage-reads.js';
import { EventsMethods } from './evm-adapter-events.js';

// --- Re-exports preserving the previously module-local public API. ---
export {
  decodeEvmError,
  enrichEvmError,
  isTooLowAllowanceError,
  isInsufficientFundsError,
  InsufficientPublisherFundsError,
  isNoFundedPublisherWalletError,
  NO_FUNDED_PUBLISHER_WALLET_CODE,
  formatNoFundedPublisherWalletMessage,
  PCA_COVERAGE_UNSUPPORTED_CODE,
  CONTEXT_GRAPH_FACADE_VERSION_UNKNOWN_CODE,
  CONTEXT_GRAPH_REGISTRATION_SIGNER_UNAVAILABLE_CODE,
  CONTEXT_GRAPH_REGISTRATION_COVERAGE_SIGNER_UNAVAILABLE_CODE,
  STALE_HUB_BINDING_CODE,
  PcaCoverageUnsupportedError,
  ContextGraphFacadeVersionUnknownError,
  ContextGraphRegistrationSignerUnavailableError,
  ContextGraphRegistrationCoverageSignerUnavailableError,
  type PublisherWalletBalance,
} from './evm-adapter-errors.js';
export {
  resolveRpcUrls,
  isRetryableRpcError,
  isKnownTransactionError,
} from './evm-adapter-rpc.js';
export {
  computeApprovalAction,
  effectivePublishAllowance,
  V10_PUBLISH_ONCHAIN_MIN_ALLOWANCE,
} from './evm-adapter-allowance.js';
export type { EVMAdapterConfig } from './evm-adapter-types.js';
/**
 * EVM chain adapter implementing the V9 ChainAdapter interface.
 * Resolves contract addresses dynamically from the Hub.
 */
export class EVMChainAdapter extends EVMChainAdapterBase implements ChainAdapter {}
type PublicConvictionMethods = Pick<ConvictionMethods, keyof ConvictionMethods>;
export interface EVMChainAdapter extends IdentityMethods, PublishMethods, ContextGraphMethods, PublicConvictionMethods, AckSignMethods, RandomSamplingMethods, StorageReadMethods, EventsMethods {}
applyMixins(EVMChainAdapter, [IdentityMethods, PublishMethods, ContextGraphMethods, ConvictionMethods, AckSignMethods, RandomSamplingMethods, StorageReadMethods, EventsMethods]);
