// SPDX-License-Identifier: Apache-2.0

/**
 * Node-local ledger of the StorageACKs this core actually signed.
 *
 * The SWM copy an ACK persists is ordinary shared-memory metadata: other
 * nodes can sync it, gossip can choose any `shareOperationId`, and a copy
 * persisted for a request that was later declined looks identical. Retention
 * and the promotion audit therefore key on this ledger, written immediately
 * before the signature and never synced (the graph is outside every
 * `did:dkg:context-graph:` family the sync lanes serve).
 *
 * Subject: the share-operation IRI of the ACK copy
 * (`urn:dkg:share:<namespace>:storage-ack-<hash>`).
 */

import type { Quad } from '@origintrail-official/dkg-storage';

export const STORAGE_ACK_LEDGER_GRAPH = 'urn:dkg:node:storage-ack-ledger';

const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

export const STORAGE_ACK_LEDGER_PREDICATES = Object.freeze({
  /** When this core signed (or, for a pre-ledger copy, when it was stored). */
  signedAt: `${DKG}storageAckSignedAt`,
  /** SWM namespace holding the copy (the swmGraphId, or the numeric id). */
  namespace: `${DKG}storageAckNamespace`,
  /** SWM meta graph holding the share-operation rows. */
  metaGraph: `${DKG}storageAckMetaGraph`,
  /** Numeric on-chain Context Graph id the ACK was signed for. */
  contextGraphId: `${DKG}storageAckContextGraphId`,
  kaUal: `${DKG}kaUal`,
  assertionVersion: `${DKG}assertionVersion`,
  /** `publish` or `update`. */
  operation: `${DKG}storageAckOperation`,
  /** Set on copies stored before this node kept a ledger. */
  grandfathered: `${DKG}storageAckGrandfathered`,
  /** The audit saw the asset (version) registered on chain for this graph. */
  registeredAt: `${DKG}storageAckRegisteredAt`,
  /** First audit observation that the chain does not have the asset (version). */
  absentSeenAt: `${DKG}storageAckAbsentSeenAt`,
  /** Second, later absence observation past the SWM TTL: the copy may expire. */
  unregisteredAt: `${DKG}storageAckUnregisteredAt`,
  /** Node-local: when this node started keeping the ledger. */
  epoch: `${DKG}storageAckLedgerEpoch`,
});

export interface StorageAckLedgerEntry {
  readonly operationSubject: string;
  readonly namespace: string;
  readonly metaGraph: string;
  readonly contextGraphId: string;
  readonly kaUal: string;
  readonly assertionVersion: string | number | bigint;
  readonly operation: 'publish' | 'update';
  readonly signedAt: Date;
}

export function xsdDateTimeLiteral(date: Date): string {
  return `"${date.toISOString()}"^^<${XSD}dateTime>`;
}

function lit(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

/** The rows one signed ACK leaves in the ledger (replacing the subject's rows). */
export function storageAckLedgerEntryQuads(entry: StorageAckLedgerEntry): Quad[] {
  const graph = STORAGE_ACK_LEDGER_GRAPH;
  const p = STORAGE_ACK_LEDGER_PREDICATES;
  const subject = entry.operationSubject;
  return [
    { subject, predicate: p.signedAt, object: xsdDateTimeLiteral(entry.signedAt), graph },
    { subject, predicate: p.namespace, object: lit(entry.namespace), graph },
    { subject, predicate: p.metaGraph, object: entry.metaGraph, graph },
    { subject, predicate: p.contextGraphId, object: lit(entry.contextGraphId), graph },
    { subject, predicate: p.kaUal, object: entry.kaUal, graph },
    {
      subject,
      predicate: p.assertionVersion,
      object: `"${BigInt(entry.assertionVersion)}"^^<${XSD}integer>`,
      graph,
    },
    { subject, predicate: p.operation, object: lit(entry.operation), graph },
  ];
}
