import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { AgentWorkLifetime } from '../src/agent-work-lifetime.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { PublicSnapshotMethods } from '../src/dkg-agent-public-snapshot.js';
import * as recoveryGraph from '../src/durable-recovery-graph.js';
import type { PhysicalDurableSyncResult } from '../src/durable-recovery-types.js';
import * as exactRecovery from '../src/exact-recovery-execution.js';
import { VM_RECOVERY_SYNC_PRIORITY } from '../src/sync/catchup-policy.js';
import { createDurableSyncAccumulator, finalizeDurableSyncCompletion } from '../src/sync/durable-progress.js';
import { exactAssetUalsForSelection } from '../src/sync/exact-assets.js';
import { materializeVerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';
import { VM_RECOVERY_STREAM_SETBACK_LIMITS } from '../src/vm-recovery-stream-setback-policy.js';
import { PUBLIC_SNAPSHOT_RETRY_MS } from '../src/public-snapshot-exact-pacing.js';
import {
  countStoredAssets, makeSnapshotAssets, sealSnapshotOf, type SnapshotAsset,
} from './helpers/public-snapshot-assets.js';

// The node profile under test: one general sync slot and no queue. Admission,
// the job, its waits, evidence authentication and the atomic store writes are
// real; only the admitted transfer is a fixture that hands over verified assets.
const graph = 'busy-slot-snapshot';
const empty = () => finalizeDurableSyncCompletion(createDurableSyncAccumulator());
const makeAssets = (count: number) => makeSnapshotAssets(graph, count);
type Asset = SnapshotAsset;

function makeAgent(assets: Asset[]) {
  let generation = 0;
  const store = new OxigraphStore();
  // A fresh observation on every read, so a long wait never meets an expired snapshot.
  const snapshot = () => sealSnapshotOf(graph, assets);
  const agent: any = {
    started: true, workLifetime: new AgentWorkLifetime(), store, node: {},
    config: { nodeRole: 'edge', syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 },
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    subscribedContextGraphs: new Map(),
    getSubscribedContextGraphs: () => agent.subscribedContextGraphs,
    contextGraphBindingState: { capture: () => generation, isGenerationCurrent: (_: string, g: number) => g === generation },
    chain: { chainId: 'evm:31337', deploymentId: 'test', readPublicGraphSnapshot: vi.fn(async () => snapshot()) },
    router: { send: vi.fn(async () => { throw new Error('rpc-only jobs never ask a core'); }) },
    subscribeToContextGraph: (_: string, binding: object) => {
      generation++;
      agent.subscribedContextGraphs.set(graph, { subscribed: true, ...binding });
    },
    // Unsubscribing or rebinding moves the binding generation; it aborts no signal.
    invalidateBinding: () => { generation++; },
    runContextGraphSyncWithBackpressure: LifecycleSyncMethods.prototype.runContextGraphSyncWithBackpressure,
    vmRecoverySyncAdmissionAvailable: vi.fn((id: string) => LifecycleSyncMethods.prototype.vmRecoverySyncAdmissionAvailable.call(agent, id)),
  };
  return agent;
}

/** The admitted transfer: authenticate each requested asset with the job's evidence and store it atomically. */
function deliver(store: OxigraphStore, assets: Asset[]) {
  const byUal = new Map(assets.map(asset => [asset.ual, asset]));
  return async (request: Parameters<typeof recoveryGraph.runAdmittedDurableGraph>[0]): Promise<PhysicalDurableSyncResult> => {
    const committedExactAssetUals: string[] = [];
    for (const ual of exactAssetUalsForSelection(request.options!.exactAssetFetchPolicy!.selection)) {
      const authenticated = await request.authority.authenticate(byUal.get(ual)!.verified, performance.now() + 120_000);
      expect(await materializeVerifiedGraphScopedAsset({ store, asset: authenticated.asset })).toBe('applied');
      committedExactAssetUals.push(ual);
    }
    return { result: empty(), exactFetchDisposition: 'found', committedExactAssetUals, exactStreamOutcome: 'complete' };
  };
}

const run = (agent: any, options: { signal?: AbortSignal; peers?: string[] } = {}) =>
  PublicSnapshotMethods.prototype.syncPublicGraphSnapshot.call(agent, {
    contextGraphId: graph, onChainId: '1', trustedCorePeerIds: options.peers ?? ['core-a'], mode: 'rpc-only',
    ...(options.signal ? { signal: options.signal } : {}),
  });

/** Drive the fake clock until the job settles. */
async function settle<T>(job: Promise<T>, stepMs = 500, maxSteps = 2_000) {
  let outcome: { value: T } | { error: unknown } | undefined;
  job.then(value => { outcome = { value }; }, error => { outcome = { error }; });
  for (let step = 0; step < maxSteps && !outcome; step++) await vi.advanceTimersByTimeAsync(stepMs);
  if (!outcome) throw new Error('Snapshot job did not settle');
  return outcome;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('public snapshot job on a node with one sync slot and no queue', () => {
  it('waits while a competing admitted sync holds the slot, then completes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const assets = makeAssets(12);
    const agent = makeAgent(assets);
    const attempts = vi.spyOn(exactRecovery, 'runExactRecovery');
    const transfer = vi.spyOn(recoveryGraph, 'runAdmittedDurableGraph').mockImplementation(deliver(agent.store, assets));
    let releasedAt = Number.POSITIVE_INFINITY;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = () => { releasedAt = Math.min(releasedAt, Date.now()); resolve(); }; });
    // Another admitted sync (a VM reconcile pass, an on-connect sync) takes the only slot.
    const competing = agent.runContextGraphSyncWithBackpressure(createOperationContext('sync'), 'other-graph', 'durable',
      'competing-sync', () => held, { priorityOverride: VM_RECOVERY_SYNC_PRIORITY, source: 'vm-recovery' });
    // Far longer than the old ten-singleton burst, which was refused within milliseconds.
    setTimeout(release, 20_000);
    const startedAt = Date.now();
    try {
      const outcome = await settle(run(agent));
      expect(outcome).toHaveProperty('value');
      expect('value' in outcome && outcome.value).toMatchObject({ assets: 12, committed: 12, alreadyPresent: 0, current: true });
    } finally { release(); await competing; }
    expect(releasedAt - startedAt).toBe(20_000);
    const first = await attempts.mock.results[0]!.value;
    expect(first).toMatchObject({ admission: 'local-admission-deferred', result: { deferredBackpressure: 1 } });
    // One refused attempt; the job then read capacity instead of asking again while the slot was held.
    expect(attempts).toHaveBeenCalledTimes(3);
    expect(agent.vmRecoverySyncAdmissionAvailable.mock.calls.length).toBeGreaterThan(2);
    expect(attempts.mock.calls.every(([request]) => request.options.exactRecoveryTransportMode === 'stream-preferred')).toBe(true);
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(transfer.mock.invocationCallOrder[0]).toBeGreaterThan(attempts.mock.invocationCallOrder[0]!);
    expect(await countStoredAssets(agent.store, assets)).toBe(12);
    expect(agent.log.info).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('waiting for local sync capacity'));
  });

  it('asks a core that answers BUSY again after its hold-off until it serves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const assets = makeAssets(12);
    const agent = makeAgent(assets);
    const serve = deliver(agent.store, assets);
    const askedAt: number[] = [];
    const transfer = vi.spyOn(recoveryGraph, 'runAdmittedDurableGraph').mockImplementation(async request => {
      askedAt.push(Date.now());
      // The stream driver has already retried BUSY three times inside this slot.
      if (askedAt.length <= 4) return { result: empty(), exactFetchDisposition: 'incomplete', exactStreamOutcome: 'responder-busy' };
      return serve(request);
    });
    const outcome = await settle(run(agent));
    expect(outcome).toHaveProperty('value');
    expect('value' in outcome && outcome.value).toMatchObject({ assets: 12, committed: 12, current: true });
    expect(transfer).toHaveBeenCalledTimes(6);
    for (let index = 1; index <= 4; index++) {
      expect(askedAt[index]! - askedAt[index - 1]!).toBeGreaterThanOrEqual(VM_RECOVERY_STREAM_SETBACK_LIMITS.holdOffMs);
    }
    expect(transfer.mock.calls.every(([request]) => request.remotePeerId === 'core-a'
      && request.options!.exactRecoveryTransportMode === 'stream-preferred')).toBe(true);
    expect(agent.log.info).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('waiting for a busy core'));
  });

  it('asks another configured core while a busy one is held off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const assets = makeAssets(10);
    const agent = makeAgent(assets);
    const serve = deliver(agent.store, assets);
    const transfer = vi.spyOn(recoveryGraph, 'runAdmittedDurableGraph').mockImplementation(async request => (
      request.remotePeerId === 'core-a'
        ? { result: empty(), exactFetchDisposition: 'incomplete', exactStreamOutcome: 'responder-busy' }
        : serve(request)));
    const outcome = await settle(run(agent, { peers: ['core-a', 'core-b'] }));
    expect(outcome).toHaveProperty('value');
    expect(transfer.mock.calls.map(([request]) => request.remotePeerId)).toEqual(['core-a', 'core-b']);
  });

  it('skips the half an interrupted job already stored when it is started again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const assets = makeAssets(20);
    const agent = makeAgent(assets);
    const serve = deliver(agent.store, assets);
    const caller = new AbortController();
    const requested: string[][] = [];
    const transfer = vi.spyOn(recoveryGraph, 'runAdmittedDurableGraph').mockImplementation(async request => {
      requested.push(exactAssetUalsForSelection(request.options!.exactAssetFetchPolicy!.selection));
      if (requested.length === 2) {
        caller.abort(new Error('operator stopped the job'));
        return { result: empty(), exactFetchDisposition: 'incomplete' };
      }
      return serve(request);
    });
    const interrupted = await settle(run(agent, { signal: caller.signal }));
    expect(interrupted).toHaveProperty('error');
    expect(await countStoredAssets(agent.store, assets)).toBe(10);
    requested.length = 0;
    transfer.mockImplementation(async request => {
      requested.push(exactAssetUalsForSelection(request.options!.exactAssetFetchPolicy!.selection));
      return serve(request);
    });
    const resumed = await settle(run(agent));
    expect(resumed).toHaveProperty('value');
    expect('value' in resumed && resumed.value).toMatchObject({ assets: 20, committed: 20, alreadyPresent: 10, current: true });
    expect(requested.map(selection => new Set(selection))).toEqual([new Set(assets.slice(10).map(asset => asset.ual))]);
    expect(await countStoredAssets(agent.store, assets)).toBe(20);
  });

  it('stops waiting within one interval when the graph is rebound, and releases the job guard', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const assets = makeAssets(12);
    const agent = makeAgent(assets);
    vi.spyOn(recoveryGraph, 'runAdmittedDurableGraph').mockImplementation(deliver(agent.store, assets));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const competing = agent.runContextGraphSyncWithBackpressure(createOperationContext('sync'), 'other-graph', 'durable',
      'competing-sync', () => held, { priorityOverride: VM_RECOVERY_SYNC_PRIORITY, source: 'vm-recovery' });
    try {
      let rejectedAt = 0;
      const stale = run(agent).finally(() => { rejectedAt = Date.now(); });
      const rejected = expect(stale).rejects.toThrow('Snapshot job ownership changed');
      await vi.advanceTimersByTimeAsync(60_000);
      agent.invalidateBinding();
      const reboundAt = Date.now();
      await vi.advanceTimersByTimeAsync(PUBLIC_SNAPSHOT_RETRY_MS);
      // Settled within one interval of the rebind, not at the job limit.
      expect(rejectedAt).toBeGreaterThan(0);
      expect(rejectedAt - reboundAt).toBeLessThanOrEqual(PUBLIC_SNAPSHOT_RETRY_MS);
      await rejected;
      // The node-wide guard is free again: the next job starts and completes once the slot frees.
      const next = run(agent);
      await vi.advanceTimersByTimeAsync(10_000);
      release();
      expect(await settle(next)).toMatchObject({ value: { committed: 12, current: true } });
    } finally { release(); await competing; }
  });

  it('fails with the committed count when the slot stays in use until the job limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const assets = makeAssets(12);
    const agent = makeAgent(assets);
    vi.spyOn(recoveryGraph, 'runAdmittedDurableGraph').mockImplementation(deliver(agent.store, assets));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const competing = agent.runContextGraphSyncWithBackpressure(createOperationContext('sync'), 'other-graph', 'durable',
      'competing-sync', () => held, { priorityOverride: VM_RECOVERY_SYNC_PRIORITY, source: 'vm-recovery' });
    const startedAt = Date.now();
    try {
      const outcome = await settle(run(agent), 10_000, 400);
      expect(outcome).toHaveProperty('error');
      expect(String((outcome as { error: Error }).error.message))
        .toBe('Snapshot recovery incomplete: 0/12 committed (local sync capacity stayed in use)');
      // The wait ends before the job's own limit, leaving the final read its reserve.
      expect(Date.now() - startedAt).toBeLessThan(3_600_000);
      expect(Date.now() - startedAt).toBeGreaterThan(3_000_000);
    } finally { release(); await competing; }
  });
});
