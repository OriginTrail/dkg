// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import { assertSafeIri, assertionLifecycleUri, contextGraphMetaUri, escapeSparqlLiteral, MAX_ROOTLESS_KA_NUMBER_V1 } from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { TripleStore } from '@origintrail-official/dkg-storage';

export const ASSERTION_RESERVATION_PREDICATES = {
  owner: 'http://www.w3.org/ns/prov#wasAttributedTo',
  name: 'http://dkg.io/ontology/assertionName',
  number: 'http://dkg.io/ontology/kaId',
  ual: 'http://dkg.io/ontology/reservedUal',
  subGraphName: 'http://dkg.io/ontology/subGraphName',
} as const;

export interface AssertionLifecycleRecord {
  readonly bindings: ReadonlyArray<Readonly<{ p: string; o: string }>>;
  readonly hasKaId: boolean;
  readonly number?: bigint;
  readonly reservedUal?: string;
}

/** Shared RDF reservation fields for normal named operations and confirmed reconciliation. */
export function decodeAssertionReservationValue(predicate: string, term: string): string | undefined {
  const literal = parseRdfLiteralTerm(term);
  const numeric = predicate === 'http://dkg.io/ontology/kaId' || predicate === 'http://dkg.io/ontology/contentScopeVersion';
  if (literal) {
    if (literal.kind === 'language' || (literal.kind === 'typed' && literal.datatype !== `http://www.w3.org/2001/XMLSchema#${numeric ? 'integer' : 'string'}`)) return undefined;
    return literal.value;
  }
  if (numeric) return /^(0|[1-9][0-9]*)$/.test(term) ? term : undefined;
  return predicate === 'http://dkg.io/ontology/reservedUal' || predicate === 'http://www.w3.org/ns/prov#wasAttributedTo'
    ? term.replace(/^<|>$/g, '') : undefined;
}

/** Preserve the ordinary lifecycle reader's accepted historical UAL terms. */
export function decodeStoredAssertionReservedUal(term: string): string {
  return (decodeAssertionReservationValue(ASSERTION_RESERVATION_PREDICATES.ual, term)
    ?? term.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '')).trim();
}

/** One identity decoder. Reservations require exact RDF integers; ordinary
 * legacy reads retain their historical permissive numeric-literal policy. */
export async function readAssertionLifecycleRecord(
  store: TripleStore, contextGraphId: string, author: string, name: string,
  subGraphName?: string, policy: 'legacy' | 'strict-reservation' = 'legacy',
): Promise<AssertionLifecycleRecord> {
  const lifecycle = assertSafeIri(assertionLifecycleUri(contextGraphId, author, name, subGraphName));
  const result = await store.query(`SELECT ?p ?o WHERE { GRAPH <${assertSafeIri(contextGraphMetaUri(contextGraphId))}> { <${lifecycle}> ?p ?o } }`);
  const corrupt = () => Object.assign(new Error('Cannot verify the existing lifecycle KA reservation'), { code: 'KA_WM_LIFECYCLE_CORRUPT' });
  if (result.type !== 'bindings' && policy === 'strict-reservation') throw corrupt();
  const bindings = result.type === 'bindings' ? result.bindings.filter((r): r is { p: string; o: string } => typeof r.p === 'string' && typeof r.o === 'string') : [];
  if (result.type === 'bindings' && policy === 'strict-reservation' && bindings.length !== result.bindings.length) throw corrupt();
  return decodeAssertionLifecycleRecord(bindings, policy);
}

export function decodeAssertionLifecycleRecord(
  bindings: AssertionLifecycleRecord['bindings'], policy: 'legacy' | 'strict-reservation' = 'legacy',
): AssertionLifecycleRecord {
  const corrupt = () => Object.assign(new Error('Cannot verify the existing lifecycle KA reservation'), { code: 'KA_WM_LIFECYCLE_CORRUPT' });
  const ids = bindings.filter(r => r.p === 'http://dkg.io/ontology/kaId');
  const raw = ids[0]?.o;
  let number: bigint | undefined;
  if (policy === 'strict-reservation' && bindings.length > 0) {
    const value = raw === undefined ? undefined : decodeAssertionReservationValue('http://dkg.io/ontology/kaId', raw);
    if (ids.length !== 1 || value === undefined || value !== value.trim() || !/^(0|[1-9][0-9]*)$/.test(value)) throw corrupt();
    number = BigInt(value);
    if (number > MAX_ROOTLESS_KA_NUMBER_V1) throw corrupt();
  } else {
    const match = raw?.match(/(\d+)/);
    if (match) number = BigInt(match[1]);
  }
  const ual = bindings.find(r => r.p === 'http://dkg.io/ontology/reservedUal')?.o;
  const reservedUal = ual === undefined ? undefined : decodeStoredAssertionReservedUal(ual);
  return { bindings, hasKaId: ids.length > 0, number, reservedUal };
}

