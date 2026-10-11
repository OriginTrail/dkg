// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { DKGEvent, TypedEventBus } from '@origintrail-official/dkg-core';
import { CG, POLICY, privateCatalogReadinessFixture } from '../../agent/test/_helpers/private-catalog-readiness-fixture.js';
import { registerProjectSyncedReadinessPersistence, type ContextGraphReadinessStore } from '../src/context-graph-readiness.js';
import { registerContextGraphReadinessEvents } from '../src/context-graph-readiness-events.js';

// Use one agent module graph when CLI helpers import its public entry point.
vi.mock('@origintrail-official/dkg-agent', () => import('../../agent/src/index.js'));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const f = await privateCatalogReadinessFixture({ restored: true });
  let provenance: ReturnType<ContextGraphReadinessStore['getContextGraphReadinessProvenance']> = null;
  const writes = vi.fn();
  const store: ContextGraphReadinessStore = {
    getContextGraphReadinessProvenance: () => provenance,
    setContextGraphReadinessProvenance: (id, next) => {
      provenance = { ...next, updatedAt: next.updatedAt ?? Date.now() }; writes(id, provenance);
    },
  };
  const subscription = { subscribed: true, synced: false, sharedMemorySynced: false };
  f.agent.markContextGraphSubscriptionState = (_id: string, patch: object) => Object.assign(subscription, patch);
  const verified = vi.spyOn(f.agent, 'withVerifiedPrivateCatalogSubscriptionReadinessV1');
  const syncEvents = vi.fn(() => {
    // The same event consumed by SSE must observe already-committed readiness.
    expect(provenance).toMatchObject({ sharedMemoryVerified: true, durableVerified: false });
    expect(subscription).toMatchObject({ synced: true, sharedMemorySynced: true });
  });
  f.eventBus.on(DKGEvent.PROJECT_SYNCED, syncEvents);
  const log = vi.fn();
  registerProjectSyncedReadinessPersistence({ agent: f.agent, store, log });
  return { ...f, verified, writes, syncEvents, log, subscription, provenance: () => provenance };
}

describe('catalog replay to readiness persistence', () => {
  it('persists only after the real replay settles, using its production wake-up', async () => {
    const f = await fixture();
    const receiverIdle = deferred();
    const receiverEntered = deferred();
    f.whenIdle.mockImplementationOnce(async () => {
      receiverEntered.resolve(); await receiverIdle.promise;
    });
    // Applied rows already exist, but the replay owner has not finished its
    // receiver/parity fence. No diagnostic status or completion stub is used.
    const replay = f.replay();
    await receiverEntered.promise;
    expect(f.state.replay.status(CG, POLICY)?.active).toBe(true);
    f.eventBus.emit(DKGEvent.CATALOG_READINESS_CHECK_REQUESTED, { contextGraphId: CG });
    await vi.waitFor(() => expect(f.verified).toHaveBeenCalledTimes(1));
    await expect(f.verified.mock.results[0].value).resolves.toBe(false);
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.syncEvents).not.toHaveBeenCalled();

    receiverIdle.resolve();
    await replay;
    // This second check is emitted by requestRfc64CatalogHeadReplayV1's
    // settlement wrapper, not by the test or an operational-status mock.
    await vi.waitFor(() => expect(f.writes).toHaveBeenCalledTimes(1));
    expect(f.verified).toHaveBeenCalledTimes(2);
    expect(f.state.replay.status(CG, POLICY)).toMatchObject({ active: false, failed: false, unverified: false });
    expect(f.provenance()).toMatchObject({ version: 1, sharedMemoryVerified: true, durableVerified: false });
    expect(f.syncEvents).toHaveBeenCalledTimes(1);
    expect(f.log).not.toHaveBeenCalled();
  });

  it('does not broadcast completion for restored rows or malformed wake-ups', async () => {
    const f = await fixture();
    for (const payload of [null, {}, { contextGraphId: 7 }, { contextGraphId: ' ' }]) {
      f.eventBus.emit(DKGEvent.CATALOG_READINESS_CHECK_REQUESTED, payload);
    }
    expect(f.verified).not.toHaveBeenCalled();
    f.eventBus.emit(DKGEvent.CATALOG_READINESS_CHECK_REQUESTED, { contextGraphId: CG });
    await vi.waitFor(() => expect(f.verified).toHaveBeenCalledTimes(1));
    await expect(f.verified.mock.results[0].value).resolves.toBe(false);
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.syncEvents).not.toHaveBeenCalled();
  });

  it('reports verifier errors without manufacturing a sync event', async () => {
    const f = await fixture();
    f.verified.mockRejectedValueOnce(new Error('authority unavailable'));
    f.eventBus.emit(DKGEvent.CATALOG_READINESS_CHECK_REQUESTED, { contextGraphId: CG });
    await vi.waitFor(() => expect(f.log).toHaveBeenCalledWith(expect.stringContaining('authority unavailable')));
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.syncEvents).not.toHaveBeenCalled();
  });

  it.each([new Error('storage unavailable'), 'storage unavailable'])('retains independent event error handling for %s', async (failure) => {
    const eventBus = new TypedEventBus();
    const verifyCatalog = vi.fn(async () => { throw failure; });
    const persistProject = vi.fn(async () => { throw failure; });
    const log = vi.fn();
    registerContextGraphReadinessEvents({ eventBus, verifyCatalog, persistProject, log });
    eventBus.emit(DKGEvent.PROJECT_SYNCED, null);
    expect(persistProject).not.toHaveBeenCalled();
    eventBus.emit(DKGEvent.CATALOG_READINESS_CHECK_REQUESTED, { contextGraphId: CG });
    eventBus.emit(DKGEvent.PROJECT_SYNCED, { contextGraphId: CG, dataSynced: 1, sharedMemorySynced: 0 });
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
    expect(verifyCatalog).toHaveBeenCalledWith(CG);
    expect(persistProject).toHaveBeenCalledWith({ contextGraphId: CG, dataSynced: 1, sharedMemorySynced: 0, verifiedPrivateOnlyResponses: 0 });
    expect(log).toHaveBeenCalledWith('[warn] Failed to verify catalog readiness: storage unavailable');
    expect(log).toHaveBeenCalledWith('[warn] Failed to persist PROJECT_SYNCED readiness: storage unavailable');
  });
});
