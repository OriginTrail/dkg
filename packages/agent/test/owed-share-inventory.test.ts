// SPDX-License-Identifier: Apache-2.0

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  createOperationContext,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  MemoryLayer,
} from '@origintrail-official/dkg-core';
import { describe, expect, it, vi } from 'vitest';

import { resolveDurableGraphScopedAuthorSealCandidateV1 } from '../src/durable-author-seal-resolver-v1.js';
import { DKGAgent } from '../src/index.js';
import { finishDurableShare } from '../src/internal/promote/durable-share-inventory.js';
import {
  SwmCatalogAuthorityNotReady,
  SwmInventoryWriteFailure,
} from '../src/internal/swm-inventory-write.js';
import type { Rfc64OwedShareInventoryV1 } from '../src/rfc64/owed-share-inventory-store-v1.js';
import { rfc64SwmInventoryShadowRuntimeV1 } from '../src/rfc64/swm-inventory-shadow-runtime-v1.js';
import {
  AUTHOR,
  AUTHOR_WALLET,
  CONTEXT_GRAPH_ID,
  NETWORK_ID,
  PROJECTION_QUADS,
  agents,
  seedDurableWorkspaceAssetV1,
  startRepairAgentV1,
  tempDirs,
} from './support/rfc64-local-catalog-repair-fixture.js';

const SEAL_DIGEST = `0x${'ab'.repeat(32)}`;
const FENCED = Object.freeze({ mode: 'catalog', killSwitchActive: false, active: false,
  authoringAllowed: false, reconciliationLane: 'disabled' });

function bound(operationId: string, overrides: Record<string, unknown> = {}) {
  return {
    contextGraphId: CONTEXT_GRAPH_ID, assertionCoordinate: 'asset', lifecycleAgentAddress: AUTHOR_WALLET.address,
    ctx: createOperationContext('share'),
    recoveryBinding: { version: 1 as const, sealDigest: SEAL_DIGEST, inventoryRequired: false,
      intent: { version: 1 as const, operationId, timestampMs: 1, confirmationRequired: false,
        accessPolicy: 'public' as const, allowedPeers: [] } },
    ...overrides,
  };
}

function fakeAgent(options: { store?: boolean; requires?: () => boolean } = {}) {
  const agent = Object.create(DKGAgent.prototype) as any;
  const kept: Rfc64OwedShareInventoryV1[] = [];
  const store = {
    unreadableAtOpen: 0,
    list: () => [...kept],
    put: vi.fn(async (marker: Rfc64OwedShareInventoryV1) => { kept.push(marker); }),
    delete: vi.fn(async (marker: Rfc64OwedShareInventoryV1) => {
      kept.splice(kept.findIndex(({ shareOperationId }) => shareOperationId === marker.shareOperationId), 1);
    }),
  };
  agent.rfc64PersistenceV1 = options.store === false ? undefined : { owedShareInventories: store };
  agent.log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  agent.requiresRfc64ShareInventoryV1 = vi.fn(options.requires ?? (() => true));
  agent.tryCommitRfc64SwmAuthorInventoryV1 = vi.fn();
  agent.requestRfc64SwmCatalogProjectionV1 = vi.fn(() => true);
  agent.rfc64CatalogAuthorityRefreshFailureReasonV1 = vi.fn(() => 'registered-authority-unfinalized');
  agent.scheduleRfc64CatalogResponsibilityReconciliationV1 = vi.fn(() => true);
  return { agent, store, kept };
}

const MARKER = Object.freeze({
  version: 1, contextGraphId: CONTEXT_GRAPH_ID, subGraphName: null, authorAddress: AUTHOR,
  assertionCoordinate: 'asset', sealDigest: SEAL_DIGEST, shareOperationId: 'fenced-share',
}) as Rfc64OwedShareInventoryV1;

