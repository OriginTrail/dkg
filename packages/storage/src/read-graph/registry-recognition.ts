// SPDX-License-Identifier: Apache-2.0

/**
 * Registry recognition: which writes change the registry that read-graph
 * membership depends on, and what the registry becomes.
 *
 * Nothing registers a sub-graph or a child context graph through one call.
 * Registration facts are ordinary quads in `_meta` graphs (`./registry.ts`
 * lists them), written by inserts, metadata replaces and asset-group writes. So
 * the read-graph layer keeps, for every context graph with read graphs, the
 * registry facts themselves, and works out from each write's own arguments
 * which facts it adds and removes:
 * - an insert or a delete names its quads;
 * - a pattern or subject-prefix delete, a graph replace or drop, a subject
 *   replace and an RFC-64 author commit remove the cached facts they select,
 *   and add the facts among their new quads;
 * - an `update` declares only the graphs it writes, so when it writes a
 *   `_meta` graph the facts are read again after it.
 * A pattern delete is matched on its subject and predicate only, so it can only
 * over-count the facts it removes: a change it reports is checked against the
 * resulting registry, never assumed.
 */

import { contextGraphDataUri, contextGraphMetaUri, escapeSparqlLiteral, assertSafeIri } from '@origintrail-official/dkg-core';
import type { Quad, QueryOptions, TripleStore } from '../triple-store.js';
import type { ReadGraphRegistrySnapshot } from './membership.js';
import { READ_GRAPH_REGISTRY_PREDICATES as P, registeredSubGraphName } from './registry.js';

/** One registry fact, with the `_meta` graph that holds it. */
export interface ReadGraphRegistryFact {
  readonly graph: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
}

/** What a write does to registry facts, from its own arguments. */
export type ReadGraphRegistryWrite =
  /** Quads named one by one: those it adds and those it removes. */
  | { readonly kind: 'quads'; readonly added: readonly Quad[]; readonly removed: readonly Quad[] }
  /** Every triple of one graph matching a subject and a predicate (unset matches anything). */
  | { readonly kind: 'match'; readonly graph: string; readonly subject?: string; readonly predicate?: string }
  /** Every triple of one graph whose subject starts with a prefix. */
  | { readonly kind: 'prefix'; readonly graph: string; readonly prefix: string }
  /** A whole graph replaced by `quads` (none for a drop). */
  | { readonly kind: 'graph'; readonly graph: string; readonly quads: readonly Quad[] }
  /** The rows of one subject in one graph (of one predicate, when given) replaced by `quads`. */
  | { readonly kind: 'subject'; readonly graph: string; readonly subject: string; readonly predicate?: string; readonly quads: readonly Quad[] }
  /** Writes whose triples are not known before they run. */
  | { readonly kind: 'opaque'; readonly graphs: readonly string[] }
  | { readonly kind: 'all'; readonly parts: readonly ReadGraphRegistryWrite[] };

const CONTEXT_GRAPH_PREFIX = 'did:dkg:context-graph:';
const META_SUFFIX = '/_meta';

/** The query that reads one context graph's registry facts, as `?g ?s ?p ?o` rows. */
function readGraphRegistryFactsQuery(contextGraphId: string): string {
  const meta = assertSafeIri(contextGraphMetaUri(contextGraphId));
  const prefix = escapeSparqlLiteral(`${assertSafeIri(contextGraphDataUri(contextGraphId))}/`);
  const child = (pattern: string, bind: string) => `{ GRAPH ?g { ${pattern} }
    FILTER(STR(?g) = CONCAT(STR(?s), "/_meta"))
    FILTER(STRSTARTS(STR(?s), "${prefix}")) ${bind} }`;
  return `SELECT ?g ?s ?p ?o WHERE {
  { GRAPH <${meta}> { ?s <${P.type}> <${P.subGraphClass}> } BIND(<${meta}> AS ?g) BIND(<${P.type}> AS ?p) BIND(<${P.subGraphClass}> AS ?o) }
  UNION { GRAPH <${meta}> { ?s <${P.type}> <${P.subGraphClass}> ; <${P.name}> ?o } BIND(<${meta}> AS ?g) BIND(<${P.name}> AS ?p) }
  UNION { GRAPH <${meta}> { ?s <${P.authenticatedSubGraphName}> ?o } BIND(<${meta}> AS ?g) BIND(<${P.authenticatedSubGraphName}> AS ?p) }
  UNION ${child(`?s <${P.type}> <${P.contextGraphClass}> .`, `BIND(<${P.type}> AS ?p) BIND(<${P.contextGraphClass}> AS ?o)`)}
  UNION ${child(`?s <${P.registrationStatus}> ?o .`, `BIND(<${P.registrationStatus}> AS ?p)`)}
}`;
}

