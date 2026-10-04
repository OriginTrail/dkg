// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { persistWorkspaceOperationEvidence, readAuthenticatedWorkspaceOperations, RECOVERED_OPERATION_CHRONOLOGY } from '../src/workspace-operation-alias.js';

const SUBJECT = 'urn:test:operation', GRAPH = 'urn:test:operation-meta', DKG = 'http://dkg.io/ontology/';
const EVIDENCE_GRAPH = 'urn:dkg:publisher:authenticated-operation-evidence';
const CANONICAL_DIGEST = 'ba03321f4a36f03215e74779c65fed4cc504dbf1fa8d73db4f8ad7f897ad520c';
const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map(store => store.close())); });
const rows = (): Quad[] => [
  { subject: SUBJECT, predicate: `${DKG}publisherPeerId`, object: '"peer"', graph: GRAPH },
  { subject: SUBJECT, predicate: `${DKG}publishedAt`, object: '"2026-10-04T10:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>', graph: GRAPH },
  { subject: SUBJECT, predicate: `${DKG}assertionVersion`, object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: GRAPH },
  { subject: SUBJECT, predicate: 'urn:test:literal', object: '"label"', graph: GRAPH },
];
async function fixture(input = rows()) {
  const store = new OxigraphStore(); stores.push(store);
  await persistWorkspaceOperationEvidence(store, input); await store.insert(input);
  const loaded = await store.query(`CONSTRUCT { <${SUBJECT}> ?p ?o } WHERE { GRAPH <${GRAPH}> { <${SUBJECT}> ?p ?o } }`);
  if (loaded.type !== 'quads') throw new Error('Operation metadata unavailable');
  return { store, loaded: loaded.quads };
}

describe('canonical operation evidence round trips', () => {
  it('preserves the existing digest of canonical rows across timestamp formatting, ordering and duplicates', async () => {
    const f = await fixture([...rows().reverse(), ...rows()]);
    const result = await f.store.query(`SELECT ?digest WHERE { GRAPH <${EVIDENCE_GRAPH}> { <${SUBJECT}> ?p ?digest } }`);
    expect(result.type === 'bindings' ? result.bindings : []).toEqual([{ digest: JSON.stringify(CANONICAL_DIGEST) }]);
    expect(await readAuthenticatedWorkspaceOperations(f.store, f.loaded)).toEqual(new Set([SUBJECT]));
  });

  it.each([
    ['Unicode peer escape', `${DKG}publisherPeerId`, String.raw`"pe\u0065r"`],
    ['escaped string datatype', `${DKG}publisherPeerId`, String.raw`"peer"^^<http://www.w3.org/2001/XMLSchema#str\u0069ng>`],
    ['tab escape', 'urn:test:literal', String.raw`"tab\tvalue"`],
    ['integer lexical form', `${DKG}assertionVersion`, '"+001"^^<http://www.w3.org/2001/XMLSchema#integer>'],
    ['timezone equivalent', `${DKG}publishedAt`, '"2026-10-04T12:00:00+02:00"^^<http://www.w3.org/2001/XMLSchema#dateTime>'],
    ['escaped timestamp', `${DKG}publishedAt`, String.raw`"2026-10-04T10:00:\u0030\u0030.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>`],
  ])('retains authenticated chronology after %s passes through the actual store', async (_label, predicate, object) => {
    const f = await fixture(rows().map(row => row.predicate === predicate ? { ...row, object } : row));
    expect(await readAuthenticatedWorkspaceOperations(f.store, f.loaded)).toEqual(new Set([SUBJECT]));
    const recovered = [...f.loaded, { subject: SUBJECT, predicate: RECOVERED_OPERATION_CHRONOLOGY, object: '"true"', graph: GRAPH }];
    expect(await readAuthenticatedWorkspaceOperations(f.store, recovered)).toEqual(new Set([SUBJECT]));
  });

  it('uses the canonical parser for an adapter-escaped persisted digest literal', async () => {
    const f = await fixture(), query = f.store.query.bind(f.store);
    vi.spyOn(f.store, 'query').mockImplementationOnce(async (sparql, options) => {
      const result = await query(sparql, options);
      if (result.type !== 'bindings') return result;
      const escaped = `"\\u${CANONICAL_DIGEST.charCodeAt(0).toString(16).padStart(4, '0')}${CANONICAL_DIGEST.slice(1)}"`;
      return { ...result, bindings: result.bindings.map(row => ({ ...row, digest: escaped })) };
    });
    expect(await readAuthenticatedWorkspaceOperations(f.store, f.loaded)).toEqual(new Set([SUBJECT]));
  });

  it.each(['malformed', 'language', 'ambiguous'])('withholds authentication for %s persisted evidence', async mode => {
    const f = await fixture(), query = f.store.query.bind(f.store);
    vi.spyOn(f.store, 'query').mockImplementationOnce(async (sparql, options) => {
      const result = await query(sparql, options);
      if (result.type !== 'bindings') return result;
      const bindings = mode === 'ambiguous' ? [...result.bindings, ...result.bindings]
        : result.bindings.map(row => ({ ...row, digest: mode === 'language' ? `${row.digest}@en` : CANONICAL_DIGEST }));
      return { ...result, bindings };
    });
    expect(await readAuthenticatedWorkspaceOperations(f.store, f.loaded)).toEqual(new Set());
  });

  it.each(['subject', 'predicate', 'peer case', 'clock'])('withholds authentication when %s changes', async field => {
    const f = await fixture();
    const changed = f.loaded.map(row => field === 'subject' ? { ...row, subject: 'urn:test:another-operation' }
      : field === 'predicate' && row.predicate === `${DKG}assertionVersion` ? { ...row, predicate: 'urn:test:other-predicate' }
      : field === 'peer case' && row.predicate === `${DKG}publisherPeerId` ? { ...row, object: '"Peer"' }
      : field === 'clock' && row.predicate === `${DKG}publishedAt` ? { ...row, object: '"2026-10-04T10:00:01Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' } : row);
    expect(await readAuthenticatedWorkspaceOperations(f.store, changed)).toEqual(new Set());
  });
});
