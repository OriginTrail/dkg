// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, type ContextGraphOnChain } from '@origintrail-official/dkg-chain';
import {
  CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE, DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri, contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import type { ContextGraphSub, ContextGraphSubInput, ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';
import type { ContextGraphBindingState } from '../src/context-graph-binding-state.js';
import type { CursorState } from '../src/reconcile-cursor.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { runCuratorMetaRefreshFromPeer } from '../src/curator-meta-refresh.js';
import { buildAuthoritativePublicMetaQuads } from '../src/context-graph-public-meta-proof.js';
import { withSyncAdmissionSource } from '../src/sync/attempt-telemetry.js';

const LOCAL = 'automatic-discovery-owned-binding';
const HASH = ethers.keccak256(ethers.toUtf8Bytes(LOCAL)).toLowerCase();
const OWNED = '582';
const FOREIGN = '323';
const subject = contextGraphDataGraphUri(LOCAL);
const meta = contextGraphMetaGraphUri(LOCAL);
const ontology = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
interface Internals {
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  reconcileCursors: Map<string, CursorState>;
  contextGraphBindingState: ContextGraphBindingState;
  wireIdToLocalCgId: Map<string, string>;
  setContextGraphSubscription(id: string, next: ContextGraphSubInput, options?: { persist?: boolean }): ContextGraphSub;
  enqueueContextGraphSubscriptionPersistWrite(id: string, write: () => Promise<void>): Promise<void>;
  scheduleRfc64CatalogResponsibilityReconciliationV1(id: string): boolean;
}
const agents: DKGAgent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
  vi.restoreAllMocks();
});

async function fixture(active: boolean, bound = true) {
  const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: 323n });
  // Both actual native registry slots commit this name; intervening slots do not.
  for (let id = 323n; id <= 582n; id++) {
    await chain.createOnChainContextGraph({
      accessPolicy: 0, publishPolicy: 1, nameHash: id === 323n || id === 582n ? HASH : ethers.ZeroHash,
    });
  }
  let retained: ContextGraphSubscriptionRecord[] = [{
    id: LOCAL, name: LOCAL, subscribed: true, syncMode: 'always-on',
    onChainId: bound ? OWNED : undefined, onChainHash: bound ? HASH : undefined,
    synced: true, sharedMemorySynced: true, metaSynced: true, lastReconciledOrdinal: 7,
  }];
  const save = vi.fn(async (row: ContextGraphSubscriptionRecord) => {
    retained = [...retained.filter((old) => old.id !== row.id), { ...row }];
  });
  const remove = vi.fn(async (id: string) => { retained = retained.filter((row) => row.id !== id); });
  const agent = await DKGAgent.create({
    name: 'AutomaticDiscoveryFence', nodeRole: 'edge', chainAdapter: chain,
    contextGraphSubscriptionRehydrationEnabled: false,
    rfc64CatalogActivation: { enabled: false }, vmReconcilerEnabled: true,
    contextGraphSubscriptionStore: {
      loadAll: async () => retained.map((row) => ({ ...row })), save, delete: remove,
    },
  });
  agents.push(agent);
  const state = agent as unknown as Internals;
  // Native canonical methods need a peer identity for membership persistence;
  // this fixture starts no daemon, libp2p, wallet or provider.
  (agent as unknown as { node: unknown }).node = {
    peerId: '12D3KooWAutomaticDiscoveryFixture', libp2p: { getPeers: () => [] },
  };
  vi.spyOn(state, 'scheduleRfc64CatalogResponsibilityReconciliationV1').mockReturnValue(false);
  if (bound) await agent.rehydrateContextGraphSubscriptions(null);
  state.setContextGraphSubscription(LOCAL, {
    ...state.subscribedContextGraphs.get(LOCAL),
    subscribed: active, onChainId: bound ? OWNED : undefined,
    onChainHash: bound ? HASH : undefined, lastReconciledOrdinal: 7,
    name: LOCAL, syncMode: 'always-on',
  }, { persist: false });
  // Use native observation/claim proof owners, not a numeric resolver stub.
  for (const id of bound ? [FOREIGN, OWNED] : []) {
    agent.applyOnChainContextGraphObservation({
      contextGraphId: id, nameHash: HASH, owner: chain.getContextGraph(BigInt(id))!.manager,
      accessPolicy: 0, publishPolicy: 1, active: true, observedAtBlock: 100,
    }, { source: 'checkpoint' });
  }
  const drain = () => state.enqueueContextGraphSubscriptionPersistWrite(LOCAL, async () => undefined);
  await drain(); save.mockClear(); remove.mockClear();
  const cursor: CursorState = { watermark: 7, ahead: new Map([[9, 150]]), scanOrdinal: 10 };
  state.reconcileCursors.set(LOCAL, cursor);
  const saved = () => retained.map((row) => ({ ...row }));
  return { agent, chain, state, save, remove, drain, cursor, saved };
}

