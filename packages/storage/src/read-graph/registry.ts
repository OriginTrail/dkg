// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a context graph's registry for read-graph membership: its registered
 * sub-graph names and its registered child context graphs. The facts and their
 * decoding are those the view route reads in the query package
 * (`registered-sub-graphs.ts`, `scoped-content-graph-catalog.ts`), which
 * storage cannot import, so membership follows the same registry as the view.
 *
 * - A sub-graph is registered by a subject typed `dkg:SubGraph` with a
 *   `schema:name`, or by an asset's `dkg:authenticatedSubGraphName`, in the
 *   context graph's `_meta` graph.
 * - A child is a context graph under the parent's root that is typed
 *   `ContextGraph`, or has a `registrationStatus`, in its own `_meta` graph.
 */

import {
  assertSafeIri,
  contextGraphDataUri,
  contextGraphMetaUri,
  escapeSparqlLiteral,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import type { QueryOptions, TripleStore } from '../triple-store.js';
import type { ReadGraphRegistrySnapshot } from './membership.js';

export const READ_GRAPH_REGISTRY_PREDICATES = Object.freeze({
  type: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
  subGraphClass: 'http://dkg.io/ontology/SubGraph',
  name: 'http://schema.org/name',
  authenticatedSubGraphName: 'http://dkg.io/ontology/authenticatedSubGraphName',
  contextGraphClass: 'https://dkg.network/ontology#ContextGraph',
  registrationStatus: 'https://dkg.network/ontology#registrationStatus',
} as const);

/** The query that reads one context graph's registry, as `?name` and `?child` rows. */
function readGraphRegistryQuery(contextGraphId: string): string {
  const p = READ_GRAPH_REGISTRY_PREDICATES;
  const meta = assertSafeIri(contextGraphMetaUri(contextGraphId));
  const prefix = escapeSparqlLiteral(`${assertSafeIri(contextGraphDataUri(contextGraphId))}/`);
  const child = (pattern: string) => `{ GRAPH ?childMeta { ?child ${pattern} . }
    FILTER(STR(?childMeta) = CONCAT(STR(?child), "/_meta"))
    FILTER(STRSTARTS(STR(?child), "${prefix}")) }`;
  return `SELECT DISTINCT ?name ?child WHERE {
  { GRAPH <${meta}> { ?subGraph <${p.type}> <${p.subGraphClass}> ; <${p.name}> ?name . } }
  UNION { GRAPH <${meta}> { ?asset <${p.authenticatedSubGraphName}> ?name . } }
  UNION ${child(`<${p.type}> <${p.contextGraphClass}>`)}
  UNION ${child(`<${p.registrationStatus}> ?status`)}
}`;
}

/** The registry snapshot of a {@link readGraphRegistryQuery} answer. */
export function parseReadGraphRegistryRows(
  contextGraphId: string,
  bindings: readonly Readonly<Record<string, string | undefined>>[],
): ReadGraphRegistrySnapshot {
  const subGraphNames = new Set<string>();
  const children = new Set<string>();
  for (const row of bindings) {
    const name = registeredSubGraphName(row.name);
    if (name !== undefined) subGraphNames.add(name);
    if (row.child) children.add(row.child);
  }
  return { contextGraphId, subGraphNames: [...subGraphNames].sort(), childContextGraphRoots: [...children].sort() };
}

/** Read one context graph's registry from a store. */
export async function readReadGraphRegistry(
  store: TripleStore,
  contextGraphId: string,
  options: QueryOptions = {},
): Promise<ReadGraphRegistrySnapshot> {
  const result = await store.query(readGraphRegistryQuery(contextGraphId), {
    ...(options.priority ? { priority: options.priority } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    source: 'storage.readGraphRegistry',
  });
  if (result.type !== 'bindings') throw new Error('The read-graph registry query expected bindings');
  return parseReadGraphRegistryRows(contextGraphId, result.bindings);
}

/** A sub-graph name as the view route decodes it: the lexical form, if `validateSubGraphName` accepts it. */
export function registeredSubGraphName(value: string | undefined): string | undefined {
  const name = (value ?? '').replace(/^"/, '').replace(/"(?:\^\^<[^>]+>|@[a-zA-Z-]+)?$/, '');
  return validateSubGraphName(name).valid ? name : undefined;
}