/** Read one context graph's registry facts from a store. */
export async function readReadGraphRegistryFacts(
  store: TripleStore,
  contextGraphId: string,
  options: QueryOptions = {},
): Promise<ReadGraphRegistryFact[]> {
  const result = await store.query(readGraphRegistryFactsQuery(contextGraphId), {
    ...(options.priority ? { priority: options.priority } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    source: 'storage.readGraphRegistry',
  });
  if (result.type !== 'bindings') throw new Error('The read-graph registry query expected bindings');
  return result.bindings.flatMap((row) => row.g && row.s && row.p && row.o !== undefined
    ? [{ graph: row.g, subject: row.s, predicate: row.p, object: row.o }] : []);
}

/** The registry a context graph's facts give, decoded as the view route decodes it. */
export function registrySnapshotOfFacts(contextGraphId: string, facts: readonly ReadGraphRegistryFact[]): ReadGraphRegistrySnapshot {
  const meta = contextGraphMetaUri(contextGraphId);
  const childPrefix = `${contextGraphDataUri(contextGraphId)}/`;
  const typed = new Set(facts.filter((fact) => fact.graph === meta && fact.predicate === P.type && fact.object === P.subGraphClass)
    .map((fact) => fact.subject));
  const names = new Set<string>();
  const children = new Set<string>();
  for (const fact of facts) {
    if (fact.graph === meta && (fact.predicate === P.authenticatedSubGraphName || (fact.predicate === P.name && typed.has(fact.subject)))) {
      const name = registeredSubGraphName(fact.object);
      if (name !== undefined) names.add(name);
    }
    if (isChildFact(fact) && fact.graph === `${fact.subject}${META_SUFFIX}` && fact.subject.startsWith(childPrefix)) children.add(fact.subject);
  }
  return { contextGraphId, subGraphNames: [...names].sort(), childContextGraphRoots: [...children].sort() };
}

/**
 * The context graphs whose registry a `_meta` graph can hold facts of: the
 * graph's own context graph (its sub-graphs), and each context graph above it
 * (the child it registers). Empty for any other graph.
 */
export function registryOwnersOfGraph(graph: string): string[] {
  if (!graph.startsWith(CONTEXT_GRAPH_PREFIX) || !graph.endsWith(META_SUFFIX)) return [];
  const id = graph.slice(CONTEXT_GRAPH_PREFIX.length, -META_SUFFIX.length);
  if (id.length === 0) return [];
  const segments = id.split('/');
  return segments.map((_, end) => segments.slice(0, end + 1).join('/')).reverse();
}

/** The `_meta` graphs a write can change registry facts in. */
export function registryGraphsOfWrite(write: ReadGraphRegistryWrite): string[] {
  const graphs = (() => {
    switch (write.kind) {
      case 'quads': return [...write.added, ...write.removed].map((quad) => quad.graph);
      case 'opaque': return [...write.graphs];
      case 'all': return write.parts.flatMap(registryGraphsOfWrite);
      default: return [write.graph];
    }
  })();
  return [...new Set(graphs.filter((graph) => registryOwnersOfGraph(graph).length > 0))];
}

/** Whether a write can change registry facts without the layer seeing which. */
function isOpaqueRegistryWrite(write: ReadGraphRegistryWrite): boolean {
  return write.kind === 'opaque' ? registryGraphsOfWrite(write).length > 0 : write.kind === 'all' && write.parts.some(isOpaqueRegistryWrite);
}

/**
 * A context graph's registry facts after a write, from the facts before it.
 * `undefined` when the write is opaque for these graphs, so only reading the
 * store again tells.
 */
export function registryFactsAfter(
  contextGraphId: string,
  facts: readonly ReadGraphRegistryFact[],
  write: ReadGraphRegistryWrite,
): ReadGraphRegistryFact[] | undefined {
  if (isOpaqueRegistryWrite(write)) return undefined;
  const meta = contextGraphMetaUri(contextGraphId);
  const childPrefix = `${contextGraphDataUri(contextGraphId)}/`;
  // Only facts this context graph's registry is read from: its own `_meta`, and its children's.
  const registryFactsOf = (quads: readonly Quad[]) => registryFactsAmong(quads).filter((fact) => fact.graph === meta
    || (isChildFact(fact) && fact.graph === `${fact.subject}${META_SUFFIX}` && fact.subject.startsWith(childPrefix)));
  let next = [...facts];
  const apply = (part: ReadGraphRegistryWrite): void => {
    switch (part.kind) {
      case 'quads':
        next = next.filter((fact) => !part.removed.some((quad) => sameFact(fact, quad)));
        next.push(...registryFactsOf(part.added));
        return;
      case 'match':
        next = next.filter((fact) => !(fact.graph === part.graph && (part.subject === undefined || fact.subject === part.subject)
          && (part.predicate === undefined || fact.predicate === part.predicate)));
        return;
      case 'prefix':
        next = next.filter((fact) => !(fact.graph === part.graph && fact.subject.startsWith(part.prefix)));
        return;
      case 'graph':
        next = next.filter((fact) => fact.graph !== part.graph);
        next.push(...registryFactsOf(part.quads));
        return;
      case 'subject':
        next = next.filter((fact) => !(fact.graph === part.graph && fact.subject === part.subject
          && (part.predicate === undefined || fact.predicate === part.predicate)));
        next.push(...registryFactsOf(part.quads));
        return;
      case 'all':
        for (const each of part.parts) apply(each);
        return;
      case 'opaque':
        return;
    }
  };
  apply(write);
  return next;
}

/** Whether two registries give the same membership. */
export function sameRegistry(left: ReadGraphRegistrySnapshot, right: ReadGraphRegistrySnapshot): boolean {
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, i) => value === b[i]);
  return same([...left.subGraphNames].sort(), [...right.subGraphNames].sort())
    && same([...left.childContextGraphRoots].sort(), [...right.childContextGraphRoots].sort());
}

