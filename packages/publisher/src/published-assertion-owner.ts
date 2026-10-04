// SPDX-License-Identifier: Apache-2.0

import { assertSafeIri, MemoryLayer } from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm, XSD_STRING_DATATYPE } from '@origintrail-official/dkg-rdf-utils';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { SHARE_OPERATION_ID_PRED } from './metadata.js';

function nonemptyString(term: string | undefined): string | undefined {
  const literal = term === undefined ? null : parseRdfLiteralTerm(term);
  return literal && (literal.kind === 'plain' || literal.kind === 'typed' && literal.datatype === XSD_STRING_DATATYPE)
    && literal.value.length > 0 ? literal.value : undefined;
}

/** Capture the retained named operation; null is legacy absence, undefined is corrupt. */
export async function readPublishedAssertionOperation(
  store: TripleStore, graph: string, lifecycle: string,
): Promise<string | null | undefined> {
  const result = await store.query(`SELECT ?operation WHERE { GRAPH <${assertSafeIri(graph)}> {
    <${assertSafeIri(lifecycle)}> <${SHARE_OPERATION_ID_PRED}> ?operation
  } } LIMIT 2`);
  if (result.type !== 'bindings' || result.bindings.length > 1) return undefined;
  if (result.bindings.length === 1) return nonemptyString(result.bindings[0]!['operation']);
  // Metadata trimming removes the lifecycle row after the immutable share is
  // durable. Its latest promoted event is the canonical retained identity used
  // by queued admission as well. Two rows expose a conflicting latest event.
  const events = await store.query(`SELECT DISTINCT ?event ?operation ?time WHERE { GRAPH <${assertSafeIri(graph)}> {
    ?event a <http://dkg.io/ontology/AssertionPromoted> ;
      <http://www.w3.org/ns/prov#used> <${assertSafeIri(lifecycle)}> ;
      <${SHARE_OPERATION_ID_PRED}> ?operation .
    OPTIONAL { ?event <http://www.w3.org/ns/prov#startedAtTime> ?time }
  } } ORDER BY ASC(BOUND(?time)) DESC(?time) DESC(?event) LIMIT 2`);
  if (events.type !== 'bindings') return undefined;
  if (events.bindings.length === 0) return null;
  const [current, prior] = events.bindings;
  if (!current?.['event'] || prior?.['event'] === current['event']) return undefined;
  const timestamp = parseRdfLiteralTerm(current['time'] ?? '')?.value;
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return undefined;
  return nonemptyString(current['operation']);
}

/** Publication owns the captured lifecycle operation, including explicit legacy absence. */
export async function isPublishedAssertionOwner(
  store: TripleStore, graph: string, lifecycle: string, expected: string | null,
): Promise<boolean> {
  if (expected !== null && typeof expected !== 'string') return false;
  const operation = await readPublishedAssertionOperation(store, graph, lifecycle);
  if (operation === undefined || operation !== expected) return false;
  // Reopen preserves old promotion events/markers, but withdraws their ownership
  // by moving the current lifecycle to WM. Require that proof before authorizing writes.
  const layer = await store.query(`SELECT ?layer WHERE { GRAPH <${assertSafeIri(graph)}> {
    <${assertSafeIri(lifecycle)}> <http://dkg.io/ontology/memoryLayer> ?layer
  } } LIMIT 2`);
  if (layer.type !== 'bindings' || layer.bindings.length !== 1) return false;
  const value = nonemptyString(layer.bindings[0]!['layer']);
  if (value !== MemoryLayer.SharedWorkingMemory && value !== MemoryLayer.VerifiableMemory) return false;
  return true;
}
