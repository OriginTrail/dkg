// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { createOperationContext, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { storeKnowledgeAssetOperationPublicQuads, storeKnowledgeAssetWorkspaceHead, swmKaWriteLockKey, withKeyedLocks } from '@origintrail-official/dkg-publisher';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import type { FinalizationHandlerOptions } from '../src/finalization-handler.js';
import type { SwmTargetExecutorPortsV1 } from '../src/sync/requester/swm-target-executor.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';
import type { Rfc64BackgroundWorkDispatcherV1 } from '../src/rfc64/background-work-dispatcher-v1.js';
import {
  initializeRfc64LegacySwmBoundaryV1,
  prepareRfc64LateLegacySwmBoundaryV1,
  readRfc64LegacySwmBoundaryCountV1,
} from '../src/rfc64/legacy-swm-boundary-v1.js';

const contextGraphId = '0x1111111111111111111111111111111111111111/retirement-owner';
const kaUal = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/1';
const ctx = createOperationContext('sync');
interface RetirementInternals {
  readonly writeLocks: Map<string, Promise<void>>;
  readonly rfc64BackgroundWorkDispatcherV1: Rfc64BackgroundWorkDispatcherV1;
  readonly listContextGraphsCache: Map<string, { expiresAt: number; rows: Array<Record<string, unknown>> }>;
  listContextGraphsCacheGeneration: number;
}
const fixtures: Array<{ agent: DKGAgent; store: OxigraphStore; root: string; internals: RetirementInternals }> = [];
afterEach(async () => {
  for (const { agent, store, root, internals } of fixtures.splice(0)) {
    // Physically drain marker writes before removing their durable directory.
    await internals.rfc64BackgroundWorkDispatcherV1.closeAndDrain();
    await agent.stop();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function fixture(persistent = false) {
  const root = await mkdtemp(join(tmpdir(), 'dkg-agent-retirement-owner-'));
  await chmod(root, 0o700);
  const store = new OxigraphStore(persistent ? join(root, 'store.nq') : undefined);
  const agent = await DKGAgent.create({ name: 'RetirementOwner', store, chainAdapter: new MockChainAdapter() });
  const internals = agent as unknown as RetirementInternals;
  fixtures.push({ agent, store, root, internals });
  await initializeRfc64LegacySwmBoundaryV1(agent, root, store);
  async function marker(ual = kaUal, version = '1') {
    const prepared = prepareRfc64LateLegacySwmBoundaryV1(agent, contextGraphId, ual, `share-${version}`, version);
    await store.insert([...prepared.quads]);
    prepared.settle(true);
    return async () => {
      const result = await store.query(
        `SELECT ?p WHERE { GRAPH <${prepared.graphUri}> { <${prepared.subject}> ?p ?o } }`,
      );
      if (result.type !== 'bindings') throw new Error('Expected marker bindings');
      return result.bindings.length;
    };
  }
  internals.listContextGraphsCache.set('cached-list', { expiresAt: Infinity, rows: [{ contextGraphId }] });
  return { agent, store, root, internals, marker };
}

describe('agent-owned finalized SWM retirement', () => {
  it('binds both retirement callbacks installed by the real agent constructor', async () => {
    type Registration = { configureSwmTargetExecutorSessionsV1(ports: SwmTargetExecutorPortsV1): void };
    const prototype = DKGAgent.prototype as unknown as Registration;
    const configure = prototype.configureSwmTargetExecutorSessionsV1;
    const registrations: Array<{ owner: DKGAgent; ports: SwmTargetExecutorPortsV1 }> = [];
    const registration = vi.spyOn(prototype, 'configureSwmTargetExecutorSessionsV1')
      .mockImplementation(function (this: DKGAgent, ports) {
        registrations.push({ owner: this, ports }); configure.call(this, ports);
      });
    try {
      const { agent, store, marker } = await fixture();
      expect(registrations).toHaveLength(1);
      const { owner, ports: captured } = registrations[0]!;
      expect(owner).toBe(agent);
      expect(captured.store).toBe(agent.store);
      const markerRows = await marker();
      const swmGraph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.SharedWorkingMemory,
        createGraphKnowledgeAssetScope(kaUal, 1));
      await store.insert([{ graph: swmGraph, subject: 'urn:retired', predicate: 'urn:value', object: '"finalized"' }]);
      const candidate = { contextGraphId, kaUal, swmGraph,
        agentAddress: '0x1111111111111111111111111111111111111111', kaNumber: 1n, assertionVersion: 1n };
      const retire = captured.retireFinalizedSwmTwin;
      await retire(candidate, ctx);
      expect(await store.countQuads(swmGraph)).toBe(0);
      expect(await markerRows()).toBeGreaterThan(0);
      const result = { outcome: 'retired' as const, retirement: candidate };
      const complete = captured.completeFinalizedSwmTwinRetirement;
      expect(await complete(result, ctx)).toBe(result);
      expect(await markerRows()).toBe(0);
    } finally { registration.mockRestore(); }
  });

  it.each([true, false])('conditionally completes the production orphan marker after a held writer preserves a live head: %s', async (preserveHead) => {
    const { agent, store, root, internals, marker } = await fixture(true);
    const markerRows = await marker();
    const swmGraph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.SharedWorkingMemory,
      createGraphKnowledgeAssetScope(kaUal, 1));
    const payload = [{ graph: swmGraph, subject: 'urn:live-swm', predicate: 'urn:value', object: '"live"' }];
    await store.insert(payload);
    const candidate = { contextGraphId, ual: kaUal, agentAddress: '0x1111111111111111111111111111111111111111',
      kaNumber: 1n, assertionVersion: 1n };
    const handler = agent.getOrCreateFinalizationHandler() as unknown as {
      readonly retireConfirmedGraphScopedSwmTwinIfOrphaned: NonNullable<FinalizationHandlerOptions['retireConfirmedGraphScopedSwmTwinIfOrphaned']>;
    };
    expect(typeof handler.retireConfirmedGraphScopedSwmTwinIfOrphaned).toBe('function');
    const complete = vi.spyOn(agent, 'completeVerifiedVmMarkerRetirement');
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = new Promise<void>((resolve) => { acquired = resolve; });
    const writer = withKeyedLocks(internals.writeLocks, [swmKaWriteLockKey(contextGraphId, undefined, kaUal)], async () => {
      acquired(); await gate;
      if (!preserveHead) return;
      const graphManager = new GraphManager(store);
      await storeKnowledgeAssetOperationPublicQuads({ store, graphManager, contextGraphId, shareOperationId: 'new-live-head',
        kaUal, assertionVersion: 1, quads: payload, privateTripleCount: 0, publisherPeerId: 'live-writer',
        accessPolicy: 'public', agentAddress: candidate.agentAddress });
      await storeKnowledgeAssetWorkspaceHead({ store, graphManager, contextGraphId, kaUal,
        assertionVersion: 1, shareOperationId: 'new-live-head' });
    });
    await held;
    const retirement = handler.retireConfirmedGraphScopedSwmTwinIfOrphaned(candidate, ctx);
    try {
      await Promise.resolve();
      expect(complete).not.toHaveBeenCalled();
    } finally { release(); await writer; }
    await retirement;
    expect(await store.countQuads(swmGraph)).toBe(preserveHead ? payload.length : 0);
    if (preserveHead) { expect(complete).not.toHaveBeenCalled(); expect(await markerRows()).toBeGreaterThan(0); }
    else { expect(complete).toHaveBeenCalledOnce(); expect(await markerRows()).toBe(0); }
    await store.flush();
    const reopened = new OxigraphStore(join(root, 'store.nq'));
    try {
      const recoveredBoundary = {};
      await initializeRfc64LegacySwmBoundaryV1(recoveredBoundary, root, reopened);
      expect(readRfc64LegacySwmBoundaryCountV1(recoveredBoundary, contextGraphId)).toBe(preserveHead ? 1 : 0);
      expect(await reopened.countQuads(swmGraph)).toBe(preserveHead ? payload.length : 0);
    } finally { await reopened.close(); }
  });

  it.each(['confirmed local publish', 'replica reconciliation'] as const)(
    'retries a failed marker write after %s without retiring a newer version or another KA', async (arrival) => {
      const { agent, store, internals, marker } = await fixture();
      const oldMarkerRows = await marker();
      const newerMarkerRows = await marker(kaUal, '2');
      const otherMarkerRows = await marker(kaUal.replace(/\/1$/, '/2'));
      const before = internals.listContextGraphsCacheGeneration;
      const query = store.query.bind(store);
      let unavailable = true;
      vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
        if (unavailable && options?.source === 'agent.rfc64.legacySwmBoundary.finalizedVmGraph') {
          unavailable = false;
          throw new Error('marker store unavailable');
        }
        return query(sparql, options);
      });
      const warn = vi.spyOn((agent as unknown as { log: { warn: (...args: unknown[]) => void } }).log, 'warn');
      const scheduled = vi.spyOn(internals.rfc64BackgroundWorkDispatcherV1, 'scheduleKeyed');
      const evidence = { contextGraphId, kaUal, assertionVersion: 1n };
      if (arrival === 'confirmed local publish') {
        await agent.completeVerifiedVmMarkerRetirement(evidence, ctx);
      } else {
        const result = { outcome: 'already-retired-finalized' as const, retirement: {
          ...evidence, swmGraph: 'urn:retired-swm',
          agentAddress: '0x1111111111111111111111111111111111111111', kaNumber: 1n,
        } };
        // These callbacks are passed to the executor without a receiver.
        const complete = agent.completeFinalizedSwmTwinRetirement.bind(agent);
        expect(await complete(result, ctx)).toBe(result);
      }
      expect(warn).toHaveBeenCalledWith(ctx, expect.stringContaining('marker store unavailable'));
      expect(scheduled).toHaveBeenCalledWith(
        JSON.stringify(['finalized-swm-marker', contextGraphId, null, kaUal, '1']), expect.any(Function),
      );
      expect(internals.listContextGraphsCacheGeneration).toBe(before + 1);
      expect(internals.listContextGraphsCache.size).toBe(0);
      expect(await oldMarkerRows()).toBeGreaterThan(0);
      await internals.rfc64BackgroundWorkDispatcherV1.whenIdle();
      expect(await oldMarkerRows()).toBe(0);
      expect(await newerMarkerRows()).toBeGreaterThan(0);
      expect(await otherMarkerRows()).toBeGreaterThan(0);
    },
  );

  it('drains shutdown cancellation before another store attempt and keeps the durable marker', async () => {
    const { agent, store, internals, marker } = await fixture();
    const markerRows = await marker();
    const query = store.query.bind(store);
    const attempts = vi.fn();
    vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
      if (options?.source === 'agent.rfc64.legacySwmBoundary.finalizedVmGraph') {
        attempts();
        throw new Error('store unavailable through shutdown');
      }
      return query(sparql, options);
    });
    await agent.completeVerifiedVmMarkerRetirement({ contextGraphId, kaUal, assertionVersion: 1n }, ctx);
    await internals.rfc64BackgroundWorkDispatcherV1.closeAndDrain();
    await delay(300);
    expect(attempts).toHaveBeenCalledOnce();
    expect(await markerRows()).toBeGreaterThan(0);
  });

  it('preserves unresolved physical outcomes and their cached graph list', async () => {
    const { agent, store, internals } = await fixture();
    const query = vi.spyOn(store, 'query');
    const scheduled = vi.spyOn(internals.rfc64BackgroundWorkDispatcherV1, 'scheduleKeyed');
    const before = internals.listContextGraphsCacheGeneration;
    const result = { outcome: 'head-version-mismatch' as const };
    const complete = agent.completeFinalizedSwmTwinRetirement.bind(agent);
    expect(await complete(result, ctx)).toBe(result);
    expect(query).not.toHaveBeenCalled();
    expect(scheduled).not.toHaveBeenCalled();
    expect(internals.listContextGraphsCacheGeneration).toBe(before);
    expect(internals.listContextGraphsCache.has('cached-list')).toBe(true);
  });

  it('keeps a root marker when a detached callback completes a named-subgraph retirement', async () => {
    const { agent, store, internals, marker } = await fixture();
    const rootMarkerRows = await marker();
    const query = vi.spyOn(store, 'query');
    const scheduled = vi.spyOn(internals.rfc64BackgroundWorkDispatcherV1, 'scheduleKeyed');
    const retire = agent.retireLegacySwmAfterVerifiedVmTwin.bind(agent);
    await retire({ contextGraphId, kaUal, assertionVersion: 1n, subGraphName: 'private-lane' });
    expect(query).not.toHaveBeenCalled();
    expect(scheduled).not.toHaveBeenCalled();
    expect(await rootMarkerRows()).toBeGreaterThan(0);
  });
});
