import type { ConfirmedCatalogObligationRecoveryV1, ConfirmedCatalogTransactionEvidenceV1 } from '@origintrail-official/dkg-agent';
import type { KnowledgeAssetLifecycleError } from './api-client.js';

type JsonTransactionScalarV1<Value> = Value extends bigint ? string : Value;

/** The daemon serializes bigint transaction identity fields as decimal strings. */
export type ConfirmedCatalogTransactionResponseV1 = {
  readonly [Key in keyof ConfirmedCatalogTransactionEvidenceV1]:
    JsonTransactionScalarV1<ConfirmedCatalogTransactionEvidenceV1[Key]>;
};

export interface ConfirmedCatalogObligationPendingResponseV1 {
  readonly code: 'CONFIRMED_CATALOG_OBLIGATION_PENDING';
  readonly status: 'confirmed';
  readonly catalogObligationPending: true;
  readonly error: string;
  readonly ual: string;
  readonly authorAddress: string;
  readonly merkleRoot: string;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly confirmedTransaction: ConfirmedCatalogTransactionResponseV1;
  readonly recovery: Readonly<ConfirmedCatalogObligationRecoveryV1>;
  readonly retryAction: 'observe_confirmed_catalog_obligation';
  readonly retryUrl: string;
}

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
