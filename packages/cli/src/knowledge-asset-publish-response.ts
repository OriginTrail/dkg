import type { ConfirmedCatalogObligationRecoveryV1, ConfirmedCatalogTransactionEvidenceV1 } from '@origintrail-official/dkg-agent';
import type { KnowledgeAssetLifecycleError } from './api-client.js';

type JsonTransactionScalarV1<Value> = Value extends bigint ? string : Value;

/** The daemon serializes bigint transaction identity fields as decimal strings. */
export type ConfirmedCatalogTransactionResponseV1 = {
  readonly [Key in keyof ConfirmedCatalogTransactionEvidenceV1]:
    JsonTransactionScalarV1<ConfirmedCatalogTransactionEvidenceV1[Key]>;
};

interface ConfirmedCatalogObligationPendingBaseV1 {
  readonly code: 'CONFIRMED_CATALOG_OBLIGATION_PENDING';
  readonly status: 'confirmed';
  readonly catalogObligationPending: true;
  readonly error: string;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly confirmedTransaction: ConfirmedCatalogTransactionResponseV1;
}

/** An invalid historical seal retains confirmation without offering an unsafe automatic retry. */
export type ConfirmedCatalogObligationPendingResponseV1 = ConfirmedCatalogObligationPendingBaseV1 & ({
  readonly ual: string;
  readonly authorAddress: string;
  readonly merkleRoot: string;
  readonly recovery: Readonly<ConfirmedCatalogObligationRecoveryV1>;
  readonly retryAction: 'observe_confirmed_catalog_obligation';
  readonly retryUrl: string;
} | {
  readonly ual?: never;
  readonly authorAddress?: never;
  readonly merkleRoot?: never;
  readonly recovery?: never;
  readonly retryUrl?: never;
  readonly retryAction: 'repair_confirmed_catalog_evidence';
});

export type KnowledgeAssetPublishResponse = OrdinaryKnowledgeAssetPublishResponse | ConfirmedCatalogObligationPendingResponseV1;

export interface OrdinaryKnowledgeAssetPublishResponse {
  readonly catalogObligationPending?: false;
  readonly code?: string;
  kaId?: string;
  ual?: string;
  txHash?: string;
  status?: string;
  /** Core peers whose StorageACKs backed a confirmed VM publish. */
  storageAckPeerIds?: string[];
  error?: string;
  errors?: KnowledgeAssetLifecycleError[];
  contextGraphError?: unknown;
  [key: string]: unknown;
}

/** Compatibility helpers retain the pending discriminant and all recovery evidence. */
export type FinalizedAssertionPublishResponse = ConfirmedCatalogObligationPendingResponseV1 | {
    readonly catalogObligationPending?: false;

    kaId: string;
    status: 'tentative' | 'confirmed';
    assertionUri: string;
    authorAddress: string;
    merkleRoot: string;
    kas: Array<{ tokenId: string; rootEntity: string }>;
    txHash?: string;
    blockNumber?: number;
    storageAckPeerIds?: string[];
    contextGraphError?: string;
  };
