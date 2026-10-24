import type {
  BlockNumberV1,
  ChainIdV1,
  Digest32V1,
} from '@origintrail-official/dkg-core';

import type { FinalizedChainReadOwnerV1 } from './finalized-chain-read-admission.js';

export const CURRENT_FINALIZED_EVM_BLOCK_REFERENCE_PROFILES_V1 = Object.freeze([
  'eip1898',
  'trusted-block-number-hash-sandwich',
] as const);

export type CurrentFinalizedEvmBlockReferenceProfileV1 =
  (typeof CURRENT_FINALIZED_EVM_BLOCK_REFERENCE_PROFILES_V1)[number];

export interface StrictCurrentFinalizedEvmRpcConfigV1 {
  /** Canonical decimal chain ID permanently bound to this adapter. */
  readonly chainId: ChainIdV1;
  /** Trusted local configuration, in canonical failover order. */
  readonly endpoints: readonly string[];
  /**
   * EIP-1898 is the default. The number/hash sandwich is an explicit trusted
   * chain profile for deployments whose RPC endpoints cannot execute EIP-1898.
   */
  readonly blockReferenceProfile?: CurrentFinalizedEvmBlockReferenceProfileV1;
  /**
   * `chain.finalityConfirmations` — the node's SINGLE definition of finality.
   * Confirmation 1 (the default) anchors at the current head; a larger value
   * anchors at `head - confirmations + 1`. Omitted means 1, which keeps this
   * PUBLISHED factory's existing `{ chainId, endpoints }` signature valid.
   *
   * These transports are named "strict current finalized" and the strictness is
   * real — but it is the strictness of the ANCHOR DISCIPLINE (one endpoint, one
   * pinned anchor, EIP-1898 or a hash sandwich, fail closed on any drift), not a
   * second, deeper notion of finality. An operator who wants a deep precommit
   * anchor sets a deep `chain.finalityConfirmations` and gets it everywhere.
   */
  readonly finalityConfirmations?: number;
}

/** Validated session: the runtime can attempt exactly one or two endpoints. */
export type StrictFinalizedEndpointSessionV1 = readonly [string] | readonly [string, string];

export interface StrictRpcConfigSnapshotV1 {
  readonly chainId: ChainIdV1;
  readonly endpoints: StrictFinalizedEndpointSessionV1;
  readonly blockReferenceProfile: CurrentFinalizedEvmBlockReferenceProfileV1;
  /** Normalized by `resolveFinalityConfirmations`; >= 1, default 1. */
  readonly finalityConfirmations: number;
}

/**
 * Snapshot callers MAY declare an owner; omitting it means `foreground`.
 *
 * This factory is published API, so the field is optional — see the rationale in
 * `snapshotStrictFinalizedSnapshotConfigV1`. Callers that matter for fairness
 * and for the `owner` metric dimension (RFC64, W2) pass it explicitly and must
 * never rely on the default.
 */
export interface StrictFinalizedSnapshotRpcConfigV1
  extends StrictCurrentFinalizedEvmRpcConfigV1 {
  readonly owner?: FinalizedChainReadOwnerV1;
}

export interface StrictFinalizedSnapshotConfigSnapshotV1 extends StrictRpcConfigSnapshotV1 {
  readonly owner: FinalizedChainReadOwnerV1;
}

export interface FinalizedAnchorV1 {
  readonly blockNumber: BlockNumberV1;
  readonly blockNumberQuantity: string;
  readonly blockHash: Digest32V1;
}

export interface DeadlineScopeV1 {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly close: () => void;
}
