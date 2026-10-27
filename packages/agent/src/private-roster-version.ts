// SPDX-License-Identifier: Apache-2.0

import { assertSafeIri, contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { tryUpdateWithTouchedGraphs, type Quad, type QueryOptions, type TripleStore } from '@origintrail-official/dkg-storage';

export const RFC64_PRIVATE_ROSTER_VERSION_PREDICATE_V1 = 'https://dkg.network/ontology#rfc64RosterVersion';
export const RFC64_PRIVATE_ROSTER_VERSION_RADIX_V1 = 10_000_000_000_000n;

/** Validate every held value, including obsolete ones, and convert each once. */
export async function readPrivateRosterGeneration(store: TripleStore, contextGraphId: string): Promise<string> {
  const subject = assertSafeIri(contextGraphDataGraphUri(contextGraphId));
  const graph = assertSafeIri(contextGraphMetaGraphUri(contextGraphId));
  const result = await store.query(`SELECT ?version WHERE { GRAPH <${graph}> {
    <${subject}> <${RFC64_PRIVATE_ROSTER_VERSION_PREDICATE_V1}> ?version .
  } }`, { source: 'agent.rfc64.privateRosterVersion' });
  if (result.type !== 'bindings') return '0';
  let newest = 0n;
  for (const row of result.bindings) {
    const raw = row['version'];
    if (typeof raw !== 'string') throw new Error('RFC-64 private roster version is not a literal');
    const lexical = raw.match(/^"([0-9]+)"(?:\^\^<[^>]+>)?$/u)?.[1]
      ?? (/^[0-9]+$/u.test(raw) ? raw : undefined);
    if (lexical === undefined || !/^(0|[1-9][0-9]*)$/u.test(lexical)) {
      throw new Error('RFC-64 private roster version is not canonical');
    }
    const value = BigInt(lexical);
    if (value >= RFC64_PRIVATE_ROSTER_VERSION_RADIX_V1) {
      throw new Error('RFC-64 private roster version exceeds its generation lane');
    }
    if (value > newest) newest = value;
  }
  return newest.toString(10);
}

/**
 * Only valid canonical generations are compactable. An invalid, out-of-lane,
 * or nonliteral value stays visible, so the reader continues to fail closed.
 */
function canonicalGeneration(variable: string): string {
  return `isLiteral(${variable}) && LANG(${variable}) = "" && REGEX(STR(${variable}), "^(0|[1-9][0-9]*)$")
    && xsd:integer(STR(${variable})) < ${RFC64_PRIVATE_ROSTER_VERSION_RADIX_V1}`;
}

/**
 * Keep the newest roster generation after a durable metadata page. The MAX
 * and delete execute in one server-side update, so a stale page cannot delete
 * or replace a newer concurrent generation. Only the exact root subject in
 * its own metadata graph is touched; unrelated sync writes do no extra I/O.
 * Stores without UPDATE retain the compatible additive behavior and reader.
 */
export async function compactSyncedPrivateRosterGenerations(
  store: TripleStore, quads: readonly Quad[], options?: QueryOptions,
): Promise<void> {
  const subjects = new Set(quads.filter(quad => (
    quad.predicate === RFC64_PRIVATE_ROSTER_VERSION_PREDICATE_V1
    && quad.subject.startsWith('did:dkg:context-graph:')
    && quad.graph === `${quad.subject}/_meta`
  )).map(quad => quad.subject));
  for (const subjectValue of subjects) {
    const subject = assertSafeIri(subjectValue);
    const graph = assertSafeIri(`${subject}/_meta`);
    await tryUpdateWithTouchedGraphs(store, `
      PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      DELETE { GRAPH <${graph}> { <${subject}> <${RFC64_PRIVATE_ROSTER_VERSION_PREDICATE_V1}> ?old . } }
      WHERE {
        { SELECT (MAX(xsd:integer(STR(?version))) AS ?newest) WHERE {
          GRAPH <${graph}> { <${subject}> <${RFC64_PRIVATE_ROSTER_VERSION_PREDICATE_V1}> ?version . }
          FILTER(${canonicalGeneration('?version')})
        } }
        GRAPH <${graph}> { <${subject}> <${RFC64_PRIVATE_ROSTER_VERSION_PREDICATE_V1}> ?old . }
        FILTER(${canonicalGeneration('?old')} && xsd:integer(STR(?old)) < ?newest)
      }
    `, [graph], { ...options, source: 'agent.rfc64.privateRosterVersion.compact' });
  }
}
