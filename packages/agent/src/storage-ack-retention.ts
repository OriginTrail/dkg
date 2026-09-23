// SPDX-License-Identifier: Apache-2.0

/**
 * Retention of the SWM copies a core persists when it signs a StorageACK.
 *
 * A StorageACK attests that the core stored the data, and the finality gate
 * promises the Knowledge Asset (at that assertion version) reaches the core's
 * VM once the chain finalizes it. The ordinary SWM TTL must therefore not
 * delete such a copy while it is still owed. Retention covers only copies in
 * the node-local signed-ACK ledger (`STORAGE_ACK_LEDGER_GRAPH`): copies this
 * core actually signed, plus copies it stored before it kept a ledger
 * (grandfathered once, on a core). Declined requests, gossip-chosen
 * `storage-ack-` ids and SWM-synced copies are never in the ledger.
 *
 * A ledgered copy stays exempt from the TTL until one of:
 *   - its Knowledge Asset is confirmed in the namespace's VM at this version
 *     or later (twin retirement then removes the copy),
 *   - the promotion audit proved twice, past the TTL, that the chain does not
 *     have it (`storageAckUnregisteredAt`), or
 *   - it is older than the hard ceiling AND the audit never saw it registered
 *     on chain. A copy seen registered (`storageAckRegisteredAt`) but not
 *     promoted is kept until it is promoted: deleting it would turn a stalled
 *     promotion into data loss for an ACK this core signed.
 *
 * ACK signatures carry no chain deadline and do not bind the kaId, so the
 * "never registered" stamp is conservative evidence, not proof: a publisher
 * could still submit the ACKs later, or register the same root under another
 * kaId. Reference publishers do neither.
 */

import {
  STORAGE_ACK_LEDGER_GRAPH,
  STORAGE_ACK_LEDGER_PREDICATES as LEDGER,
} from '@origintrail-official/dkg-publisher';

/** `dkg:shareOperationId` prefix of every StorageACK-persisted operation. */
export const STORAGE_ACK_SHARE_OPERATION_ID_PREFIX = 'storage-ack-';

const DKG = 'http://dkg.io/ontology/';
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

interface RetentionConditionInput {
  readonly rootMetaGraph: string;
  readonly opVar: string;
  readonly suffix: string;
}

// The version comparison sits at the NOT EXISTS group level, not inside its
// GRAPH block: Blazegraph does not substitute the outer `?version` into a
// FILTER nested one group deeper, and would then never treat a copy as promoted.
function ledgeredAndOwed(input: RetentionConditionInput): string {
  const { rootMetaGraph, opVar, suffix } = input;
  const ka = `?storageAckKa${suffix}`;
  const version = `?storageAckVersion${suffix}`;
  return `GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> {
      ${opVar} <${LEDGER.signedAt}> ?storageAckSignedAt${suffix} ;
        <${LEDGER.kaUal}> ${ka} ;
        <${LEDGER.assertionVersion}> ${version} .
      FILTER NOT EXISTS { ${opVar} <${LEDGER.unregisteredAt}> ?storageAckUnregisteredAt${suffix} }
    }
    FILTER NOT EXISTS {
      GRAPH <${rootMetaGraph}> {
        ${ka} <${DKG}status> "confirmed" ;
          <${DKG}assertionVersion> ?storageAckConfirmedVersion${suffix} .
      }
      FILTER(?storageAckConfirmedVersion${suffix} >= ${version})
    }`;
}

/**
 * SPARQL group-body conditions that hold when `?<opVar>` is a ledgered copy
 * still owed to VM and seen registered on chain: retained with no ceiling.
 * Callers splice them into the group that binds (or, inside EXISTS,
 * substitutes) the variable. Plain row patterns only: no aggregates.
 */
export function storageAckRetainedAsRegistered(input: RetentionConditionInput): string {
  return `${ledgeredAndOwed(input)}
    GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> {
      ${input.opVar} <${LEDGER.registeredAt}> ?storageAckRegisteredAt${input.suffix}
    }`;
}

/**
 * Conditions that hold when `?<opVar>` (published at `?<tsVar>`, bound by the
 * caller) is a ledgered copy still owed to VM and younger than the ceiling.
 */
export function storageAckRetainedByAge(input: RetentionConditionInput & Readonly<{
  tsVar: string;
  retentionCutoffIso: string;
}>): string {
  return `${ledgeredAndOwed(input)}
    FILTER(${input.tsVar} >= "${input.retentionCutoffIso}"^^<${XSD_DATE_TIME}>)`;
}

/**
 * Fail-safe used only while a core has not finished grandfathering its
 * pre-ledger copies: every `storage-ack-` operation younger than the ceiling
 * is kept, as before the ledger existed.
 */
export function storageAckRetainedByPrefix(input: Readonly<{
  metaGraph: string;
  opVar: string;
  tsVar: string;
  retentionCutoffIso: string;
  suffix: string;
}>): string {
  return `GRAPH <${input.metaGraph}> {
      ${input.opVar} <${DKG}shareOperationId> ?storageAckPrefixOpId${input.suffix} .
      FILTER(STRSTARTS(STR(?storageAckPrefixOpId${input.suffix}), "${STORAGE_ACK_SHARE_OPERATION_ID_PREFIX}"))
    }
    FILTER(${input.tsVar} >= "${input.retentionCutoffIso}"^^<${XSD_DATE_TIME}>)`;
}

/**
 * One store-side INSERT that grandfathers every `storage-ack-` copy stored
 * before `epochIso` into the ledger. Idempotent (skips ledgered copies) and
 * bounded by the epoch, so copies persisted later without a signature never
 * qualify.
 */
export function storageAckGrandfatherUpdate(epochIso: string): string {
  return `INSERT {
    GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> {
      ?op <${LEDGER.signedAt}> ?ts ;
        <${LEDGER.namespace}> ?namespace ;
        <${LEDGER.metaGraph}> ?meta ;
        <${LEDGER.kaUal}> ?ka ;
        <${LEDGER.assertionVersion}> ?version ;
        <${LEDGER.operation}> ?operation ;
        <${LEDGER.grandfathered}> true .
    }
  } WHERE {
    GRAPH ?meta {
      ?op <${DKG}shareOperationId> ?opId ;
        <${DKG}contextGraphId> ?namespace ;
        <${DKG}kaUal> ?ka ;
        <${DKG}assertionVersion> ?version ;
        <${DKG}publishedAt> ?ts .
      FILTER(STRSTARTS(STR(?opId), "${STORAGE_ACK_SHARE_OPERATION_ID_PREFIX}"))
      FILTER(?ts < "${epochIso}"^^<${XSD_DATE_TIME}>)
    }
    FILTER(STRENDS(STR(?meta), "/_shared_memory_meta"))
    FILTER NOT EXISTS { GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> { ?op <${LEDGER.signedAt}> ?signedAt } }
    BIND(IF(?version > 1, "update", "publish") AS ?operation)
  }`;
}
