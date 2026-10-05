import { checkWorkspaceDraftReplacementOrder, workspacePublisherOperationTimestamp } from '../src/workspace-draft-replacement.js';
import { isWorkspacePublisherClockEligible, normalizeWorkspaceOperationProvenance } from '../src/workspace-operation-equivalence.js';
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphManager, OxigraphStore, UnsupportedTripleStoreCapabilityError, type Quad } from '@origintrail-official/dkg-storage';
import { resolveKnowledgeAssetWorkspaceHead, storeKnowledgeAssetOperationPublicQuads, storeKnowledgeAssetWorkspaceHead } from '../src/workspace-resolution.js';
import { workspaceOperationSubject } from '../src/workspace-metadata-subjects.js';
import { persistWorkspaceOperationEvidence, readAuthenticatedWorkspaceOperations, workspaceOperationAlias } from '../src/workspace-operation-alias.js';

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
  it.each([2n, 3n])('keeps colliding operation URIs independently authenticated for version %s replacement', async incomingVersion => {
    const store = new OxigraphStore(); stores.push(store);
    const graphManager = new GraphManager(store);
    const a = { contextGraphId: 'a:b', shareOperationId: 'c', kaUal: 'did:dkg:31337/0x1111111111111111111111111111111111111111/7' };
    const b = { contextGraphId: 'a', shareOperationId: 'b:c', kaUal: 'did:dkg:31337/0x1111111111111111111111111111111111111111/8' };
    expect(workspaceOperationSubject(a.contextGraphId, a.shareOperationId)).toBe(workspaceOperationSubject(b.contextGraphId, b.shareOperationId));
    const write = async (identity: typeof a, assertionVersion: bigint, value: string, at: string) => {
      await storeKnowledgeAssetOperationPublicQuads({ store, graphManager, ...identity, assertionVersion,
        publisherPeerId: 'publisher', timestamp: new Date(at),
        quads: [{ subject: 'urn:test:content', predicate: 'urn:test:value', object: JSON.stringify(value), graph: '' }] });
      await storeKnowledgeAssetWorkspaceHead({ store, graphManager, ...identity, assertionVersion });
    };
    await write(a, 3n, 'draft-a', '2026-10-04T10:00:00Z');
    await write(b, 3n, 'draft-b', '2026-10-04T11:00:00Z');
    const headA = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager, ...a });
    const headB = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager, ...b });
    expect(headA!.operationAliases[0].publisherChronologyAuthenticated).toBe(true);
    expect(headB!.operationAliases[0].publisherChronologyAuthenticated).toBe(true);
    expect(await checkWorkspaceDraftReplacementOrder({ head: headA!, incomingVersion, publisherPeerId: 'publisher',
      timestamp: new Date('2026-10-04T12:00:00Z'), readConfirmedVersion: async () => 1n })).toBeUndefined();
    await write(a, incomingVersion, 'replacement-a', '2026-10-04T12:00:00Z');
    expect((await resolveKnowledgeAssetWorkspaceHead({ store, graphManager, ...a }))!.operationAliases[0].publisherChronologyAuthenticated).toBe(true);
    expect((await resolveKnowledgeAssetWorkspaceHead({ store, graphManager, ...b }))!.operationAliases[0].publisherChronologyAuthenticated).toBe(true);
  });

  it("does not reuse another metadata graph's authentication for identical operation rows", async () => {
    const f = await fixture();
    expect(await readAuthenticatedWorkspaceOperations(f.store, `${GRAPH}:other`, f.loaded)).toEqual(new Set());
  });
  it.each(['empty', 'mixed-subject', 'mixed-graph'] as const)('rejects %s immutable evidence rows before any write', async shape => {
    const store = new OxigraphStore(); stores.push(store);
    const input = shape === 'empty' ? [] : rows().map((row, index) => index === 0
      ? shape === 'mixed-graph' ? { ...row, graph: `${GRAPH}:other` } : { ...row, subject: `${SUBJECT}:other` }
      : row);
    const insert = vi.spyOn(store, 'insert'), replace = vi.spyOn(store, 'replaceSubject');
    await expect(persistWorkspaceOperationEvidence(store, input)).rejects.toThrow('Invalid immutable operation evidence');
    expect(insert).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
  });

  it.each([true, false])('keeps decoded and projected chronology authentication explicitly %s', authenticated => {
    const alias = workspaceOperationAlias({ provenance: { shareOperationId: 'publisher-alias', publishedAtMs: 2000, publisherChronologyAuthenticated: authenticated }, snapshotLocator: { kind: 'store', ref: 'sha256:content' } });
    expect(alias.publisherChronologyAuthenticated).toBe(authenticated);
    expect(normalizeWorkspaceOperationProvenance(alias).publisherChronologyAuthenticated).toBe(authenticated);
    expect(isWorkspacePublisherClockEligible(normalizeWorkspaceOperationProvenance(alias))).toBe(true);
    expect(workspacePublisherOperationTimestamp([alias, { ...alias, shareOperationId: 'storage-ack-local', publishedAt: '9000', publisherChronologyAuthenticated: true }])).toBe(authenticated ? 2000 : undefined);
  });
  it.each([undefined, NaN, Infinity, -Infinity])('refuses a publisher clock that is not finite: %s', publishedAtMs => {
    const provenance = { shareOperationId: 'publisher-alias', publishedAtMs, publisherChronologyAuthenticated: true };
    expect(isWorkspacePublisherClockEligible(provenance)).toBe(false);
    expect(workspacePublisherOperationTimestamp([{ shareOperationId: provenance.shareOperationId, publishedAt: publishedAtMs, publisherChronologyAuthenticated: true }])).toBeUndefined();
  });
  it('normalizes compatibility aliases before policy rather than erasing decoded evidence', () => {
    const legacy = { shareOperationId: 'legacy-publisher', publishedAt: '1000' };
    expect(normalizeWorkspaceOperationProvenance(legacy)).toEqual({ shareOperationId: legacy.shareOperationId, publishedAtMs: 1000, publisherChronologyAuthenticated: true });
    expect(workspacePublisherOperationTimestamp([legacy])).toBe(1000);
  });
  it('preserves the existing digest of canonical rows across timestamp formatting, ordering and duplicates', async () => {
    const f = await fixture([...rows().reverse(), ...rows()]);
    const result = await f.store.query(`SELECT ?digest WHERE { GRAPH <${EVIDENCE_GRAPH}> { ?e ?p ?digest } }`);
    expect(result.type === 'bindings' ? result.bindings : []).toEqual([{ digest: JSON.stringify(CANONICAL_DIGEST) }]);
    expect(await readAuthenticatedWorkspaceOperations(f.store, GRAPH, f.loaded)).toEqual(new Set([SUBJECT]));
  });

  it('refreshes evidence in one native subject transaction without exposing an empty subject or touching siblings', async () => {
    const f = await fixture(), sibling = rows().map(row => ({ ...row, subject: `${SUBJECT}:sibling` }));
    await persistWorkspaceOperationEvidence(f.store, sibling);
    const changed = rows().map(row => row.predicate === `${DKG}publisherPeerId` ? { ...row, object: '"next-peer"' } : row);
    const embedded = (f.store as unknown as { store: { update: (sparql: string) => void } }).store;
    const update = vi.spyOn(embedded, 'update');
    const remove = vi.spyOn(f.store, 'deleteByPatternWithoutCount');
    const insert = vi.spyOn(f.store, 'insert');
    await persistWorkspaceOperationEvidence(f.store, changed);
    expect(await readAuthenticatedWorkspaceOperations(f.store, GRAPH, changed)).toEqual(new Set([SUBJECT]));
    expect(await readAuthenticatedWorkspaceOperations(f.store, GRAPH, f.loaded)).toEqual(new Set());
    expect(await readAuthenticatedWorkspaceOperations(f.store, GRAPH, sibling)).toEqual(new Set([`${SUBJECT}:sibling`]));
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0][0]).toContain('DELETE WHERE');
    expect(update.mock.calls[0][0]).toContain('INSERT DATA');
    expect(remove).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('retains prior evidence when the native atomic replacement fails and never falls back after execution failure', async () => {
    const f = await fixture();
    const changed = rows().map(row => row.predicate === `${DKG}publisherPeerId` ? { ...row, object: '"next-peer"' } : row);
    const embedded = (f.store as unknown as { store: { update: (sparql: string) => void } }).store;
    const nativeUpdate = embedded.update.bind(embedded);
    // LOAD fails after the DELETE/INSERT within the real native transaction. A fallback
    // insert outage reproduces the destructive delete/insert predecessor.
    const update = vi.spyOn(embedded, 'update').mockImplementationOnce(sparql => nativeUpdate(`${sparql}; LOAD <urn:test:unavailable-operation-evidence>`));
    const insert = vi.spyOn(f.store, 'insert').mockRejectedValueOnce(new Error('Evidence insertion unavailable'));
    await expect(persistWorkspaceOperationEvidence(f.store, changed)).rejects.toThrow();
    expect(await readAuthenticatedWorkspaceOperations(f.store, GRAPH, f.loaded)).toEqual(new Set([SUBJECT]));
    expect(await readAuthenticatedWorkspaceOperations(f.store, GRAPH, changed)).toEqual(new Set());
    expect(update).toHaveBeenCalledOnce();
    expect(insert).not.toHaveBeenCalled();
  });

  it.each(['absent', 'refused'] as const)('keeps canonical digest refresh and sibling evidence with %s atomic capability', async mode => {
    const f = await fixture(), sibling = rows().map(row => ({ ...row, subject: `${SUBJECT}:sibling` }));
    await persistWorkspaceOperationEvidence(f.store, sibling);
    const changed = rows().map(row => row.predicate === `${DKG}publisherPeerId` ? { ...row, object: '"next-peer"' } : row);
    const refuse = vi.fn(async () => { throw new UnsupportedTripleStoreCapabilityError('replaceSubject', 'EvidenceTestStore'); });
    const store = new Proxy(f.store, { get(target, property) {
      if (property === 'replaceSubject') return mode === 'absent' ? undefined : refuse;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const remove = vi.spyOn(f.store, 'deleteByPatternWithoutCount');
    await persistWorkspaceOperationEvidence(store, changed);
    expect(await readAuthenticatedWorkspaceOperations(f.store, GRAPH, changed)).toEqual(new Set([SUBJECT]));
    expect(await readAuthenticatedWorkspaceOperations(f.store, GRAPH, f.loaded)).toEqual(new Set());
    expect(await readAuthenticatedWorkspaceOperations(f.store, GRAPH, sibling)).toEqual(new Set([`${SUBJECT}:sibling`]));
    expect(remove).toHaveBeenCalledOnce();
    expect(remove.mock.calls[0][0]).toEqual({ graph: EVIDENCE_GRAPH, subject: `urn:dkg:publisher:operation-evidence:${encodeURIComponent(GRAPH)}:${encodeURIComponent(SUBJECT)}` });
    expect(refuse).toHaveBeenCalledTimes(mode === 'refused' ? 1 : 0);
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
    expect(await readAuthenticatedWorkspaceOperations(f.store, GRAPH, f.loaded)).toEqual(new Set([SUBJECT]));
    const altered = [...f.loaded, { subject: SUBJECT, predicate: `${DKG}recoveredOperationChronology`, object: '"true"', graph: GRAPH }];
    expect(await readAuthenticatedWorkspaceOperations(f.store, GRAPH, altered)).toEqual(new Set());
  });

  it('uses the canonical parser for an adapter-escaped persisted digest literal', async () => {
    const f = await fixture(), query = f.store.query.bind(f.store);
    vi.spyOn(f.store, 'query').mockImplementationOnce(async (sparql, options) => {
      const result = await query(sparql, options);
      if (result.type !== 'bindings') return result;
      const escaped = `"\\u${CANONICAL_DIGEST.charCodeAt(0).toString(16).padStart(4, '0')}${CANONICAL_DIGEST.slice(1)}"`;
      return { ...result, bindings: result.bindings.map(row => ({ ...row, digest: escaped })) };
    });
    expect(await readAuthenticatedWorkspaceOperations(f.store, GRAPH, f.loaded)).toEqual(new Set([SUBJECT]));
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
    expect(await readAuthenticatedWorkspaceOperations(f.store, GRAPH, f.loaded)).toEqual(new Set());
  });

  it.each(['subject', 'predicate', 'peer case', 'clock'])('withholds authentication when %s changes', async field => {
    const f = await fixture();
    const changed = f.loaded.map(row => field === 'subject' ? { ...row, subject: 'urn:test:another-operation' }
      : field === 'predicate' && row.predicate === `${DKG}assertionVersion` ? { ...row, predicate: 'urn:test:other-predicate' }
      : field === 'peer case' && row.predicate === `${DKG}publisherPeerId` ? { ...row, object: '"Peer"' }
      : field === 'clock' && row.predicate === `${DKG}publishedAt` ? { ...row, object: '"2026-10-04T10:00:01Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' } : row);
    expect(await readAuthenticatedWorkspaceOperations(f.store, GRAPH, changed)).toEqual(new Set());
  });
});
