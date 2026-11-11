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
 * Two gaps are closed around the write:
 * - The facts hold the names of typed sub-graphs only. Before a write that
 *   types a subject as a sub-graph, that subject's stored names are read
 *   ({@link readNamesOfNewSubGraphs}).
 * - Whether a delete removes a fact with a literal object depends on how the
 *   store compares literals (language tags, datatypes). Such a removal is
 *   predicted by lexical form, which can only over-count the facts removed.
 *   The read graphs are marked from that prediction before the write, and the
 *   facts are read again after it ({@link isExactRegistryWrite}). So are they
 *   after a removal that names a blank node, whose label in a write is not
 *   the one the store reports; the read graphs are then marked after it.
 * Terms are compared as the stores take them: an IRI with or without angle
 * brackets is one IRI, a literal is taken in its canonical form (escapes
 * decoded), and a literal never equals an IRI.
 */

import { contextGraphDataUri, contextGraphMetaUri, escapeSparqlLiteral, assertSafeIri, unwrapIri } from '@origintrail-official/dkg-core';
import { canonicalizeRdfObjectTerm, parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
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
  /** Every triple of one graph matching a subject, a predicate and an object (unset matches anything). */
  | { readonly kind: 'match'; readonly graph: string; readonly subject?: string; readonly predicate?: string; readonly object?: string }
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
 * A context graph's registry facts after a write, from the facts before it,
 * once each, as the store keeps a quad however often it is inserted.
 * `undefined` when the write is opaque for these graphs, so only reading the
 * store again tells.
 */
export function registryFactsAfter(
  contextGraphId: string,
  facts: readonly ReadGraphRegistryFact[],
  write: ReadGraphRegistryWrite,
): ReadGraphRegistryFact[] | undefined {
  if (isOpaqueRegistryWrite(write)) return undefined;
  const registryFactsOf = (quads: readonly Quad[]) => ownerFactsAmong(contextGraphId, quads);
  let next = [...facts];
  const apply = (part: ReadGraphRegistryWrite): void => {
    switch (part.kind) {
      case 'quads':
        next = next.filter((fact) => !part.removed.some((quad) => sameFact(fact, quad)));
        next.push(...registryFactsOf(part.added));
        return;
      case 'match':
        next = next.filter((fact) => !(fact.graph === part.graph && (part.subject === undefined || fact.subject === unwrapIri(part.subject))
          && (part.predicate === undefined || fact.predicate === unwrapIri(part.predicate))
          && (part.object === undefined || sameObject(fact.object, storedTerm(part.object)))));
        return;
      case 'prefix':
        // The adapters match `STRSTARTS(STR(?s), prefix)`, which no blank node passes.
        next = next.filter((fact) => !(fact.graph === part.graph && !fact.subject.startsWith('_:') && fact.subject.startsWith(part.prefix)));
        return;
      case 'graph':
        next = next.filter((fact) => fact.graph !== part.graph);
        next.push(...registryFactsOf(part.quads));
        return;
      case 'subject':
        next = next.filter((fact) => !(fact.graph === part.graph && fact.subject === unwrapIri(part.subject)
          && (part.predicate === undefined || fact.predicate === unwrapIri(part.predicate))));
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
  const seen = new Set<string>();
  return next.filter((fact) => {
    const key = JSON.stringify([fact.graph, fact.subject, fact.predicate, fact.object]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Whether {@link registryFactsAfter} gives exactly the facts a write leaves.
 * It does not when the write removes facts it names by a literal (which facts
 * go then depends on how the store compares literals, and the lexical
 * prediction can only over-count them), by a blank node (whose label in a
 * write is not the store's) or by an IRI in angle brackets (which the adapters
 * do not all delete), nor when it inserts facts on a blank node, which the
 * store makes a fresh node. IRIs compare exactly, and never equal a literal.
 */
export function isExactRegistryWrite(contextGraphId: string, write: ReadGraphRegistryWrite): boolean {
  // A literal that does not parse cannot be put in the form the store reports, and a store may give one with a
  // datatype other than a string another lexical form (`"01"^^xsd:integer` is kept as `"1"`).
  const unreadable = (quads: readonly Quad[]) => ownerFactsAmong(contextGraphId, quads)
    .some((fact) => fact.object.startsWith('"')
      && (parseRdfLiteralTerm(fact.object, { combineSurrogatePairs: true }) === null || /"\^\^<[^>]*>$/.test(fact.object)));
  // A removal is judged by its predicate alone: a SPARQL adapter deletes a blank-node term as a variable,
  // so a type removal whose object is a blank node can remove a registration type.
  // So is one that names an IRI in angle brackets, which the adapters do not all delete: the embedded engine skips it.
  const removesLoosely = (quads: readonly Quad[]) => quads.some((quad) => registryOwnersOfGraph(quad.graph).includes(contextGraphId)
    && REGISTRY_PREDICATES.has(unwrapIri(quad.predicate)) && (isComparedLoosely(unwrapIri(quad.subject)) || isComparedLoosely(storedTerm(quad.object))
      || [quad.subject, quad.predicate, quad.object].some(isBracketedIri)));
  // A store makes every inserted blank node a fresh one, whatever its label, so an added fact on a blank node
  // never joins a cached subject with the same label: only reading the facts after the write tells.
  const addsBlankNode = (quads: readonly Quad[]) => ownerFactsAmong(contextGraphId, quads).some((fact) => fact.subject.startsWith('_:'));
  // An IRI the grammar refuses may reach the store rewritten, as some adapters drop the characters that break an IRI,
  // so in the store it can name another term than here: only reading the facts again tells.
  const ownQuads = (quads: readonly Quad[]) => quads.filter((quad) => registryOwnersOfGraph(quad.graph).includes(contextGraphId));
  const namesUnsafeIri = (quads: readonly Quad[]) => ownQuads(quads).some((quad) => [quad.subject, quad.predicate, quad.object].some(isUnsafeIri));
  switch (write.kind) {
    case 'quads':
      return !removesLoosely(write.removed) && !unreadable(write.added) && !addsBlankNode(write.added)
        && !namesUnsafeIri(write.removed) && !namesUnsafeIri(write.added);
    case 'match':
      return ![write.subject, write.object].some((term) => term !== undefined && isComparedLoosely(term))
        && ![write.subject, write.predicate, write.object].some((term) => term !== undefined && (isBracketedIri(term) || isUnsafeIri(term)));
    case 'subject':
      return !isComparedLoosely(write.subject) && ![write.subject, write.predicate].some((term) => term !== undefined && (isBracketedIri(term) || isUnsafeIri(term)))
        && !unreadable(write.quads) && !namesUnsafeIri(write.quads);
    case 'graph': return !unreadable(write.quads) && !namesUnsafeIri(write.quads);
    case 'all': return write.parts.every((part) => isExactRegistryWrite(contextGraphId, part));
    default: return true;
  }
}

/**
 * A literal, compared by lexical form, or a blank node, whose label in a
 * write is not the one the store reports: a removal naming either can only
 * be checked by reading the facts again.
 */
function isComparedLoosely(term: string): boolean {
  return term.startsWith('"') || term.startsWith('_:');
}

/** A term that is no literal and no blank node, and that is no IRI a query can carry as written. */
function isUnsafeIri(term: string): boolean {
  if (term.startsWith('"') || term.startsWith('_:')) return false;
  try {
    assertSafeIri(unwrapIri(term));
    return false;
  } catch {
    return true;
  }
}

/** An IRI written in angle brackets: a SPARQL adapter takes it as the IRI, the embedded engine's own delete skips it. */
function isBracketedIri(term: string): boolean {
  return term.startsWith('<') && term.endsWith('>');
}

/**
 * Before a write, the stored names of the subjects it types as sub-graphs in a
 * context graph's `_meta` graph that the cached facts do not type: the facts
 * hold the names of typed subjects only. `undefined` when one of them is no
 * IRI the query can name, so only reading the facts again after the write
 * tells.
 */
export async function readNamesOfNewSubGraphs(
  store: TripleStore,
  contextGraphId: string,
  facts: readonly ReadGraphRegistryFact[],
  write: ReadGraphRegistryWrite,
  options: QueryOptions = {},
): Promise<ReadGraphRegistryFact[] | undefined> {
  const meta = contextGraphMetaUri(contextGraphId);
  const typed = new Set(facts.filter((fact) => fact.graph === meta && isSubGraphType(fact)).map((fact) => fact.subject));
  const subjects = [...new Set(registryFactsAmong(addedQuadsOf(write))
    .filter((fact) => fact.graph === meta && isSubGraphType(fact) && !typed.has(fact.subject)).map((fact) => fact.subject))];
  if (subjects.length === 0) return [];
  // A blank node has no name a query can use: only reading the facts after the write tells.
  if (subjects.some((subject) => subject.startsWith('_:'))) return undefined;
  let values: string;
  try {
    values = subjects.map((subject) => `<${assertSafeIri(subject)}>`).join(' ');
  } catch {
    return undefined;
  }
  const result = await store.query(`SELECT ?s ?o WHERE { VALUES ?s { ${values} } GRAPH <${assertSafeIri(meta)}> { ?s <${P.name}> ?o } }`, {
    ...(options.priority ? { priority: options.priority } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    source: 'storage.readGraphRegistry',
  });
  if (result.type !== 'bindings') throw new Error('The read-graph registry query expected bindings');
  return result.bindings.flatMap((row) => row.s && row.o !== undefined
    ? [{ graph: meta, subject: row.s, predicate: P.name, object: row.o }] : []);
}

/** Whether two registries give the same membership. */
export function sameRegistry(left: ReadGraphRegistrySnapshot, right: ReadGraphRegistrySnapshot): boolean {
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, i) => value === b[i]);
  return same([...left.subGraphNames].sort(), [...right.subGraphNames].sort())
    && same([...left.childContextGraphRoots].sort(), [...right.childContextGraphRoots].sort());
}

/** The quads that are registry facts: any of the registry predicates, with a class object for `rdf:type`. */
function registryFactsAmong(quads: readonly Quad[]): ReadGraphRegistryFact[] {
  return quads.flatMap((quad) => {
    const fact = { graph: quad.graph, subject: unwrapIri(quad.subject), predicate: unwrapIri(quad.predicate), object: storedTerm(quad.object) };
    return isRegistryPredicate(fact.predicate, fact.object) && registryOwnersOfGraph(fact.graph).length > 0 ? [fact] : [];
  });
}

const REGISTRY_PREDICATES: ReadonlySet<string> = new Set([P.type, P.name, P.authenticatedSubGraphName, P.registrationStatus]);

function isRegistryPredicate(predicate: string, object: string): boolean {
  if (predicate === P.type) return object === P.subGraphClass || object === P.contextGraphClass;
  return predicate === P.name || predicate === P.authenticatedSubGraphName || predicate === P.registrationStatus;
}

/** The registry facts among `quads` that a context graph's registry is read from: its own `_meta`, and its children's. */
function ownerFactsAmong(contextGraphId: string, quads: readonly Quad[]): ReadGraphRegistryFact[] {
  const meta = contextGraphMetaUri(contextGraphId);
  const childPrefix = `${contextGraphDataUri(contextGraphId)}/`;
  return registryFactsAmong(quads).filter((fact) => fact.graph === meta
    || (isChildFact(fact) && fact.graph === `${fact.subject}${META_SUFFIX}` && fact.subject.startsWith(childPrefix)));
}

/** The quads a write adds. */
function addedQuadsOf(write: ReadGraphRegistryWrite): readonly Quad[] {
  switch (write.kind) {
    case 'quads': return write.added;
    case 'graph': case 'subject': return write.quads;
    case 'all': return write.parts.flatMap(addedQuadsOf);
    default: return [];
  }
}

function isSubGraphType(fact: { readonly predicate: string; readonly object: string }): boolean {
  return fact.predicate === P.type && fact.object === P.subGraphClass;
}

function isChildFact(fact: ReadGraphRegistryFact): boolean {
  return (fact.predicate === P.type && fact.object === P.contextGraphClass) || fact.predicate === P.registrationStatus;
}

/** A cached fact and a quad name the same triple. */
function sameFact(fact: ReadGraphRegistryFact, quad: Quad): boolean {
  return fact.graph === quad.graph && fact.subject === unwrapIri(quad.subject) && fact.predicate === unwrapIri(quad.predicate)
    && sameObject(fact.object, storedTerm(quad.object));
}

/**
 * Two objects name the same term: IRIs and blank nodes exactly, and literals
 * by their lexical form, which can only over-count; a write that removes a
 * literal is read again after it ({@link isExactRegistryWrite}). A literal
 * never equals an IRI with the same text.
 */
function sameObject(left: string, right: string): boolean {
  const literal = left.startsWith('"');
  if (literal !== right.startsWith('"')) return false;
  return literal ? lexical(left) === lexical(right) : left === right;
}

/**
 * A term as the stores report it: an IRI without the angle brackets the
 * adapters also accept, and a literal in the canonical form of the adapters'
 * query results, its escapes decoded (`"\u0064ocs"` is `"docs"`). A literal
 * that does not parse stays as written.
 */
function storedTerm(term: string): string {
  return term.startsWith('"') ? canonicalizeRdfObjectTerm(term) : unwrapIri(term);
}

function lexical(term: string): string {
  return term.startsWith('"') ? term.replace(/^"/, '').replace(/"(?:\^\^<[^>]+>|@[a-zA-Z-]+)?$/, '') : term;
}
