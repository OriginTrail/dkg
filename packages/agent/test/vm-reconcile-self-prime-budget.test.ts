import { afterEach, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import { VmReconcileShutdownTimeoutError } from '../src/vm-reconcile-service.js';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { VmReconcileDispatcher } from '../src/chain-reconciler.js';

type Subscription = { subscribed: boolean; coreHosted?: boolean; onChainId?: string };
interface Internals {
  subscribedContextGraphs: Map<string, Subscription>;
  node: unknown;
  vmReconcileDispatcher: VmReconcileDispatcher<boolean>;
  vmReconcileLifecycleController: AbortController;
  resolveVmReconcileTarget(cg: string, isCurrent?: () => boolean, signal?: AbortSignal): Promise<unknown>;
  runVmReconcileSweep(): Promise<void>;
  scheduleVmReconcileSweep(): void;
  handleKARegisteredNudge(id: string, ka: bigint, context: ReturnType<typeof createOperationContext>): Promise<string | null>;
  openVmReconcileRotationState(): void;
  closeVmReconcileRotationState(): void;
  resolveContextGraphOnChainIdBinding(id: string): Promise<{ onChainId: string; provenance: 'ontology' } | null>;
}
const agents: DKGAgent[] = [];
const dispatchers: VmReconcileDispatcher<boolean>[] = [];
afterEach(async () => {
  for (const dispatcher of dispatchers.splice(0)) await dispatcher.close();
  for (const agent of agents.splice(0)) await agent.stop();
  vi.restoreAllMocks();
});
async function fixture(unbound: number, maxPending = 64) {
  const agent = await DKGAgent.create({ name: 'BoundedSelfPrime', chainAdapter: new MockChainAdapter() });
  agents.push(agent);
  const internals = agent as unknown as Internals;
  internals.node = { peerId: '12D3KooWSelfPrimeBudget', libp2p: { getPeers: () => [] } };
  internals.openVmReconcileRotationState();
  for (let i = 0; i < unbound; i++) internals.subscribedContextGraphs.set(`cg-${i}`, { subscribed: true });
  const order: string[] = [];
  const canRead = vi.spyOn(agent, 'canReadContextGraph').mockResolvedValue(true);
  const resolve = vi.spyOn(internals, 'resolveContextGraphOnChainIdBinding').mockImplementation(async (id) => {
    order.push(`resolve:${id}`); return null;
  });
  const installDispatcher = () => {
    const signal = internals.vmReconcileLifecycleController.signal;
    const dispatcher = new VmReconcileDispatcher(async (cg) => {
      order.push(`dispatch:${cg}`);
      await internals.resolveVmReconcileTarget(cg, () => !signal.aborted, signal);
      return true;
    }, () => undefined, { concurrency: 1, maxPending });
    dispatchers.push(dispatcher);
    internals.vmReconcileDispatcher = dispatcher;
    return dispatcher;
  };
  installDispatcher();
  const triggerLive = vi.spyOn(internals.vmReconcileDispatcher, 'triggerLive');
  return { internals, resolve, canRead, order, triggerLive, installDispatcher };
}

it('performs zero unbound resolution calls for a burst of unmatched live events', async () => {
  const { internals, resolve, canRead, triggerLive } = await fixture(50);
  for (let event = 0; event < 100; event++) {
    expect(await internals.handleKARegisteredNudge(String(1_000 + event), BigInt(event), createOperationContext('system'))).toBeNull();
  }
  expect(resolve.mock.calls.length).toBe(0);
  expect(canRead.mock.calls.length).toBe(0);
  expect(triggerLive).not.toHaveBeenCalled();
});

it.each([3, 8, 16, 26])('covers %i stable unbound subscriptions fairly with at most eight lookups per sweep', async (count) => {
  const { internals, resolve } = await fixture(count);
  // A tail of bound rows must not create an empty sweep at the iterator wrap.
  for (let i = 0; i < 20; i++) internals.subscribedContextGraphs.set(`bound-${i}`, { subscribed: true, onChainId: String(i + 1) });
  const rounds = Math.ceil(count / 8);
  for (let cycle = 0; cycle < 2; cycle++) {
    const seen = new Set<string>();
    for (let round = 0; round < rounds; round++) {
      resolve.mockClear();
      internals.scheduleVmReconcileSweep();
      await internals.vmReconcileDispatcher.waitForIdle();
      expect(resolve.mock.calls.length).toBeLessThanOrEqual(8);
      const ids = resolve.mock.calls.map(([id]) => id);
      expect(new Set(ids).size).toBe(ids.length);
      ids.forEach((id) => seen.add(id));
    }
    expect([...seen].sort()).toEqual(Array.from({ length: count }, (_, i) => `cg-${i}`).sort());
  }
});

it('admits already-bound reconciliation before unbound resolution work', async () => {
  const { internals, order } = await fixture(30);
  internals.subscribedContextGraphs.set('bound', { subscribed: true, onChainId: '31' });
  internals.scheduleVmReconcileSweep();
  await internals.vmReconcileDispatcher.waitForIdle();
  expect(order[0]).toBe('dispatch:bound');
});

it('counts denied read-authority checks against the unbound attempt budget', async () => {
  const { internals, canRead, resolve } = await fixture(30);
  canRead.mockResolvedValue(false);
  internals.scheduleVmReconcileSweep();
  await internals.vmReconcileDispatcher.waitForIdle();
  expect(canRead).toHaveBeenCalledTimes(8);
  expect(resolve).not.toHaveBeenCalled();
});

it('handles deletion, binding, replacement and appended subscriptions without skipping surviving candidates', async () => {
  const { internals, resolve } = await fixture(20);
  internals.scheduleVmReconcileSweep();
  await internals.vmReconcileDispatcher.waitForIdle();
  internals.subscribedContextGraphs.delete('cg-8');
  internals.subscribedContextGraphs.set('cg-9', { subscribed: true });
  internals.subscribedContextGraphs.set('cg-10', { subscribed: true, onChainId: '110' });
  for (let i = 20; i < 23; i++) internals.subscribedContextGraphs.set(`cg-${i}`, { subscribed: true });
  resolve.mockClear();
  internals.scheduleVmReconcileSweep();
  await internals.vmReconcileDispatcher.waitForIdle();
  internals.scheduleVmReconcileSweep();
  await internals.vmReconcileDispatcher.waitForIdle();
  const ids = resolve.mock.calls.map(([id]) => id);
  expect(ids).not.toContain('cg-8');
  expect(ids).not.toContain('cg-10');
  for (const id of ['cg-9', ...Array.from({ length: 12 }, (_, i) => `cg-${i + 11}`)]) expect(ids).toContain(id);
});

it('fences a subscription replaced during its read-authority lookup', async () => {
  const { internals, canRead, resolve } = await fixture(1);
  canRead.mockImplementation(async () => {
    internals.subscribedContextGraphs.set('cg-0', { subscribed: false });
    return true;
  });
  internals.scheduleVmReconcileSweep();
  await internals.vmReconcileDispatcher.waitForIdle();
  expect(resolve).not.toHaveBeenCalled();
});

it.each(['binding', 'read-authority'])('stops during %s lookup and starts a new cursor when reopened', async (stage) => {
  const { internals, resolve, canRead, installDispatcher } = await fixture(20);
  let release!: () => void;
  const pending = new Promise<void>((done) => { release = done; });
  const blocked = stage === 'binding' ? resolve : canRead;
  if (stage === 'binding') resolve.mockReturnValueOnce(pending.then(() => null));
  else canRead.mockReturnValueOnce(pending.then(() => true));
  try {
    internals.scheduleVmReconcileSweep();
    await vi.waitFor(() => expect(blocked.mock.calls.length).toBe(1));
    internals.closeVmReconcileRotationState();
    await internals.vmReconcileDispatcher.close();
    expect(resolve.mock.calls.length).toBe(stage === 'binding' ? 1 : 0);
    internals.openVmReconcileRotationState();
    installDispatcher();
    resolve.mockClear();
    internals.scheduleVmReconcileSweep();
    await internals.vmReconcileDispatcher.waitForIdle();
    expect(resolve.mock.calls.map(([id]) => id)).toEqual(Array.from({ length: 8 }, (_, i) => `cg-${i}`));
  } finally { release(); }
});

it.each(['bound', 'cg-0'])('keeps bounded discovery progressing while %s reconciliation never settles', async (blockedId) => {
  const { internals, canRead, resolve, order } = await fixture(24);
  internals.subscribedContextGraphs.set('bound', { subscribed: true, onChainId: '42' });
  let release!: () => void;
  const pending = new Promise<void>((done) => { release = done; });
  const targetResolver = internals as unknown as { resolveVmReconcileTarget(id: string): Promise<unknown> };
  resolve.mockImplementation(async (id) => {
    order.push(`resolve:${id}`);
    return id === 'cg-0' ? { onChainId: '43', provenance: 'ontology' } : null;
  });
  const dispatcher = new VmReconcileDispatcher(async (id) => {
    await targetResolver.resolveVmReconcileTarget(id);
    if (id === blockedId) await pending;
    return true;
  }, () => undefined, { concurrency: 2, maxPending: 32 });
  internals.vmReconcileDispatcher = dispatcher;
  internals.scheduleVmReconcileSweep();
  try {
    await vi.waitFor(() => expect(new Set(resolve.mock.calls.map(([id]) => id)).size).toBe(8), { timeout: 300 });
    expect(canRead.mock.calls.filter(([id]) => id === 'cg-0')).toHaveLength(1);
    resolve.mockClear();
    internals.scheduleVmReconcileSweep();
    await vi.waitFor(() => expect(new Set(resolve.mock.calls.map(([id]) => id)).size).toBe(8), { timeout: 300 });
    expect(resolve.mock.calls.map(([id]) => id)).toEqual(Array.from({ length: 8 }, (_, i) => `cg-${i + 8}`));
  } finally {
    release();
    await dispatcher.close();
  }
});

it('keeps discovery fair when the bound set exceeds queue capacity', async () => {
  const { internals, resolve, order } = await fixture(20, 3);
  for (let i = 0; i < 100; i++) internals.subscribedContextGraphs.set(`bound-${i}`, { subscribed: true, onChainId: String(i + 1) });
  const seen = new Set<string>();
  for (let sweep = 0; sweep < 10; sweep++) {
    resolve.mockClear();
    internals.scheduleVmReconcileSweep();
    expect(internals.vmReconcileDispatcher.snapshot().queued).toBeLessThanOrEqual(3);
    await internals.vmReconcileDispatcher.waitForIdle();
    expect(resolve.mock.calls.length).toBeLessThanOrEqual(8);
    for (const [id] of resolve.mock.calls) seen.add(id);
  }
  expect(order[0]).toBe('dispatch:bound-0');
  expect(seen).toEqual(new Set(Array.from({ length: 20 }, (_, i) => `cg-${i}`)));
});

it('advances discovery under a sustained bound backlog without waiting for idle', async () => {
  const { internals, resolve } = await fixture(20, 3);
  for (let i = 0; i < 100; i++) internals.subscribedContextGraphs.set(`bound-${i}`, { subscribed: true, onChainId: String(i + 1) });
  const releases: Array<() => void> = [];
  const started: string[] = [];
  let paused = true;
  const dispatcher = new VmReconcileDispatcher(async (id) => {
    started.push(id);
    try { await internals.resolveVmReconcileTarget(id); }
    finally { if (paused) await new Promise<void>(done => releases.push(done)); }
    return true;
  }, () => undefined, { concurrency: 1, maxPending: 3 });
  internals.vmReconcileDispatcher = dispatcher;
  try {
    for (let tick = 0; tick < 100; tick++) {
      internals.scheduleVmReconcileSweep();
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      releases.shift()!(); // Exactly one completion; the queue stays backlogged.
      if (new Set(resolve.mock.calls.map(([id]) => id)).size === 20) break;
    }
    expect(started[0]).toBe('bound-0');
    expect(new Set(resolve.mock.calls.map(([id]) => id))).toEqual(new Set(Array.from({ length: 20 }, (_, i) => `cg-${i}`)));
    expect(new Set(started.filter(id => id.startsWith('bound-'))).size).toBeGreaterThan(1);
  } finally {
    paused = false;
    for (const release of releases.splice(0)) release();
    await dispatcher.close();
  }
});

it.each([1, 3])('reserves foreground admission with maxPending=%i while the sweep is backlogged', async (maxPending) => {
  const { internals } = await fixture(20, maxPending);
  for (let i = 0; i < 100; i++) internals.subscribedContextGraphs.set(`bound-${i}`, { subscribed: true, onChainId: String(i + 1) });
  const releases: Array<() => void> = [];
  const started: string[] = [];
  let paused = true;
  const dispatcher = new VmReconcileDispatcher(async (id) => {
    started.push(id);
    if (paused) await new Promise<void>(done => releases.push(done));
    return true;
  }, () => undefined, { concurrency: 1, maxPending });
  internals.vmReconcileDispatcher = dispatcher;
  try {
    internals.scheduleVmReconcileSweep();
    const failures: unknown[] = [];
    const foreground = dispatcher.triggerManual('foreground').catch(error => { failures.push(error); });
    for (let tick = 0; tick < 4 && !started.includes('foreground'); tick++) {
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      releases.shift()!();
      internals.scheduleVmReconcileSweep();
    }
    expect(failures).toEqual([]);
    expect(started).toContain('foreground');
    paused = false;
    for (const release of releases.splice(0)) release();
    await foreground;
  } finally {
    paused = false;
    for (const release of releases.splice(0)) release();
    await dispatcher.close();
  }
});

it('keeps the public sweep completion pending until its admitted work finishes', async () => {
  const { internals, canRead, resolve } = await fixture(1);
  let release!: () => void;
  const authority = new Promise<boolean>(done => { release = () => done(true); });
  canRead.mockReturnValueOnce(authority);
  let completed = false;
  const sweep = internals.runVmReconcileSweep().then(() => { completed = true; });
  try {
    await vi.waitFor(() => expect(canRead).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    release();
    await sweep;
    expect(resolve).toHaveBeenCalledOnce();
    expect(internals.vmReconcileDispatcher.snapshot()).toMatchObject({ active: 0, queued: 0 });
  } finally { release(); await sweep; }
});

it('keeps a non-cooperative authority lookup in physical shutdown retirement', async () => {
  const agent = await DKGAgent.create({ name: 'AuthorityRetirement', chainAdapter: new MockChainAdapter() });
  agents.push(agent);
  await agent.start();
  const internals = agent as unknown as Internals & { store: TripleStore; node: { stop(): Promise<void> } };
  internals.subscribedContextGraphs.set('authority-pending', { subscribed: true, onChainId: '42' });
  let release!: () => void;
  const authority = new Promise<boolean>(done => { release = () => done(true); });
  const canRead = vi.spyOn(agent, 'canReadContextGraph').mockReturnValue(authority);
  const closeStore = vi.spyOn(internals.store, 'close');
  const stopNode = vi.spyOn(internals.node, 'stop');
  const originalTimeout = DKGAgentBase.VM_RECONCILE_SHUTDOWN_TIMEOUT_MS;
  Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_SHUTDOWN_TIMEOUT_MS', { configurable: true, value: 20 });
  const sweep = internals.runVmReconcileSweep();
  try {
    await vi.waitFor(() => expect(canRead).toHaveBeenCalled());
    await expect(agent.stop()).rejects.toBeInstanceOf(VmReconcileShutdownTimeoutError);
    expect(closeStore).not.toHaveBeenCalled();
    expect(stopNode).not.toHaveBeenCalled();
    await expect(agent.start()).rejects.toBeInstanceOf(VmReconcileShutdownTimeoutError);
    release();
    await sweep;
    await agent.stop();
    expect(closeStore).toHaveBeenCalledOnce();
    expect(stopNode).toHaveBeenCalledOnce();
  } finally {
    release();
    await sweep;
    Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_SHUTDOWN_TIMEOUT_MS', { configurable: true, value: originalTimeout });
    await agent.stop();
  }
});