describe('owed share inventory marker at share completion', () => {
  it('keeps a durable marker for a share admitted without the handoff, before it completes', async () => {
    const { agent, store } = fakeAgent();
    const request = vi.spyOn(agent, 'requestRfc64OwedShareInventoryDrainV1');
    const detached = vi.fn();
    await finishDurableShare(agent, bound('fenced-share'), async () => undefined, detached);
    expect(store.put).toHaveBeenCalledWith(MARKER);
    expect(request).toHaveBeenCalledOnce();
    // Durable ownership replaces the detached execution path.
    expect(detached).not.toHaveBeenCalled();
    expect(agent.requiresRfc64ShareInventoryV1).toHaveBeenCalledWith(CONTEXT_GRAPH_ID, undefined);
  });

  it('keeps no marker for an unbound share, a share without an obligation, or a node without persistence', async () => {
    const unbound = fakeAgent();
    await finishDurableShare(unbound.agent, { ...bound('x'), recoveryBinding: undefined, shareOperationId: 'x' } as any,
      async () => undefined, vi.fn());
    expect(unbound.store.put).not.toHaveBeenCalled();
    const excluded = fakeAgent({ requires: () => false });
    await excluded.agent.recordRfc64OwedShareInventoryV1(bound('excluded'));
    expect(excluded.store.put).not.toHaveBeenCalled();
    const withoutPersistence = fakeAgent({ store: false });
    await withoutPersistence.agent.recordRfc64OwedShareInventoryV1(bound('ephemeral'));
    expect(withoutPersistence.agent.requiresRfc64ShareInventoryV1).not.toHaveBeenCalled();
  });

  it('owes the row when the authority cannot yet rule the obligation out, and passes other failures on', async () => {
    const pending = fakeAgent({ requires: () => { throw new SwmCatalogAuthorityNotReady('policy-not-accepted'); } });
    await pending.agent.recordRfc64OwedShareInventoryV1(bound('not-ready'));
    expect(pending.store.put).toHaveBeenCalledWith({ ...MARKER, shareOperationId: 'not-ready' });
    const broken = fakeAgent({ requires: () => { throw new Error('resolver failed'); } });
    await expect(broken.agent.recordRfc64OwedShareInventoryV1(bound('broken'))).rejects.toThrow('resolver failed');
    expect(broken.store.put).not.toHaveBeenCalled();
  });

  it('answers a post-commit failure when the marker cannot be made durable', async () => {
    const { agent, store } = fakeAgent();
    store.put.mockRejectedValueOnce(new Error('disk full'));
    await expect(finishDurableShare(agent, bound('fenced-share'), async () => undefined, vi.fn()))
      .rejects.toMatchObject({ code: 'PROMOTE_POST_COMMIT_FAILURE' });
  });

  it.each(['stamp', 'record', 'unavailable'] as const)('preserves observer fallback when %s cannot transfer ownership', async mode => {
    const { agent, store } = fakeAgent({ store: mode !== 'unavailable' });
    const detached = vi.fn();
    if (mode === 'record') store.put.mockRejectedValueOnce(new Error('disk full'));
    const completion = finishDurableShare(agent, bound('fallback'), async () => {
      if (mode === 'stamp') throw new Error('pointer unavailable');
    }, detached);
    if (mode === 'unavailable') await completion;
    else await expect(completion).rejects.toMatchObject({ code: 'PROMOTE_POST_COMMIT_FAILURE' });
    expect(detached).toHaveBeenCalledOnce();
    expect(detached).toHaveBeenCalledWith(expect.objectContaining({ shareOperationId: 'fallback' }));
  });

  it('runs a recorded share once when completion and repeated drain requests race', async () => {
    const { agent, kept } = fakeAgent();
    let release!: () => void;
    agent.tryCommitRfc64SwmAuthorInventoryV1.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ status: 'applied' });
    }));
    const owner = agent.createRfc64OwedShareInventoryOwnerV1(() => ({ retryIntervalMs: 0 }));
    owner.start(createOperationContext('system'));
    await owner.whenIdle();
    const detached = vi.fn();
    try {
      await finishDurableShare(agent, bound('racing-share'), async () => undefined, detached);
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      agent.requestRfc64OwedShareInventoryDrainV1();
      agent.requestRfc64OwedShareInventoryDrainV1();
      expect(kept).toHaveLength(1);
      release();
      await owner.whenIdle();
      expect(kept).toEqual([]);
      expect(agent.tryCommitRfc64SwmAuthorInventoryV1).toHaveBeenCalledOnce();
      expect(agent.requestRfc64SwmCatalogProjectionV1).toHaveBeenCalledOnce();
      expect(detached).not.toHaveBeenCalled();
    } finally { release?.(); await owner.close(); }
  });

  it('does not report success or schedule an observer before durable recording finishes', async () => {
    const { agent, store } = fakeAgent();
    let release!: () => void;
    store.put.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const detached = vi.fn();
    let completed = false;
    const completion = finishDurableShare(agent, bound('slow-disk'), async () => undefined, detached)
      .then(() => { completed = true; });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(completed).toBe(false);
    expect(detached).not.toHaveBeenCalled();
    release();
    await completion;
    expect(completed).toBe(true);
    expect(detached).not.toHaveBeenCalled();
  });

  it('warns and keeps no marker for identifiers the catalog writer would refuse', async () => {
    const { agent, store } = fakeAgent();
    await agent.recordRfc64OwedShareInventoryV1(bound('bad', { assertionCoordinate: 'bad\u0000name' }));
    expect(store.put).not.toHaveBeenCalled();
    expect(agent.log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Share bad owes no catalog inventory row'));
  });
});

