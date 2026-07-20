import type { Quad } from '@origintrail-official/dkg-storage';

/**
 * Runtime-only bridge from the existing publisher to the parallel WAL lane.
 * These objects are never encoded, hashed, signed, reconciled, or transferred;
 * the WAL package remains the sole owner of every durable binary format.
 */
export interface PublisherWalShadowSigner {
  readonly address: string;
  signMessage(message: Uint8Array): string | Uint8Array | Promise<string | Uint8Array>;
}

export type PublisherWalShadowMutationKind =
  | 'publish'
  | 'share'
  | 'update'
  | 'delete'
  | 'expiry';

export interface PublisherWalShadowChainBindingV1 {
  readonly chainId: bigint;
  readonly knowledgeAssetsContract: Uint8Array;
  readonly contextGraphOnChainId: Uint8Array;
  readonly kaId: Uint8Array;
  readonly authorAddress: Uint8Array;
  readonly assertionVersion: bigint;
  readonly merkleRoot: Uint8Array;
  readonly transactionHash: Uint8Array;
  readonly blockNumber: bigint;
  readonly blockHash: Uint8Array;
  readonly transactionIndex: bigint;
  readonly logIndex: bigint;
  readonly eventType: bigint;
  readonly requiredFinalityBlocks: bigint;
}

/** One exact mutation already accepted by the shared DKG semantic core. */
export interface PublisherWalShadowMutationV1 {
  readonly kind: PublisherWalShadowMutationKind;
  readonly operation: 'PUT' | 'PATCH' | 'DELETE';
  /** Replication-view visibility; omitted is the public compatibility default. */
  readonly visibility?: 'public' | 'private';
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  /** EVM address used in the author-scoped RDF logical-key coordinates. */
  readonly logicalAuthorAddress: string;
  /** UAL or root entity that completes the logical-key coordinates. */
  readonly logicalResource: string;
  /** Stable within the legacy API operation and unique per logical key. */
  readonly idempotencyKey: string;
  /** Exact state observed before the already-authorized semantic transition. */
  readonly baseQuads: readonly Quad[];
  /** Exact state observed after the successful semantic transition. */
  readonly resultQuads: readonly Quad[];
  /** The WAL author. It may differ from logicalAuthorAddress for shared keys. */
  readonly signer: PublisherWalShadowSigner;
  readonly chainBinding?: PublisherWalShadowChainBindingV1;
  readonly timestampMs?: number;
}

export interface PublisherWalShadowObjectReceiptV1 {
  readonly logicalResource: string;
  readonly walObjectId: string;
  readonly checkpointId: string;
  readonly walStatus: 'committed' | 'already-committed';
  readonly materializationStatus: 'pending' | 'materialized' | 'blocked';
  readonly nudgeStatus: 'sent' | 'failed' | 'not-configured';
  /** Global propagation is deliberately never inferred from a local commit. */
  readonly propagationStatus: 'not-claimed';
  readonly sequence: string;
  readonly objectCount: string;
  readonly objectSetRoot: string;
  readonly shadowError?: string;
  readonly nudgeError?: string;
}

export interface PublisherWalShadowWriter {
  write(mutation: PublisherWalShadowMutationV1): Promise<PublisherWalShadowObjectReceiptV1>;
}

export interface PublisherWalShadowFailureV1 {
  readonly logicalResource: string;
  readonly status: 'blocked';
  readonly shadowError: string;
}

export interface PublisherWalShadowBatchReceiptV1 {
  readonly mode: 'parallel';
  readonly status: 'committed' | 'partial' | 'blocked';
  readonly objects: readonly PublisherWalShadowObjectReceiptV1[];
  readonly failures: readonly PublisherWalShadowFailureV1[];
  readonly propagationStatus: 'not-claimed';
}
