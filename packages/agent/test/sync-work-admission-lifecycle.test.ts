import { expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { createSyncWorkAdmission, type SyncWorkAdmission } from '../src/sync/work-admission.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

it('keeps independently budgeted lifecycle fetches separate and forwards their admission policy', async () => {
  const agent = await DKGAgent.create({
    name: 'BudgetedLifecycleFetch', listenHost: '127.0.0.1',
    chainAdapter: new MockChainAdapter(), rfc64CatalogActivation: { enabled: false },
  });
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const admitted = new Promise<void>(resolve => { started = resolve; });
  const sendToPeer = vi.fn(async () => { started(); await waiting; return new Uint8Array(); });
  Object.defineProperty(agent, 'messenger', { value: { sendToPeer } });
  Object.defineProperty(agent, 'buildSyncRequest', { value: async () => new Uint8Array([1]) });
  const deadline = Date.now() + 60_000;
  const fetch = (workAdmission: SyncWorkAdmission) => LifecycleSyncMethods.prototype.fetchSyncPages.call(
    agent, createOperationContext('sync'), '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M',
    'budget-cg', true, 'snapshot', '', deadline, { workAdmission },
  );
  let first: Promise<SyncPageResult> | undefined;
  let second: Promise<SyncPageResult> | undefined;
  try {
    first = fetch(createSyncWorkAdmission(() => 100));
    await admitted;
    let expired: SyncPageResult | undefined;
    second = fetch(createSyncWorkAdmission(() => 0)).then(result => { expired = result; return result; });
    await vi.waitFor(() => expect(expired).toMatchObject({
      completed: false,
      timedOut: false,
      localYield: true as const,
    }));
    expect(sendToPeer).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toMatchObject({ completed: true });
  } finally {
    release();
    await Promise.allSettled([first, second]);
    await agent.stop();
  }
});

it('keeps numeric snapshot counters on clean public detailed-sync and no-peer catchup results', async () => {
  vi.stubEnv('DKG_DURABLE_SYNC_ENABLED', '0');
  const agent = await DKGAgent.create({
    name: 'CleanSnapshotCounterContract', listenHost: '127.0.0.1',
    chainAdapter: new MockChainAdapter(), rfc64CatalogActivation: { enabled: false },
  });
  try {
    await agent.start();
    const detailed = await agent.syncSharedMemoryFromPeerDetailed('unused-peer', ['empty-cg']);
    const catchup = await agent.syncContextGraphFromConnectedPeers('empty-cg', { includeSharedMemory: true });
    expect({
      detailed: detailed.snapshotPlaneIncomplete,
      catchup: catchup.diagnostics?.sharedMemory.snapshotPlaneIncomplete,
    }).toEqual({ detailed: 0, catchup: 0 });
    expect(detailed.localYield).toBeUndefined();
    expect(catchup.diagnostics?.sharedMemory.localYield).toBeUndefined();
  } finally {
    await agent.stop();
    vi.unstubAllEnvs();
  }
});