describe('one attempt at an owed row', () => {
  it.each([
    [{ status: 'applied', attempts: 1, headObjectDigest: 'h', kaUal: 'u' }, 'written'],
    [{ status: 'existing', attempts: 1, headObjectDigest: 'h', kaUal: 'u' }, 'written'],
    [{ status: 'dormant', dormantReason: 'vm-confirmed' }, 'vm-confirmed'],
    [{ status: 'dormant', dormantReason: 'policy-mismatch' }, 'policy-mismatch'],
    [{ status: 'dormant', dormantReason: 'inactive-lane' }, 'waiting'],
    [{ status: 'dormant', dormantReason: 'authority-transition' }, 'waiting'],
    [{ status: 'superseded', reason: 'missing-seal' }, 'superseded'],
    [{ status: 'superseded', reason: 'workspace-mismatch' }, 'superseded'],
  ])('maps %j to %s', async (result, outcome) => {
    const { agent } = fakeAgent();
    agent.tryCommitRfc64SwmAuthorInventoryV1.mockResolvedValue(result);
    await expect(agent.drainRfc64OwedShareInventoryV1(MARKER, createOperationContext('system'))).resolves.toBe(outcome);
    expect(agent.tryCommitRfc64SwmAuthorInventoryV1).toHaveBeenCalledWith({ contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: null, authorAddress: AUTHOR, assertionCoordinate: 'asset', lifecycleAgentAddress: AUTHOR,
      shareOperationId: 'fenced-share', sealDigest: SEAL_DIGEST, ctx: expect.anything() });
    expect(agent.requestRfc64SwmCatalogProjectionV1).toHaveBeenCalledTimes(outcome === 'written' ? 1 : 0);
  });

  it('waits for a readiness gap and fails on anything else', async () => {
    const { agent } = fakeAgent();
    agent.tryCommitRfc64SwmAuthorInventoryV1.mockRejectedValueOnce(new SwmInventoryWriteFailure('authority', null,
      new SwmCatalogAuthorityNotReady('service-unavailable')));
    await expect(agent.drainRfc64OwedShareInventoryV1(MARKER, createOperationContext('system'))).resolves.toBe('waiting');
    const failure = new SwmInventoryWriteFailure('inventory-maintenance', 'u', new Error('database locked'));
    agent.tryCommitRfc64SwmAuthorInventoryV1.mockRejectedValueOnce(failure);
    await expect(agent.drainRfc64OwedShareInventoryV1(MARKER, createOperationContext('system'))).rejects.toBe(failure);
  });

  it('lets a ready graph drain while another graph settles, coalescing its waiting markers', async () => {
    const { agent, kept } = fakeAgent();
    const runtime = rfc64SwmInventoryShadowRuntimeV1(agent);
    const wait = vi.spyOn(runtime, 'waitForResponsibilitySettlement');
    let ready = false;
    const readyGraph = `${AUTHOR}/ready`;
    kept.push(MARKER, { ...MARKER, assertionCoordinate: 'second', shareOperationId: 'second' },
      { ...MARKER, contextGraphId: readyGraph, shareOperationId: 'ready' } as Rfc64OwedShareInventoryV1);
    agent.rfc64CatalogAuthorityRefreshFailureReasonV1.mockReturnValue(undefined);
    agent.tryCommitRfc64SwmAuthorInventoryV1.mockImplementation(async (params: { contextGraphId: string }) =>
      ready || params.contextGraphId === readyGraph ? { status: 'applied' } : { status: 'dormant', dormantReason: 'inactive-lane' });
    agent.scheduleRfc64CatalogResponsibilityReconciliationV1.mockImplementation(() => {
      expect(runtime.hasInventoryWrites({ contextGraphId: CONTEXT_GRAPH_ID, authorAddress: AUTHOR })).toBe(false);
      return true;
    });
    const owner = agent.createRfc64OwedShareInventoryOwnerV1(() => ({ retryIntervalMs: 0 }));
    owner.start(createOperationContext('system'));
    try {
      await owner.whenIdle();
      expect(kept.map(marker => marker.shareOperationId)).toEqual(['fenced-share', 'second']);
      expect(agent.scheduleRfc64CatalogResponsibilityReconciliationV1).toHaveBeenCalledOnce();
      owner.request(); await owner.whenIdle();
      expect(agent.scheduleRfc64CatalogResponsibilityReconciliationV1).toHaveBeenCalledOnce();
      expect(wait).not.toHaveBeenCalled();
      ready = true;
      owner.request(); await owner.whenIdle();
      expect(kept).toEqual([]);
      expect(agent.requestRfc64SwmCatalogProjectionV1).toHaveBeenCalledTimes(3);
    } finally { await owner.close(); }
  });

  it('keeps the marker when projection cannot accept the durable row', async () => {
    const { agent } = fakeAgent();
    agent.tryCommitRfc64SwmAuthorInventoryV1.mockResolvedValue({ status: 'existing' });
    agent.requestRfc64SwmCatalogProjectionV1.mockReturnValue(false);
    await expect(agent.drainRfc64OwedShareInventoryV1(MARKER, createOperationContext('system'))).resolves.toBe('waiting');
    expect(agent.scheduleRfc64CatalogResponsibilityReconciliationV1).not.toHaveBeenCalled();
    expect(agent.requestRfc64SwmCatalogProjectionV1).toHaveBeenCalledOnce();
  });

  it('runs the owner over the node\'s markers and logs a failed attempt', async () => {
    const { agent, kept } = fakeAgent();
    kept.push(MARKER);
    agent.tryCommitRfc64SwmAuthorInventoryV1.mockRejectedValueOnce(new Error('signer unavailable'));
    const owner = agent.createRfc64OwedShareInventoryOwnerV1(() => undefined);
    owner.start(createOperationContext('system'));
    await owner.whenIdle();
    expect(agent.log.warn).toHaveBeenCalledWith(expect.anything(),
      expect.stringContaining('attempt 1, next in 5 s): signer unavailable'));
    expect(kept).toEqual([MARKER]);
    await owner.close();
  });

  it('does nothing once the inventory writers are shutting down', async () => {
    const { agent } = fakeAgent();
    await rfc64SwmInventoryShadowRuntimeV1(agent).closeAndDrain();
    await expect(agent.drainRfc64OwedShareInventoryV1(MARKER, createOperationContext('system'))).resolves.toBe('waiting');
    expect(agent.tryCommitRfc64SwmAuthorInventoryV1).not.toHaveBeenCalled();
  });
});

