// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKG_ONTOLOGY, contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { ContextGraphBindingState } from '../src/context-graph-binding-state.js';
import { runCuratorMetaRefreshFromPeer } from '../src/curator-meta-refresh.js';
import { parseMetadataRegistration } from '../src/internal/context-graph-authority/metadata-readiness.js';
import { buildAuthoritativePublicMetaQuads } from '../src/context-graph-public-meta-proof.js';

const CG = 'crash-consistent-curator';
const ROOT = contextGraphDataGraphUri(CG);
const META = contextGraphMetaGraphUri(CG);
const HASH = ethers.keccak256(ethers.toUtf8Bytes(CG));
const ID = `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`;
const NAME_HASH = `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainHash`;
const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); });

describe('curator metadata readiness protocol', () => {
  it('invalidates a captured generation for canonical authoritative A-B-A transitions', () => {
    const bindings = new ContextGraphBindingState();
    const original = { subscribed: true, onChainId: '1', onChainHash: HASH };
    const captured = bindings.capture(CG);
    bindings.applySubscriptionTransition(CG, original, { ...original, onChainId: '2' }, HASH);
    bindings.applySubscriptionTransition(CG, { ...original, onChainId: '2' }, original, HASH);
    expect(bindings.isGenerationCurrent(CG, captured)).toBe(false);
  });

  it('fences same-object authoritative ABA through primitive transition snapshots', () => {
    const bindings = new ContextGraphBindingState();
    const sub = { subscribed: true, onChainId: '1', onChainHash: HASH };
    bindings.applySubscriptionTransition(CG, undefined, sub, HASH);
    const captured = bindings.capture(CG);
    sub.onChainId = '2'; bindings.applySubscriptionTransition(CG, sub, sub, HASH);
    sub.onChainId = '1'; bindings.applySubscriptionTransition(CG, sub, sub, HASH);
    expect(bindings.isGenerationCurrent(CG, captured)).toBe(false);
  });

  it.each([
    [{ predicate: ID, value: '"1"' }],
    [{ predicate: NAME_HASH, value: `"${HASH}"` }],
    [{ predicate: ID, value: '"01"' }, { predicate: NAME_HASH, value: `"${HASH}"` }],
    [{ predicate: ID, value: '1' }, { predicate: NAME_HASH, value: `"${HASH}"` }],
    [{ predicate: ID, value: '"1"' }, { predicate: NAME_HASH, value: HASH }],
    [{ predicate: ID, value: '"1"' }, { predicate: ID, value: '"2"' }],
    [{ predicate: ID, value: '"1"' }, { predicate: NAME_HASH, value: '"corrupt"' }],
    [{ predicate: ID, value: '"1"' }, { predicate: NAME_HASH, value: `"${HASH}"` }, { predicate: ID, value: '"2"' }],
    [{ predicate: ID, value: `"${1n << 256n}"` }, { predicate: NAME_HASH, value: `"${HASH}"` }],
  ].map((rows) => ({ rows })))('rejects an incomplete or noncanonical registration claim %#', ({ rows }) => {
    expect(parseMetadataRegistration(rows)).toEqual({ kind: 'invalid' });
  });

  it('distinguishes absent registration from one valid paired claim', () => {
    expect(parseMetadataRegistration([])).toEqual({ kind: 'absent' });
    expect(parseMetadataRegistration([{ predicate: ID, value: '"1"' },
      { predicate: NAME_HASH, value: `"${HASH}"` }])).toEqual({ kind: 'registered', onChainId: '1', onChainHash: HASH });
  });

  it('retains a revocation arriving at the actual projection commit boundary', async () => {
    const store = new OxigraphStore(); stores.push(store);
    const revoked: Quad = { subject: ROOT, predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT,
      object: '"did:dkg:agent:revoked-during-refresh"', graph: META };
    const unrelated: Quad = { subject: `${ROOT}/knowledge-asset/91`, predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: 'urn:test:KnowledgeAsset', graph: META };
    await store.insert([unrelated]);
    const originalReplace = store.replaceSubject.bind(store);
    vi.spyOn(store, 'replaceSubject').mockImplementation(async (graph, subject, quads) => {
      if (graph === META && subject === ROOT) await store.insert([revoked]);
      return originalReplace(graph, subject, quads);
    });
    const originalUpdate = store.update.bind(store);
    vi.spyOn(store, 'update').mockImplementation(async (query, options) => {
      if (options?.source === 'agent.metaRefresh.replace') await store.insert([revoked]);
      return originalUpdate(query, options);
    });
    const snapshot = [...buildAuthoritativePublicMetaQuads(CG),
      { subject: ROOT, predicate: ID, object: '"1"', graph: META },
      { subject: ROOT, predicate: NAME_HASH, object: `"${HASH}"`, graph: META }];
    const sub = { subscribed: true, name: CG, syncMode: 'always-on' as const,
      onChainId: '1', onChainHash: HASH, metaSynced: true, synced: true };
    const agent = {
      store, peerId: 'local-peer', chain: { getContextGraphNameHash: async () => HASH }, config: {}, contextGraphBindingState: new ContextGraphBindingState(),
      subscribedContextGraphs: new Map([[CG, sub]]), metaRefreshTimestamps: new Map<string, number>(),
      node: { libp2p: { getConnections: () => [{ remotePeer: { toString: () => 'curator-peer' } }] } },
      syncCheckpoints: new Map<string, number>(),
      fetchSyncPages: async () => ({ quads: snapshot, checkpointKey: 'current-meta', completed: true, resumedFromOffset: 0 }),
      runContextGraphSyncWithBackpressure: async <T>(_ctx: unknown, _cg: string, _lane: string, _label: string, work: () => Promise<T>) => work(),
      oversizeTombstoneLog: { record: () => {} }, contextGraphMetaProjection: { markDirty: () => {} },
      invalidateListContextGraphsCache: () => {}, persistContextGraphSubscription: () => {},
      setContextGraphSubscription: (id: string, next: typeof sub) => {
        agent.contextGraphBindingState.applySubscriptionTransition(id, agent.subscribedContextGraphs.get(id), next, HASH);
        agent.subscribedContextGraphs.set(id, next); return next;
      },
      persistContextGraphSubscriptionProjectionStrict: async () => {},
      log: { warn: () => {}, info: () => {} },
    };
    expect(await runCuratorMetaRefreshFromPeer(agent, CG, 'curator-peer', { force: true })).toBe(true);
    const rows = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${META}> { ?s ?p ?o } }`);
    expect(rows.type).toBe('bindings');
    if (rows.type !== 'bindings') throw new Error('metadata query did not return bindings');
    expect(rows.bindings).toContainEqual({ s: revoked.subject, p: revoked.predicate, o: revoked.object });
    expect(rows.bindings).toContainEqual({ s: unrelated.subject, p: unrelated.predicate, o: unrelated.object });
  });
});
