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

import { ethers } from 'ethers';
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
  /**
   * The chain moved past this copy (a later version landed, or this copy was
   * replaced before it landed): it can no longer be promoted as-is, so the
   * core no longer owes it and it may expire.
   */
  supersededAt: `${DKG}storageAckSupersededAt`,
  /** Sub-graph of the copy, when it is not in the namespace's root graph. */
  subGraphName: `${DKG}storageAckSubGraphName`,
  /** Node-local: when this node started keeping the ledger. */
  epoch: `${DKG}storageAckLedgerEpoch`,
  /** Node-local: copies stored before this instant are grandfathered. */
  grandfatheredThrough: `${DKG}storageAckGrandfatheredThrough`,
  /** Node-local: last time a ledger-keeping version of the node was running. */
  seenAt: `${DKG}storageAckLedgerSeenAt`,
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
  readonly subGraphName?: string;
}

/**
 * The share-operation id of the ACK copy for (UAL, version, Merkle root): the
 * same id for the same content, whichever request stored it.
 */
export function storageAckOperationId(
  kaUal: string,
  assertionVersion: string | number | bigint,
  merkleRoot: Uint8Array | string,
): string {
  const root = typeof merkleRoot === 'string' ? merkleRoot.toLowerCase() : ethers.hexlify(merkleRoot);
  return `storage-ack-${ethers.keccak256(ethers.toUtf8Bytes([
    kaUal,
    String(assertionVersion),
    root,
  ].join('\0'))).slice(2)}`;
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
    ...(entry.subGraphName
      ? [{ subject, predicate: p.subGraphName, object: lit(entry.subGraphName), graph }]
      : []),
  ];
}

function ntriple(quad: Quad): string {
  const object = quad.object.startsWith('"') ? quad.object : `<${quad.object}>`;
  return `<${quad.subject}> <${quad.predicate}> ${object} .`;
}

/**
 * One atomic SPARQL update that (re)records a signed ACK: it replaces every
 * row of the operation except `registeredAt`, so there is no window without a
 * ledger row. `registeredAt` alone survives a re-sign because it is chain
 * evidence the audit gathered (the copy's version landed), and retention keeps
 * a registered copy past the ceiling until it is promoted; clearing it would
 * put a landed copy back under the ceiling.
 */
export function storageAckLedgerRecordUpdate(entry: StorageAckLedgerEntry): string {
  const graph = STORAGE_ACK_LEDGER_GRAPH;
  const inserts = storageAckLedgerEntryQuads(entry).map(ntriple).join('\n      ');
  return `DELETE { GRAPH <${graph}> { <${entry.operationSubject}> ?p ?o } }
  INSERT { GRAPH <${graph}> {
      ${inserts}
  } }
  WHERE { OPTIONAL { GRAPH <${graph}> {
    <${entry.operationSubject}> ?p ?o .
    FILTER(?p != <${STORAGE_ACK_LEDGER_PREDICATES.registeredAt}>)
  } } }`;
}

/** One atomic update that sets a single timestamp predicate of a ledger row. */
export function storageAckLedgerMarkUpdate(operationSubject: string, predicate: string, at: Date): string {
  const graph = STORAGE_ACK_LEDGER_GRAPH;
  return `DELETE { GRAPH <${graph}> { <${operationSubject}> <${predicate}> ?old } }
  INSERT { GRAPH <${graph}> { <${operationSubject}> <${predicate}> ${xsdDateTimeLiteral(at)} } }
  WHERE { OPTIONAL { GRAPH <${graph}> { <${operationSubject}> <${predicate}> ?old } } }`;
}

/**
 * Of these share operations, the ones this core signed and still owes: in
 * the ledger and neither released as chain-absent nor superseded.
 */
export function storageAckOwedOperationsQuery(operationSubjects: readonly string[]): string {
  const values = operationSubjects.map((op) => `<${op}>`).join(' ');
  const p = STORAGE_ACK_LEDGER_PREDICATES;
  return `SELECT ?op ?signedAt ?absentSeen WHERE { GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> {
    VALUES ?op { ${values} }
    ?op <${p.signedAt}> ?signedAt .
    OPTIONAL { ?op <${p.absentSeenAt}> ?absentSeen }
    FILTER NOT EXISTS { ?op <${p.unregisteredAt}> ?unregistered }
    FILTER NOT EXISTS { ?op <${p.supersededAt}> ?superseded }
  } }`;
}
