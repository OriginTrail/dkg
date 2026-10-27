import { createTestSubscriptionActivations } from './_helpers/subscription-activation-owner.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { continueContextGraphSubscriptionLine } from '../src/context-graph-subscription-policy.js';
import { AgentWorkLifetime } from '../src/agent-work-lifetime.js';
import { PublicSnapshotMethods } from '../src/dkg-agent-public-snapshot.js';

const graph = 'snapshot-startup-authority';
function fixture() {
  const active = () => ({ subscribed: true, syncMode: 'always-on', onChainId: '1', onChainHash: ethers.id(graph) });
  const snapshot = () => { const now = Date.now(); return sealPublicGraphSnapshot({
    version: 1, chainId: 'evm:31337', deploymentId: 'test', contextGraphId: graph,
    onChainId: '1', nameHash: ethers.id(graph), contextGraphStorage: `0x${'1'.repeat(40)}`,
    assetStorage: `0x${'2'.repeat(40)}`, blockNumber: '10', blockHash: `0x${'a'.repeat(64)}`,
    finalityConfirmations: 1, observedAt: now, expiresAt: now + 120000, accessPolicy: 0, assets: [],
  }); };
  const a: any = {
    started: true, workLifetime: new AgentWorkLifetime(),
    subscribedContextGraphs: new Map([[graph, active()]]),
    contextGraphSubscriptionDormancyById: new Map([[graph, 'authorityUnavailable']]),
    waitForContextGraphSubscriptionActivation: LifecycleSyncMethods.prototype.waitForContextGraphSubscriptionActivation,
    contextGraphBindingState: { capture: () => 0, isGenerationCurrent: (_: string, generation: number) => generation === 0 },
    chain: { chainId: 'evm:31337', deploymentId: 'test', readPublicGraphSnapshot: vi.fn(async () => snapshot()) },
    router: { send: vi.fn(async () => Buffer.from(JSON.stringify(snapshot()))) },
    store: { insert: vi.fn(async () => {}) },
  };
  a.contextGraphSubscriptionActivations = createTestSubscriptionActivations(a);
  a.activationIntent = { id: graph, subscribed: true, syncScoped: true, synced: false, metaSynced: false, sharedMemorySynced: false, onChainId: '1', onChainHash: ethers.id(graph) };
  a.contextGraphSubscriptionActivations.reset([a.activationIntent]);
  a.contextGraphSubscriptionDormancyById.set(graph, 'authorityUnavailable');
  a.getSubscribedContextGraphs = () => a.subscribedContextGraphs;
  const replace = (next: ReturnType<typeof active>) => {
    continueContextGraphSubscriptionLine(a.subscribedContextGraphs.get(graph), next);
    a.subscribedContextGraphs.set(graph, next);
  };
  return { a, active, replace };
}
function coldIntent(a: any) {
  const row = { id: graph, subscribed: true, syncScoped: true, synced: false, metaSynced: false, sharedMemorySynced: false };
  a.subscribedContextGraphs.clear();
  a.activationIntent = row;
  a.contextGraphSubscriptionActivations.reset([row]);
  a.contextGraphSubscriptionDormancyById.set(graph, 'authorityUnavailable');
  return row;
}
async function finish(a: any) {
  const owner = a.contextGraphSubscriptionActivations, row = a.subscribedContextGraphs.get(graph);
  if (row?.subscribed) await owner.activate(a.activationIntent, {
    install: () => row,
    remove: (id: string) => { a.subscribedContextGraphs.delete(id); },
    rollbackNetworkEffects() {}, trackSync() {}, subscribe() {}, persistMembership() {},
    commit: () => row,
  });
  else { a.contextGraphSubscriptionDormancyById.delete(graph); owner.cancel(graph); }
}
const run = (a: any, signal?: AbortSignal) => PublicSnapshotMethods.prototype.syncPublicGraphSnapshot.call(a,
  { contextGraphId: graph, onChainId: '1', mode: 'core-cache', trustedCorePeerIds: ['core'], signal });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('snapshot waits for persisted startup authority', () => {
  it('waits for the lifecycle to commit a legacy unbound intent before reading an inventory', async () => {
    vi.useFakeTimers();
    const { a, active } = fixture(); coldIntent(a);
    const pending = run(a);
    await vi.advanceTimersByTimeAsync(2500);
    expect(a.router.send).not.toHaveBeenCalled();
    const committed = active();
    a.subscribedContextGraphs.set(graph, committed);
    await finish(a);
    await vi.advanceTimersByTimeAsync(2500);
    await expect(pending).resolves.toMatchObject({ assets: 0, current: true });
    expect(a.router.send).toHaveBeenCalledTimes(2);
    expect(a.workLifetime.physicalRuns.size).toBe(0);
  });

  it('does not capture a provisional row that a failed activation rolls back', async () => {
    vi.useFakeTimers();
    const { a, active, replace } = fixture();
    const pending = run(a);
    await vi.advanceTimersByTimeAsync(0);
    expect(a.router.send).not.toHaveBeenCalled();
    expect(a.store.insert).not.toHaveBeenCalled();
    // The real activation transaction can roll back while its authority read
    // is unavailable. Its next successful pass installs a different row.
    replace({ ...active(), subscribed: false });
    await vi.advanceTimersByTimeAsync(2500);
    expect(a.router.send).not.toHaveBeenCalled();
    replace(active());
    await finish(a);
    await vi.advanceTimersByTimeAsync(2500);
    await expect(pending).resolves.toMatchObject({ assets: 0, current: true, elapsedMs: 2500 });
    expect(a.router.send).toHaveBeenCalledTimes(2);
    expect(a.workLifetime.physicalRuns.size).toBe(0);
  });

  it.each((['caller', 'shutdown', 'deadline'] as const).flatMap(cause => [false, true].map(cold => ({ cause, cold }))))('starts no read or write after $cause ends the wait, unbound=$cold', async ({ cause, cold }) => {
    vi.useFakeTimers();
    const { a } = fixture(), caller = new AbortController();
    if (cold) coldIntent(a);
    const pending = run(a, caller.signal);
    const rejected = expect(pending).rejects.toThrow('Snapshot job ownership changed');
    await vi.advanceTimersByTimeAsync(0);
    if (cause === 'caller') caller.abort();
    else if (cause === 'shutdown') { a.workLifetime.close(); a.workLifetime.open(); }
    else await vi.advanceTimersByTimeAsync(3_600_000);
    await rejected;
    expect(a.router.send).not.toHaveBeenCalled();
    expect(a.store.insert).not.toHaveBeenCalled();
    expect(a.workLifetime.physicalRuns.size).toBe(0);
  });

  it.each(['authorityDenied', 'deactivated', 'rehydrationDisabled'] as const)('keeps %s inactive without a core read', async reason => {
    const { a, active, replace } = fixture();
    a.contextGraphSubscriptionDormancyById.set(graph, reason);
    replace({ ...active(), subscribed: false });
    await expect(run(a)).rejects.toThrow('inactive');
    expect(a.router.send).not.toHaveBeenCalled();
    expect(a.store.insert).not.toHaveBeenCalled();
  });

  it('honors an explicit unsubscribe while startup authority is unavailable', async () => {
    vi.useFakeTimers();
    const { a, active, replace } = fixture();
    const pending = run(a);
    const rejected = expect(pending).rejects.toThrow('inactive');
    await vi.advanceTimersByTimeAsync(0);
    replace({ ...active(), subscribed: false });
    await finish(a);
    await vi.advanceTimersByTimeAsync(2500);
    await rejected;
    expect(a.router.send).not.toHaveBeenCalled();
    expect(a.store.insert).not.toHaveBeenCalled();
  });
});