async function rawClaims(agent: DKGAgent) {
  const query = 'SELECT ?s ?p ?o ?g WHERE { VALUES ?g { <' + meta + '> <' + ontology
    + '> } GRAPH ?g { ?s ?p ?o } FILTER(?s = <' + subject + '>) } ORDER BY ?g ?p ?o';
  return agent.store.query(query, { source: 'test.automaticDiscovery.rawClaims' });
}

const cases = [false, true].flatMap((active) => [false, true].map((reverse) => ({ active, reverse })));
describe('automatic discovery retains exact Context Graph identity', () => {
  it.each(cases)('refuses store replacement active=$active reverse-claims=$reverse', async ({ active, reverse }) => {
    const f = await fixture(active);
    const claims = [
      { subject, predicate: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE, object: '"582"', graph: meta },
      { subject, predicate: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE, object: '"323"', graph: ontology },
    ];
    await f.agent.store.insert([
      { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontology },
      { subject, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"' + LOCAL + '"', graph: ontology },
      ...(reverse ? claims.reverse() : claims),
    ]);
    expect(f.agent.provenOnChainIdsFor(LOCAL).sort()).toEqual([FOREIGN, OWNED]);
    await expect(f.agent.getContextGraphOnChainId(LOCAL)).resolves.toBe(OWNED);
    const savedBefore = f.saved();
    const rowBefore = f.state.subscribedContextGraphs.get(LOCAL);
    const generation = f.state.contextGraphBindingState.capture(LOCAL);
    const rdfBefore = await rawClaims(f.agent);

    await f.agent.discoverContextGraphsFromStore();
    await f.drain();

    await expect(f.agent.getContextGraphOnChainId(LOCAL)).resolves.toBe(OWNED);
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toBe(rowBefore);
    expect(rowBefore).toMatchObject({ onChainId: OWNED, onChainHash: HASH, subscribed: active, lastReconciledOrdinal: 7 });
    expect(f.state.wireIdToLocalCgId.get(HASH)).toBe(LOCAL);
    expect(f.state.reconcileCursors.get(LOCAL)).toBe(f.cursor);
    expect(f.cursor).toEqual({ watermark: 7, ahead: new Map([[9, 150]]), scanOrdinal: 10 });
    expect(f.state.contextGraphBindingState.capture(LOCAL)).toBe(generation);
    expect(f.saved()).toEqual(savedBefore);
    expect(await rawClaims(f.agent)).toEqual(rdfBefore);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it.each([false, true])('refuses a foreign recorder tuple without persistence active=%s', async (active) => {
    const f = await fixture(active);
    const before = f.state.subscribedContextGraphs.get(LOCAL);
    const saved = f.saved();
    const result = f.agent.recordDiscoveredContextGraph(LOCAL, {
      name: 'Foreign identity metadata', onChainId: FOREIGN, onChainHash: HASH,
      participantAgents: ['0x2222222222222222222222222222222222222222'],
    });
    await f.drain();
    expect(result).toBe(before);
    expect(before).toMatchObject({ name: LOCAL, onChainId: OWNED, lastReconciledOrdinal: 7 });
    expect(f.state.reconcileCursors.get(LOCAL)).toBe(f.cursor);
    expect(f.saved()).toEqual(saved);
    expect(f.save).not.toHaveBeenCalled();
  });

  it.each([false, true])('allows same-slot metadata enrichment without resetting progress active=%s', async (active) => {
    const f = await fixture(active);
    f.agent.recordDiscoveredContextGraph(LOCAL, { name: 'Enriched same slot', onChainId: OWNED, onChainHash: HASH });
    await f.drain();
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({ name: 'Enriched same slot', onChainId: OWNED, lastReconciledOrdinal: 7 });
    expect(f.state.reconcileCursors.get(LOCAL)).toBe(active ? f.cursor : undefined);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.save.mock.calls.length > 0).toBe(active);
  });

  it('fills a missing canonical binding through the native recorder', async () => {
    const f = await fixture(false, false);
    f.agent.recordDiscoveredContextGraph(LOCAL, { onChainId: OWNED, onChainHash: HASH });
    await expect(f.agent.getContextGraphOnChainId(LOCAL)).resolves.toBe(OWNED);
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.onChainHash).toBe(HASH);
  });
});

describe('automatic chain and curator discovery retain owned binding', () => {
  it.each([false, true])('refuses chain inventory before RDF replacement active=%s', async (active) => {
    const f = await fixture(active);
    await f.agent.store.insert([
      { subject, predicate: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE, object: '"582"', graph: meta },
    ]);
    const before = await rawClaims(f.agent);
    const saved = f.saved();
    const row = f.state.subscribedContextGraphs.get(LOCAL);
    vi.spyOn(f.chain, 'listContextGraphsFromChain').mockResolvedValue([{
      contextGraphId: FOREIGN, name: LOCAL,
      creator: f.chain.getContextGraph(323n)!.manager,
      accessPolicy: 0, blockNumber: 100, metadataRevealed: true,
    }] satisfies ContextGraphOnChain[]);

    await expect(f.agent.discoverContextGraphsFromChain()).resolves.toBe(0);
    await f.drain();
    expect(await rawClaims(f.agent)).toEqual(before);
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toBe(row);
    expect(f.state.reconcileCursors.get(LOCAL)).toBe(f.cursor);
    expect(f.saved()).toEqual(saved);
    expect(f.save).not.toHaveBeenCalled();
  });

  it.each([
    { initial: undefined, observed: OWNED, refused: true },
    { initial: FOREIGN, observed: OWNED, refused: true },
    { initial: undefined, observed: FOREIGN, refused: false },
  ])('rechecks chain ownership after its native RDF read initial=$initial observed=$observed', async ({ initial, observed, refused }) => {
    const f = await fixture(true, false);
    f.state.setContextGraphSubscription(LOCAL, {
      ...f.state.subscribedContextGraphs.get(LOCAL)!,
      onChainId: initial, onChainHash: initial ? HASH : undefined,
    }, { persist: false });
    if (refused) await f.agent.store.insert([
      { subject, predicate: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE, object: '"582"', graph: meta },
    ]);
    const before = await rawClaims(f.agent);
    vi.spyOn(f.chain, 'listContextGraphsFromChain').mockResolvedValue([{
      contextGraphId: FOREIGN, name: LOCAL, creator: f.chain.getContextGraph(323n)!.manager,
      accessPolicy: 0, blockNumber: 100, metadataRevealed: true,
    }] satisfies ContextGraphOnChain[]);
    const query = f.agent.store.query.bind(f.agent.store);
    let currentAfterRead: ContextGraphSub | undefined;
    vi.spyOn(f.agent.store, 'query').mockImplementation(async (sparql, options) => {
      const result = await query(sparql, options);
      if (options?.source === 'agent.contextGraph.chainDiscovery.durableOnChainId') {
        // A verified owner changes the actual canonical row while discovery awaits.
        f.state.setContextGraphSubscription(LOCAL, {
          ...f.state.subscribedContextGraphs.get(LOCAL)!,
          onChainId: observed, onChainHash: HASH, lastReconciledOrdinal: 7,
        }, { persist: false });
        currentAfterRead = f.state.subscribedContextGraphs.get(LOCAL);
      }
      return result;
    });

    const count = await f.agent.discoverContextGraphsFromChain();
    await f.drain();
    if (refused) {
      expect(await rawClaims(f.agent)).toEqual(before);
      expect(count).toBe(0);
      expect(f.save).not.toHaveBeenCalled();
      expect(f.state.subscribedContextGraphs.get(LOCAL)).toBe(currentAfterRead);
    } else {
      expect(count).toBe(1);
      const rows = await rawClaims(f.agent);
      expect(rows.type).toBe('bindings');
      if (rows.type !== 'bindings') throw new Error('expected native bindings');
      expect(rows.bindings).toContainEqual({
        s: subject, p: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE, o: '"323"', g: ontology,
      });
    }
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
      onChainId: observed, subscribed: true, lastReconciledOrdinal: 7,
    });
  });

  async function curatorFixture(active: boolean, bound = true, incoming = FOREIGN) {
    const f = await fixture(active, bound);
    const peer = '12D3KooWNativeCuratorFixture';
    const nativeNode = (f.agent as unknown as { node: {
      libp2p: { getConnections?: () => unknown };
    } }).node;
    nativeNode.libp2p.getConnections = () => [{ remotePeer: { toString: () => peer } }];
    const quads = [
      ...buildAuthoritativePublicMetaQuads(LOCAL),
      { subject, predicate: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE, object: '"' + incoming + '"', graph: meta },
      { subject, predicate: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH + 'OnChainHash', object: '"' + HASH + '"', graph: meta },
    ];
    const fetch = vi.spyOn(f.agent as unknown as {
      fetchSyncPages(): Promise<SyncPageResult>;
    }, 'fetchSyncPages').mockResolvedValue({
      quads, checkpointKey: 'native-curator-binding-checkpoint',
      resumedFromOffset: 0, completed: true,
    } as SyncPageResult);
    const refresh = () => withSyncAdmissionSource('control-plane', () => (
      runCuratorMetaRefreshFromPeer(f.agent, LOCAL, peer, { force: true })
    ));
    return { ...f, quads, fetch, refresh };
  }

  it.each([false, true])('rejects a curator foreign slot before native RDF writes active=%s', async (active) => {
    const f = await curatorFixture(active);
    await f.agent.store.insert([
      ...buildAuthoritativePublicMetaQuads(LOCAL),
      { subject, predicate: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE, object: '"582"', graph: meta },
    ]);
    const before = await rawClaims(f.agent);
    const saved = f.saved();
    const row = f.state.subscribedContextGraphs.get(LOCAL);
    const generation = f.state.contextGraphBindingState.capture(LOCAL);
    const replace = vi.spyOn(f.agent.store, 'replaceSubject');

    await expect(f.refresh()).resolves.toBe(false);
    await f.drain();
    expect(replace).not.toHaveBeenCalled();
    expect(await rawClaims(f.agent)).toEqual(before);
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toBe(row);
    expect(row?.onChainId).toBe(OWNED);
    expect(f.state.contextGraphBindingState.capture(LOCAL)).toBe(generation);
    expect(f.state.reconcileCursors.get(LOCAL)).toBe(f.cursor);
    expect(f.saved()).toEqual(saved);
    expect(f.save).not.toHaveBeenCalled();
  });

  it.each([false, true])('accepts native curator late binding/same slot bound=%s', async (bound) => {
    const f = await curatorFixture(false, bound, OWNED);
    await expect(f.refresh()).resolves.toBe(true);
    await expect(f.agent.getContextGraphOnChainId(LOCAL)).resolves.toBe(OWNED);
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
      subscribed: false, onChainId: OWNED, onChainHash: HASH,
    });
    const stored = await rawClaims(f.agent);
    expect(stored.type).toBe('bindings');
    if (stored.type !== 'bindings') throw new Error('expected native RDF bindings');
    expect(stored.bindings).toContainEqual({
      s: subject, p: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE, o: '"582"', g: meta,
    });
  });

  it.each([false, true])('rejects every conflicting curator claim in either order reverse=%s', async (reverse) => {
    const f = await curatorFixture(false, true, OWNED);
    const conflict = { subject, predicate: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE, object: '"323"', graph: meta };
    if (reverse) f.quads.unshift(conflict); else f.quads.push(conflict);
    const replace = vi.spyOn(f.agent.store, 'replaceSubject');
    await expect(f.refresh()).resolves.toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.onChainId).toBe(OWNED);
  });

  it.each([
    { initial: undefined, observed: OWNED, refused: true },
    { initial: FOREIGN, observed: OWNED, refused: true },
    { initial: undefined, observed: FOREIGN, refused: false },
  ])('rechecks curator root activation after a committed delegation initial=$initial observed=$observed', async ({ initial, observed, refused }) => {
    const f = await curatorFixture(false, false);
    f.state.setContextGraphSubscription(LOCAL, {
      ...f.state.subscribedContextGraphs.get(LOCAL)!,
      onChainId: initial, onChainHash: initial ? HASH : undefined,
    }, { persist: false });
    await f.agent.store.insert([
      ...buildAuthoritativePublicMetaQuads(LOCAL),
      { subject, predicate: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE, object: '"582"', graph: meta },
    ]);
    const rootRows = () => f.agent.store.query(
      'SELECT ?p ?o WHERE { GRAPH <' + meta + '> { <' + subject + '> ?p ?o } } ORDER BY ?p ?o',
    );
    const before = await rootRows();
    const delegation = 'did:dkg:agent-delegation:' + LOCAL + ':root-activation-race';
    f.quads.push({
      subject: delegation, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER,
      object: '"fixture-peer"', graph: meta,
    });
    const replace = f.agent.store.replaceSubject!.bind(f.agent.store);
    const commits: string[] = [];
    vi.spyOn(f.agent.store, 'replaceSubject').mockImplementation(async (graph, replacedSubject, quads, options) => {
      const result = await replace(graph, replacedSubject, quads, options);
      commits.push(replacedSubject);
      if (replacedSubject === delegation) {
        // This earlier native subject commit passed its own admission boundary.
        f.state.setContextGraphSubscription(LOCAL, {
          ...f.state.subscribedContextGraphs.get(LOCAL)!,
          onChainId: observed, onChainHash: HASH,
        }, { persist: false });
      }
      return result;
    });

    await expect(f.refresh()).resolves.toBe(!refused);
    if (refused) {
      expect(commits).toEqual([delegation]);
      expect(await rootRows()).toEqual(before);
    } else {
      expect(commits).toEqual([delegation, subject]);
    }
    const retainedDelegation = await f.agent.store.query(
      'ASK WHERE { GRAPH <' + meta + '> { <' + delegation + '> <'
      + DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER + '> "fixture-peer" } }',
    );
    expect(retainedDelegation).toEqual({ type: 'boolean', value: true });
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.onChainId).toBe(observed);
  });

  it('rechecks the native binding after awaited projection reads before activation', async () => {
    const f = await curatorFixture(false, false);
    const query = f.agent.store.query.bind(f.agent.store);
    vi.spyOn(f.agent.store, 'query').mockImplementation(async (sparql, options) => {
      const result = await query(sparql, options);
      if (options?.source === 'agent.metaRefresh.readLocalRevocations') {
        f.state.setContextGraphSubscription(LOCAL, {
          ...f.state.subscribedContextGraphs.get(LOCAL)!,
          onChainId: OWNED, onChainHash: HASH,
        }, { persist: false });
      }
      return result;
    });
    const replace = vi.spyOn(f.agent.store, 'replaceSubject');
    await expect(f.refresh()).resolves.toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.onChainId).toBe(OWNED);
  });
});