/** The quads that are registry facts: any of the registry predicates, with a class object for `rdf:type`. */
function registryFactsAmong(quads: readonly Quad[]): ReadGraphRegistryFact[] {
  return quads.flatMap((quad) => isRegistryPredicate(quad.predicate, quad.object) && registryOwnersOfGraph(quad.graph).length > 0
    ? [{ graph: quad.graph, subject: quad.subject, predicate: quad.predicate, object: quad.object }] : []);
}

function isRegistryPredicate(predicate: string, object: string): boolean {
  if (predicate === P.type) return object === P.subGraphClass || object === P.contextGraphClass;
  return predicate === P.name || predicate === P.authenticatedSubGraphName || predicate === P.registrationStatus;
}

function isChildFact(fact: ReadGraphRegistryFact): boolean {
  return (fact.predicate === P.type && fact.object === P.contextGraphClass) || fact.predicate === P.registrationStatus;
}

/** A cached fact and a quad name the same triple, comparing a literal by its lexical form. */
function sameFact(fact: ReadGraphRegistryFact, quad: Quad): boolean {
  return fact.graph === quad.graph && fact.subject === quad.subject && fact.predicate === quad.predicate
    && lexical(fact.object) === lexical(quad.object);
}

function lexical(term: string): string {
  return term.startsWith('"') ? term.replace(/^"/, '').replace(/"(?:\^\^<[^>]+>|@[a-zA-Z-]+)?$/, '') : term;
}
