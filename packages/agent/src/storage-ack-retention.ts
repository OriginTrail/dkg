// SPDX-License-Identifier: Apache-2.0

/**
 * Retention of the SWM copies a core persists when it signs a StorageACK.
 *
 * A StorageACK attests that the core stored the data, and the finality gate
 * promises the KA reaches the core's VM once the chain finalizes it. The
 * ordinary SWM TTL must therefore not delete such a copy while its KA is still
 * waiting for promotion. It stays exempt until:
 *   - the KA is confirmed in VM (after which twin retirement removes the copy),
 *   - the ACK promotion audit proves the KA was never registered on chain and
 *     stamps {@link STORAGE_ACK_UNREGISTERED_AT_PREDICATE} on the operation, or
 *   - the operation is older than the hard retention ceiling.
 * An ACK retry rewrites the operation rows, clearing the stamp and restarting
 * the window, because a retried ACK means the publish is still alive.
 */

/** `dkg:shareOperationId` prefix of every StorageACK-persisted operation. */
export const STORAGE_ACK_SHARE_OPERATION_ID_PREFIX = 'storage-ack-';

/** Stamped by the ACK promotion audit once chain absence is proven. */
export const STORAGE_ACK_UNREGISTERED_AT_PREDICATE =
  'http://dkg.io/ontology/storageAckUnregisteredAt';

const DKG = 'http://dkg.io/ontology/';
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

/**
 * SPARQL group-body conditions that hold when `?<opVar>` (with publication
 * time `?<tsVar>`, bound by the caller from `metaGraph`) is a StorageACK copy
 * retention still protects. Callers splice them into the SAME group that
 * binds (or, inside EXISTS, substitutes) both variables: a FILTER in a
 * nested `{ }` group cannot see a sibling pattern's bindings. Plain row
 * patterns only: no aggregates over multi-graph VALUES.
 */
export function storageAckRetentionProtectedConditions(input: Readonly<{
  metaGraph: string;
  rootMetaGraph: string;
  opVar: string;
  tsVar: string;
  retentionCutoffIso: string;
  suffix: string;
}>): string {
  const { metaGraph, rootMetaGraph, opVar, tsVar, retentionCutoffIso, suffix } = input;
  const opId = `?storageAckOpId${suffix}`;
  const ka = `?storageAckKa${suffix}`;
  return `GRAPH <${metaGraph}> {
      ${opVar} <${DKG}shareOperationId> ${opId} ;
        <${DKG}kaUal> ${ka} .
      FILTER(STRSTARTS(STR(${opId}), "${STORAGE_ACK_SHARE_OPERATION_ID_PREFIX}"))
      FILTER NOT EXISTS { ${opVar} <${STORAGE_ACK_UNREGISTERED_AT_PREDICATE}> ?storageAckUnregisteredAt${suffix} }
    }
    FILTER(${tsVar} >= "${retentionCutoffIso}"^^<${XSD_DATE_TIME}>)
    FILTER NOT EXISTS { GRAPH <${rootMetaGraph}> { ${ka} <${DKG}status> "confirmed" } }`;
}