/** Legacy lifecycle subjects preserve caller spelling; layer graphs do not. */
export function assertionLifecycleAuthorCandidates(author: string): string[] {
  return /^0x[0-9a-fA-F]{40}$/.test(author)
    ? [...new Set([author, ethers.getAddress(author.toLowerCase()), author.toLowerCase()])]
    : [author];
}

/** Read every case-equivalent subject in one snapshot so repair can reject ambiguity. */
export async function readAssertionLifecycleCandidates(
  store: TripleStore, contextGraphId: string, author: string, name: string, subGraphName?: string,
): Promise<Array<{ author: string; subject: string; record: AssertionLifecycleRecord }>> {
  const candidates = assertionLifecycleAuthorCandidates(author).map(address => ({ author: address,
    subject: assertSafeIri(assertionLifecycleUri(contextGraphId, address, name, subGraphName)) }));
  // sparql-scan-allow: R4 -- VALUES binds at most three exact lifecycle subjects (address case aliases); never a graph-wide scan.
  const result = await store.query(`SELECT ?subject ?p ?o WHERE {
    VALUES ?subject { ${candidates.map(c => `<${c.subject}>`).join(' ')} }
    GRAPH <${assertSafeIri(contextGraphMetaUri(contextGraphId))}> { ?subject ?p ?o }
  }`, { source: 'publisher.lifecycle.candidates' });
  if (result.type !== 'bindings' || result.bindings.some(r => typeof r.subject !== 'string'
    || typeof r.p !== 'string' || typeof r.o !== 'string'
    || !candidates.some(c => c.subject === r.subject))) {
    throw Object.assign(new Error('Lifecycle facts unavailable'), { code: 'KA_WM_LIFECYCLE_CORRUPT' });
  }
  return candidates.flatMap(candidate => {
    const bindings = result.bindings.filter(r => r.subject === candidate.subject) as Array<{ p: string; o: string }>;
    return bindings.length ? [{ ...candidate, record: decodeAssertionLifecycleRecord(bindings, 'strict-reservation') }] : [];
  });
}

/** Resolve historical lifecycle spelling without changing stored subjects or mutation lanes. */
export async function resolveAssertionReadAuthor(
  store: TripleStore, contextGraphId: string, author: string, name: string, subGraphName?: string,
): Promise<string> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(author)) return author;
  const expected = assertSafeIri(assertionLifecycleUri(contextGraphId, author, name, subGraphName));
  const suffix = `:${name}`;
  const prefix = expected.slice(0, -author.length - suffix.length);
  const corrupt = () => Object.assign(new Error('Cannot resolve an unambiguous working-memory lifecycle author'),
    { code: 'KA_WM_LIFECYCLE_CORRUPT' });
  // Bound by the assertion-name predicate/value and exact meta graph. Only the
  // EVM segment is case-insensitive: graph IDs, names and subgraphs retain case.
  const result = await store.query(`SELECT DISTINCT ?subject WHERE {
    GRAPH <${assertSafeIri(contextGraphMetaUri(contextGraphId))}> {
      ?subject <http://dkg.io/ontology/assertionName> "${escapeSparqlLiteral(name)}" .
      FILTER(STRSTARTS(STR(?subject), "${escapeSparqlLiteral(prefix)}"))
      FILTER(STRENDS(STR(?subject), "${escapeSparqlLiteral(suffix)}"))
      FILTER(LCASE(STR(?subject)) = "${escapeSparqlLiteral(expected.toLowerCase())}")
    }
  }`, { source: 'publisher.assertion.read-author' });
  if (result.type !== 'bindings') throw corrupt();
  const authors = new Set<string>();
  for (const row of result.bindings) {
    const subject = row.subject;
    if (typeof subject !== 'string' || subject.length !== expected.length
      || !subject.startsWith(prefix) || !subject.endsWith(suffix)) throw corrupt();
    const storedAuthor = subject.slice(prefix.length, -suffix.length);
    if (storedAuthor.toLowerCase() !== author.toLowerCase()) throw corrupt();
    authors.add(storedAuthor);
  }
  if (authors.size > 1) throw corrupt();
  // An absent lifecycle retains the existing exact legacy-graph read behavior.
  return authors.values().next().value ?? author;
}
