// SPDX-License-Identifier: Apache-2.0

/**
 * StorageACK copies of an asset that is already durable in VM.
 *
 * A core that signed a StorageACK keeps that copy's share-operation row (id prefix
 * {@link STORAGE_ACK_OPERATION_ID_PREFIX}) in the SWM meta graph beside the publisher's own
 * row. Once the asset's version is durable and its SWM graph is dropped, that row describes
 * data that no longer exists. This module owns which of those rows are discharged (the prefix,
 * the row shape and the version rule) and how they are removed; callers only see a plan.
 *
 * The rule: copies of the same asset (UAL) at or below the newest version among the operations
 * being cleaned up. A later version's copy, another asset's copy and every other kind of
 * operation are never planned.
 *
 * Planning runs in two independent steps, so the cleanup boundary never depends on how many
 * copies exist or in which order a store returns them:
 *   1. one query over exactly the cleaned operations resolves the boundary version;
 *   2. keyset pages of eligible copies (one row per operation, ordered by IRI) enumerate all of
 *      them.
 * Removal is one store update over the whole plan.
 */

import { assertSafeIri, sparqlString } from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ENTITY_SHARE_METADATA_PREDICATES as F } from './entity-share-metadata.js';
import { STORAGE_ACK_OPERATION_ID_PREFIX } from './storage-ack-ledger.js';

const DKG = 'http://dkg.io/ontology/';
/** Copies read per page. */
const PAGE_SIZE = 64;
/** Pages read per plan: well beyond any realistic number of copies of one asset. */
const MAX_PAGES = 64;

/** The discharged StorageACK copies of one asset, ready to be removed together. */
export interface DischargedStorageAckCopies {
  readonly metaGraph: string;
  /** Operation subjects (one per copy) in the meta graph. */
  readonly operations: readonly string[];
  /** The page cap was reached: any copies beyond it stay in place. */
  readonly truncated: boolean;
}

export interface StorageAckCopyPlanLimits {
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export function noDischargedStorageAckCopies(metaGraph: string): DischargedStorageAckCopies {
  return { metaGraph, operations: [], truncated: false };
}

/** Rows shared by both queries: an operation of this asset with a share id and a version. */
function assetOperationPattern(kaUal: string, extra = ''): string {
  return `?operation <${F.type}> <${DKG}WorkspaceOperation> ;
      <${F.shareOperationId}> ?shareId ;
      <${DKG}kaUal> <${assertSafeIri(kaUal)}> ;
      <${DKG}assertionVersion> ?version .${extra}`;
}

/** Versions of exactly the operations being cleaned up. */
export function storageAckCleanedVersionsQuery(
  metaGraph: string,
  kaUal: string,
  cleanedOperations: readonly string[],
): string {
  return `SELECT DISTINCT ?version WHERE {
    GRAPH <${assertSafeIri(metaGraph)}> {
      VALUES ?operation { ${cleanedOperations.map(operation => `<${assertSafeIri(operation)}>`).join(' ')} }
      ${assetOperationPattern(kaUal)}
    }
  }`;
}

/** Keyset page (by operation IRI, after `after`) of copies at or below `maxVersion`. */
export function storageAckDischargedCopiesPageQuery(input: Readonly<{
  metaGraph: string;
  kaUal: string;
  maxVersion: number;
  after: string;
  limit: number;
}>): string {
  const filters = `
      FILTER(STRSTARTS(STR(?shareId), ${sparqlString(STORAGE_ACK_OPERATION_ID_PREFIX)}))
      FILTER(?version <= ${Math.trunc(input.maxVersion)})
      FILTER(STR(?operation) > ${sparqlString(input.after)})`;
  return `SELECT DISTINCT ?operation WHERE {
    GRAPH <${assertSafeIri(input.metaGraph)}> {
      ${assetOperationPattern(input.kaUal, filters)}
    }
  } ORDER BY ?operation LIMIT ${Math.trunc(input.limit)}`;
}

/** One update that removes every row of every planned operation. */
export function storageAckCopiesDeleteUpdate(metaGraph: string, operations: readonly string[]): string {
  const graph = assertSafeIri(metaGraph);
  return `DELETE { GRAPH <${graph}> { ?operation ?p ?o } }
  WHERE { GRAPH <${graph}> {
    VALUES ?operation { ${operations.map(operation => `<${assertSafeIri(operation)}>`).join(' ')} }
    ?operation ?p ?o
  } }`;
}

/**
 * Enumerate the copies discharged by cleaning up `cleanedOperations` of `kaUal`. Call it before
 * the asset's own operation rows are deleted: the boundary version is read from them. Nothing is
 * planned without a boundary. Query failures propagate, so a caller that keeps the rows on a
 * failure keeps the snapshot referenced (the safe direction).
 */
export async function planDischargedStorageAckCopies(
  store: Pick<TripleStore, 'query'>,
  input: Readonly<{ metaGraph: string; kaUal: string; cleanedOperations: readonly string[] }>,
  limits: StorageAckCopyPlanLimits = {},
): Promise<DischargedStorageAckCopies> {
  const { metaGraph, kaUal, cleanedOperations } = input;
  const none = noDischargedStorageAckCopies(metaGraph);
  if (cleanedOperations.length === 0) return none;
  const pageSize = limits.pageSize ?? PAGE_SIZE;
  const maxPages = limits.maxPages ?? MAX_PAGES;

  const boundary = await store.query(storageAckCleanedVersionsQuery(metaGraph, kaUal, cleanedOperations));
  if (boundary.type !== 'bindings') throw new Error('Storage ACK copy lookup did not return bindings');
  const maxVersion = Math.max(-1, ...boundary.bindings.map(row => {
    const version = Number(row['version'] === undefined ? Number.NaN : parseRdfLiteralTerm(row['version'])?.value);
    return Number.isSafeInteger(version) ? version : -1;
  }));
  if (maxVersion < 0) return none;

  const cleaned = new Set(cleanedOperations);
  const operations = new Set<string>();
  let after = '';
  for (let page = 0; page < maxPages; page += 1) {
    const result = await store.query(storageAckDischargedCopiesPageQuery({
      metaGraph, kaUal, maxVersion, after, limit: pageSize,
    }));
    if (result.type !== 'bindings') throw new Error('Storage ACK copy lookup did not return bindings');
    const found = result.bindings.flatMap(row => row['operation'] === undefined ? [] : [row['operation']]);
    for (const operation of found) if (!cleaned.has(operation)) operations.add(operation);
    if (result.bindings.length < pageSize) return { metaGraph, operations: [...operations], truncated: false };
    const last = found.at(-1);
    // A full page without a newer key cannot advance: stop rather than read the same page again.
    if (last === undefined || last <= after) break;
    after = last;
  }
  return { metaGraph, operations: [...operations], truncated: true };
}

/**
 * Remove every planned copy in one store update, so the plan is applied whole or not at all
 * where the backend's updates are atomic. A store that cannot run an update leaves the copies
 * in place (the safe direction) and reports it.
 */
export async function clearDischargedStorageAckCopies(
  store: Pick<TripleStore, 'update'>,
  plan: DischargedStorageAckCopies,
): Promise<void> {
  if (plan.operations.length === 0) return;
  if (typeof store.update !== 'function') {
    throw new Error('the triple store cannot run a single update for the whole set');
  }
  await store.update(storageAckCopiesDeleteUpdate(plan.metaGraph, plan.operations), {
    source: 'publisher.storageAckCopyCleanup',
    // The update touches only the meta graph; naming it keeps a graph-set index current.
    touchedGraphs: [plan.metaGraph],
  });
}
