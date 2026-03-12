import type { Quad } from '@dkg/storage';
import type { OnChainPublishResult } from '@dkg/chain';
import type { OperationContext } from '@dkg/core';

export interface KAManifestEntry {
  tokenId: bigint;
  rootEntity: string;
  privateMerkleRoot?: Uint8Array;
  privateTripleCount?: number;
}

export type PhaseCallback = (phase: string, status: 'start' | 'end') => void;

export type ReceiverSignature = { identityId: bigint; r: Uint8Array; vs: Uint8Array };

/**
 * Callback that collects receiver signatures from peers.
 * Called AFTER data preparation, BEFORE on-chain tx.
 */
export type ReceiverSignatureProvider = (
  merkleRoot: string,
  publicByteSize: bigint,
) => Promise<ReceiverSignature[]>;

/**
 * Callback that collects participant signatures for context graph governance.
 */
export type ParticipantSignatureProvider = (
  contextGraphId: bigint,
  merkleRoot: string,
) => Promise<ReceiverSignature[]>;

export interface PublishOptions {
  paranetId: string;
  quads: Quad[];
  privateQuads?: Quad[];
  /** Publisher peer ID used for KC ownership/access metadata. */
  publisherPeerId?: string;
  /** KC-level private access policy metadata. */
  accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  /** Allowed peer IDs when accessPolicy is allowList. */
  allowedPeers?: string[];
  manifest?: KAManifestEntry[];
  operationCtx?: OperationContext;
  /**
   * When true, triples are grouped by root entity and each group gets its
   * own `kaRoot`. The `kcMerkleRoot` is a Merkle tree over sorted `kaRoot`
   * values, enabling selective disclosure (prove one entity without
   * revealing others). Off by default — the flat hash is simpler and cheaper.
   */
  entityProofs?: boolean;
  /** Optional callback invoked at each phase boundary for instrumentation. */
  onPhase?: PhaseCallback;
  /** Override the data graph URI (used for context graph enshrinement). */
  targetGraphUri?: string;
  /** Override the meta graph URI (used for context graph enshrinement). */
  targetMetaGraphUri?: string;
  /**
   * If provided, publisher calls this to collect receiver signatures
   * from peers BEFORE the on-chain tx (replicate-then-publish).
   * If absent, falls back to self-signing (legacy behavior).
   */
  receiverSignatureProvider?: ReceiverSignatureProvider;
}

export interface PublishResult {
  kcId: bigint;
  /** The UAL assigned to this KC (tentative or confirmed). */
  ual: string;
  merkleRoot: Uint8Array;
  kaManifest: KAManifestEntry[];
  status: 'tentative' | 'confirmed' | 'failed';
  onChainResult?: OnChainPublishResult;
  /** Public quads that were stored (used for broadcast — never includes private triples). */
  publicQuads?: Quad[];
  /** Set when KC is confirmed on-chain but context-graph registration failed. */
  contextGraphError?: string;
}

export interface Publisher {
  publish(options: PublishOptions): Promise<PublishResult>;
  update(kcId: bigint, options: PublishOptions): Promise<PublishResult>;
  autoPartition(quads: Quad[]): KAManifestEntry[];
  skolemize(rootEntity: string, quads: Quad[]): Quad[];
}
