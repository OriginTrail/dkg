// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri, assertionLifecycleUri, contextGraphMetaUri, MAX_ROOTLESS_KA_NUMBER_V1 } from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { TripleStore } from '@origintrail-official/dkg-storage';

export interface AssertionLifecycleRecord {
  readonly bindings: ReadonlyArray<Readonly<{ p: string; o: string }>>;
  readonly hasKaId: boolean;
  readonly number?: bigint;
  readonly reservedUal?: string;
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
  const ids = bindings.filter(r => r.p === 'http://dkg.io/ontology/kaId');
  const raw = ids[0]?.o;
  let number: bigint | undefined;
  if (policy === 'strict-reservation' && bindings.length > 0) {
    const literal = raw === undefined ? null : parseRdfLiteralTerm(raw);
    const value = literal?.value ?? raw;
    if (ids.length !== 1 || value === undefined || value !== value.trim() || !/^(0|[1-9][0-9]*)$/.test(value)
      || literal?.kind === 'language'
      || (literal?.kind === 'typed' && literal.datatype !== 'http://www.w3.org/2001/XMLSchema#integer')) throw corrupt();
    number = BigInt(value);
    if (number > MAX_ROOTLESS_KA_NUMBER_V1) throw corrupt();
  } else {
    const match = raw?.match(/(\d+)/);
    if (match) number = BigInt(match[1]);
  }
  const ual = bindings.find(r => r.p === 'http://dkg.io/ontology/reservedUal')?.o;
  return { bindings, hasKaId: ids.length > 0, number,
    reservedUal: ual?.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '').trim() };
}
