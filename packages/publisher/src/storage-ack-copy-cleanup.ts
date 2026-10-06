// SPDX-License-Identifier: Apache-2.0

/**
 * StorageACK copies of an asset that is already durable in VM.
 *
 * A core that signed a StorageACK keeps that copy's share-operation row (id prefix
 * {@link STORAGE_ACK_OPERATION_ID_PREFIX}) in the SWM meta graph beside the publisher's own
 * row. Once the asset's version is durable and its SWM graph is dropped, that row describes
 * data that no longer exists. This module owns which of those rows are discharged (the prefix,
 * the row shape and the version rule) and how they are removed.
 *
 * The rule: copies of the same asset (UAL) whose version is at or below the newest version among
 * the operations being cleaned up. A later version's copy, another asset's copy, every other kind
 * of operation and the cleaned operations themselves are never removed.
 *
 * Removal is ONE conditional SPARQL update. The store selects the copies itself, by joining them
 * to the cleaned operations of the same asset, so nothing depends on how many copies exist, in
 * which order a store would return them, or how long a client-side enumeration would take. Because
 * the version boundary is read from the cleaned operations' own rows, the update must run BEFORE
 * those rows are deleted; with the rows gone it finds no boundary and removes nothing.
 *
 * Fail closed: no cleaned operation of this asset with a usable version means no boundary and no
 * row is removed; a store that cannot run an update, or an update that fails, leaves every row in
 * place (the snapshot then stays referenced, the safe direction).
 */

import { assertSafeIri, sparqlString } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ENTITY_SHARE_METADATA_PREDICATES as F } from './entity-share-metadata.js';
import { STORAGE_ACK_OPERATION_ID_PREFIX } from './storage-ack-ledger.js';

const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

export interface StorageAckCopyCleanupInput {
  readonly metaGraph: string;
  readonly kaUal: string;
  /** The operations of `kaUal` being cleaned up: their versions bound which copies are discharged. */
  readonly cleanedOperations: readonly string[];
}

/** One operation of this asset with a share id and a version, bound to `operation`. */
function assetOperationPattern(operation: string, shareId: string, version: string, kaUal: string): string {
  return `?${operation} <${F.type}> <${DKG}WorkspaceOperation> ;
      <${F.shareOperationId}> ?${shareId} ;
      <${DKG}kaUal> <${assertSafeIri(kaUal)}> ;
      <${DKG}assertionVersion> ?${version} .`;
}

/**
 * A canonical positive integer literal: the form every writer emits (`"<BigInt>"^^xsd:integer`).
 * Anything else has no usable version, so it is neither a boundary nor a discharged copy.
 *
 * The pattern deliberately has no `$` anchor: on Blazegraph (Java regular expressions) `$` also
 * matches before a trailing line terminator, so `"5\n"^^xsd:integer` would pass `^[1-9][0-9]*$` and
 * be compared as a two-digit version, deleting copies numerically above the boundary. Requiring a
 * leading non-zero digit and no character other than a digit is strict on every engine.
 */
const canonicalVersion = (variable: string): string =>
  `DATATYPE(?${variable}) = <${XSD_INTEGER}> && REGEX(STR(?${variable}), "^[1-9]") && !REGEX(STR(?${variable}), "[^0-9]")`;

/**
 * The one update that removes every discharged copy of `kaUal`.
 *
 * Versions are compared as canonical decimal strings, by length and then digit by digit, which is
 * the numeric order for positive integers of ANY size. An assertion version may be any positive
 * integer (the contract has no upper bound), and engines differ in what their numeric type holds:
 * measured, a native comparison is exact up to 2^63 - 1 on Oxigraph and wider on Blazegraph, and
 * above its range Oxigraph silently stops matching. The string order is the same on every engine.
 *
 * The boundary is not aggregated (no `MAX`, sub-select or `EXISTS`): the cleaned operations are
 * joined in the same pattern and a copy is selected when SOME cleaned version is at or above its
 * own, which is the same set as "at or below the newest". Measured on Oxigraph 0.5.8, a sub-select
 * or a `FILTER EXISTS` beside this pattern took 23 s to well over 100 s with 20,000 unrelated
 * operations in the meta graph; the flat join takes tens of milliseconds.
 */
export function storageAckCopiesDischargeUpdate(input: StorageAckCopyCleanupInput): string {
  const { metaGraph, kaUal, cleanedOperations } = input;
  const graph = assertSafeIri(metaGraph);
  const cleaned = cleanedOperations.map(operation => `<${assertSafeIri(operation)}>`);
  return `DELETE { GRAPH <${graph}> { ?operation ?p ?o } }
  WHERE { GRAPH <${graph}> {
    VALUES ?cleaned { ${cleaned.join(' ')} }
    ${assetOperationPattern('cleaned', 'cleanedShareId', 'cleanedVersion', kaUal)}
    ${assetOperationPattern('operation', 'shareId', 'version', kaUal)}
    FILTER(STRSTARTS(STR(?shareId), ${sparqlString(STORAGE_ACK_OPERATION_ID_PREFIX)}))
    FILTER(?operation NOT IN (${cleaned.join(', ')}))
    FILTER(${canonicalVersion('cleanedVersion')})
    FILTER(${canonicalVersion('version')})
    FILTER(STRLEN(STR(?version)) < STRLEN(STR(?cleanedVersion))
      || (STRLEN(STR(?version)) = STRLEN(STR(?cleanedVersion)) && STR(?version) <= STR(?cleanedVersion)))
    ?operation ?p ?o .
  } }`;
}

/**
 * Remove the StorageACK copies discharged by cleaning up `cleanedOperations` of `kaUal`. Call it
 * before the asset's own operation rows are deleted (see the module note). Nothing is issued for
 * an empty set. A store that cannot run an update, an update that cannot be written (an unsafe
 * IRI) and a failing update all reject with every row still in place, so a caller that keeps going
 * on a failure keeps the snapshot referenced.
 */
export async function clearDischargedStorageAckCopies(
  store: Pick<TripleStore, 'update'>,
  input: StorageAckCopyCleanupInput,
): Promise<void> {
  if (input.cleanedOperations.length === 0) return;
  if (typeof store.update !== 'function') {
    throw new Error('the triple store cannot run an update for the StorageACK copy cleanup');
  }
  await store.update(storageAckCopiesDischargeUpdate(input), {
    source: 'publisher.storageAckCopyCleanup',
    // The update touches only the meta graph; naming it keeps a graph-set index current.
    touchedGraphs: [input.metaGraph],
  });
}