describe('owed share inventory on a started agent', () => {
  function markers(agent: DKGAgent): readonly Rfc64OwedShareInventoryV1[] {
    return (agent as any).rfc64PersistenceV1.owedShareInventories.list();
  }

  async function startAuthor(name: string, dataDir: string, fenced: boolean): Promise<DKGAgent> {
    const agent = await startRepairAgentV1({ name, dataDir, storePath: join(dataDir, 'oxigraph'),
      beforeStart: (started) => {
        vi.spyOn(started, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
        // A refresh-fenced authority: responsible, but not accepted yet. Here the graph was just registered and
        // chain finality lags, a wait the detached observer's settlement window does not outlast.
        if (fenced) {
          started.resolveRfc64CatalogReceiverAuthorityV1 = () => FENCED as any;
          vi.spyOn(started, 'rfc64CatalogAuthorityRefreshFailureReasonV1').mockReturnValue('registered-authority-unfinalized');
        }
      } });
    agent.acceptOpenContextGraphPolicyV1({ networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH_ID, ownerAddress: AUTHOR });
    await agent.whenRfc64CatalogResponsibilitiesIdleV1();
    return agent;
  }

  it('retries waiting markers after canonical settlement with periodic retries disabled and unchanged authority', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-owed-settlement-wake-'));
    tempDirs.push(dataDir);
    const author = await startAuthor('owed-settlement-wake', dataDir, false);
    const internals = author as any;
    // Keep the already accepted policy; only responsibility needs another pass.
    internals.subscribedContextGraphs.set(CONTEXT_GRAPH_ID, { subscribed: true });
    const accepted = vi.spyOn(author, 'acceptOpenContextGraphPolicyV1');
    vi.spyOn(author, 'rfc64CatalogAuthorityRefreshFailureReasonV1').mockReturnValue(undefined);
    vi.spyOn(internals, 'getExplicitAccessPolicy').mockResolvedValue('public');
    vi.spyOn(author, 'requestRfc64SwmCatalogProjectionV1').mockReturnValue(true);
    let ready = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = author.reconcileRfc64CatalogResponsibilityCoreV1.bind(author);
    const settlement = vi.spyOn(author, 'reconcileRfc64CatalogResponsibilityCoreV1')
      .mockImplementation(async (...args) => {
        await gate;
        ready = true;
        return original(...args);
      });
    const readyGraph = `${AUTHOR}/ready`;
    vi.spyOn(author, 'tryCommitRfc64SwmAuthorInventoryV1').mockImplementation(async params =>
      ready || params.contextGraphId === readyGraph
        ? { status: 'existing', attempts: 1, headObjectDigest: 'h', kaUal: 'u' } as any
        : { status: 'dormant', dormantReason: 'inactive-lane' } as any);
    await internals.rfc64PersistenceV1.owedShareInventories.put(MARKER);
    await internals.rfc64PersistenceV1.owedShareInventories.put({ ...MARKER, assertionCoordinate: 'second', shareOperationId: 'second' });
    await internals.rfc64PersistenceV1.owedShareInventories.put({ ...MARKER, contextGraphId: readyGraph, shareOperationId: 'ready' });
    const owner = author.createRfc64OwedShareInventoryOwnerV1(() => ({ retryIntervalMs: 0 }));
    owner.start(createOperationContext('system'));
    try {
      await owner.whenIdle();
      await vi.waitFor(() => expect(settlement).toHaveBeenCalledOnce());
      expect(markers(author).map(marker => marker.shareOperationId).sort()).toEqual(['fenced-share', 'second']);
      release();
      await author.whenRfc64CatalogResponsibilitiesIdleV1();
      // No request() or authority event here: the committed responsibility wakes the owner.
      await owner.whenIdle();
      expect(markers(author)).toEqual([]);
      expect(accepted).not.toHaveBeenCalled();
      expect(settlement).toHaveBeenCalledOnce();
    } finally { release(); await owner.close(); }
  }, 30_000);

  it('recovers the exact shared version after reopening for editing and restarting behind a fence', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-owed-share-inventory-'));
    tempDirs.push(dataDir);
    const author = await startAuthor('owed-share-author', dataDir, true);
    const seeded = await seedDurableWorkspaceAssetV1(author, 'fenced', 101n);
    const scope = { inventoryScopeDigest: seeded.scopeDigest, authorAddress: AUTHOR };
    // Admission would owe the obligation but not the handoff.
    expect(author.requiresRfc64ShareInventoryV1(CONTEXT_GRAPH_ID, undefined)).toBe(true);
    expect(author.requiresRfc64ShareInventoryHandoffV1(CONTEXT_GRAPH_ID, undefined)).toBe(false);
    const sealDigest = computeCanonicalGraphScopedAuthorSealDigestV1(canonicalGraphScopedAuthorSealFromAssertionSealV1(seeded.seal));
    await author.afterDurableSwmPromotionV1(bound(seeded.shareOperationId, {
      assertionCoordinate: seeded.assertionCoordinate,
      recoveryBinding: { ...bound('x').recoveryBinding, sealDigest,
        intent: { ...bound('x').recoveryBinding.intent, operationId: seeded.shareOperationId } },
    }));
    // Only the durable owner is scheduled for this share.
    await author.awaitInFlightRfc64SwmInventoryObserversV1();
    expect(author.readRfc64SwmAuthorInventorySnapshotV1(scope)).toBeNull();
    const owed = { version: 1, contextGraphId: CONTEXT_GRAPH_ID, subGraphName: null, authorAddress: AUTHOR,
      assertionCoordinate: seeded.assertionCoordinate, sealDigest, shareOperationId: seeded.shareOperationId };
    expect(markers(author)).toEqual([owed]);
    const sharedGraph = knowledgeAssetLayerGraphUri(CONTEXT_GRAPH_ID, MemoryLayer.SharedWorkingMemory,
      createGraphKnowledgeAssetScope(seeded.seal.kaUal!, seeded.seal.assertionVersion!));
    await author.store.insert(PROJECTION_QUADS.map(quad => ({ ...quad, graph: sharedGraph })));
    await author.assertion.pullFrom(CONTEXT_GRAPH_ID, seeded.assertionCoordinate, 'swm', { agentAddress: AUTHOR });
    expect(await resolveDurableGraphScopedAuthorSealCandidateV1({ store: author.store,
      contextGraphId: CONTEXT_GRAPH_ID, agentAddress: AUTHOR, assertionCoordinate: seeded.assertionCoordinate,
      source: 'test.reopened.active' })).toBeUndefined();
    expect(await resolveDurableGraphScopedAuthorSealCandidateV1({ store: author.store,
      contextGraphId: CONTEXT_GRAPH_ID, agentAddress: AUTHOR, assertionCoordinate: seeded.assertionCoordinate,
      source: 'test.reopened.exact', sealDigest })).toBeDefined();

    await author.stop();
    agents.splice(agents.indexOf(author), 1);
    // The fence outlasts the restart: the start-up pass keeps the marker.
    const restarted = await startAuthor('owed-share-author-restarted', dataDir, true);
    expect(markers(restarted)).toEqual([owed]);
    const writer = vi.spyOn(restarted, 'tryCommitRfc64SwmAuthorInventoryV1');
    restarted.requestRfc64OwedShareInventoryDrainV1();
    await vi.waitFor(() => expect(writer).toHaveBeenCalled());
    await expect(writer.mock.results[0]!.value).resolves.toMatchObject({ status: 'dormant', dormantReason: 'inactive-lane' });
    expect(markers(restarted)).toEqual([owed]);
    expect(restarted.readRfc64SwmAuthorInventorySnapshotV1(scope)).toBeNull();

    // The authority is accepted: the lane opens and the owed row is written under the asset lock.
    delete (restarted as any).resolveRfc64CatalogReceiverAuthorityV1;
    restarted.requestRfc64OwedShareInventoryDrainV1();
    await vi.waitFor(() => expect(markers(restarted)).toEqual([]), { timeout: 10_000 });
    expect(restarted.readRfc64SwmAuthorInventorySnapshotV1(scope)).toMatchObject({
      rows: [{ assertionCoordinate: seeded.assertionCoordinate, shareOperationId: seeded.shareOperationId, sealDigest }],
    });
  }, 60_000);

  it('drops markers whose share has moved on without writing a row', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-owed-superseded-'));
    tempDirs.push(dataDir);
    const author = await startAuthor('owed-share-superseded', dataDir, false);
    const seeded = await seedDurableWorkspaceAssetV1(author, 'moved-on', 102n);
    const store = (author as any).rfc64PersistenceV1.owedShareInventories;
    const replaced = { ...MARKER, assertionCoordinate: seeded.assertionCoordinate, shareOperationId: 'replaced-share',
      sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(canonicalGraphScopedAuthorSealFromAssertionSealV1(seeded.seal)) };
    const unsealed = { ...MARKER, assertionCoordinate: 'never-sealed', shareOperationId: 'unsealed-share' };
    await store.put(replaced);
    await store.put(unsealed);
    const writer = vi.spyOn(author, 'tryCommitRfc64SwmAuthorInventoryV1');
    author.requestRfc64OwedShareInventoryDrainV1();
    await vi.waitFor(() => expect(markers(author)).toEqual([]), { timeout: 10_000 });
    expect(writer).toHaveBeenCalledTimes(2);
    const outcomes = await Promise.all(writer.mock.results.map(result => result.value));
    expect(outcomes).toEqual(expect.arrayContaining([
      { status: 'superseded', reason: 'missing-seal' },
      { status: 'superseded', reason: 'workspace-mismatch' },
    ]));
    for (const marker of [replaced, unsealed]) {
      await expect(author.commitRfc64SwmAuthorInventoryV1({ ...marker, lifecycleAgentAddress: AUTHOR }))
        .rejects.toMatchObject({ phase: 'preparation-read', cause: { message: marker === unsealed
          ? 'durable SWM assertion has no strict graph-scoped author seal'
          : 'durable SWM head does not match the committed share and author seal' } });
    }
    expect(author.readRfc64SwmAuthorInventorySnapshotV1({ inventoryScopeDigest: seeded.scopeDigest, authorAddress: AUTHOR }))
      .toBeNull();
  }, 60_000);
});
