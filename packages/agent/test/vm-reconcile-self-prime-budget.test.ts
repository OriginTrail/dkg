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
  vmReconcilePhysicalRuns: Set<Promise<unknown>>;
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


it('completes every selected bound target when capacity is smaller than the sweep', async () => {
  const { internals, order } = await fixture(0, 1);
  for (let i = 0; i < 5; i++) internals.subscribedContextGraphs.set(`bound-${i}`, { subscribed: true, onChainId: String(i + 1) });
  await internals.runVmReconcileSweep();
  expect(order.filter(id => id.startsWith('dispatch:'))).toEqual(Array.from({ length: 5 }, (_, i) => `dispatch:bound-${i}`));
});

it('completes an empty sweep without waiting for unrelated manual work', async () => {
  const { internals } = await fixture(0);
  let release!: () => void;
  const blocked = new Promise<void>(done => { release = done; });
  const dispatcher = new VmReconcileDispatcher(async () => { await blocked; return true; }, () => undefined);
  internals.vmReconcileDispatcher = dispatcher;
  const manual = dispatcher.triggerManual('unrelated');
  let completed = false;
  const sweep = internals.runVmReconcileSweep().then(() => { completed = true; });
  try {
    await vi.waitFor(() => expect(completed).toBe(true), { timeout: 100 });
    expect(dispatcher.isInFlight('unrelated')).toBe(true);
  } finally { release(); await manual; await sweep; await dispatcher.close(); }
});

it.each(['fulfilled', 'rejected'])('retires a %s authority read before shutdown', async outcome => {
  const { internals, canRead } = await fixture(1);
  let fulfill!: (value: boolean) => void;
  let reject!: (reason: Error) => void;
  const authority = new Promise<boolean>((yes, no) => { fulfill = yes; reject = no; });
  canRead.mockReturnValueOnce(authority);
  const run = internals.resolveVmReconcileTarget('cg-0').catch(() => undefined);
  try {
    expect(internals.vmReconcilePhysicalRuns.has(authority)).toBe(true);
    if (outcome === 'fulfilled') fulfill(true);
    else reject(new Error('authority unavailable'));
    await run;
    expect(internals.vmReconcilePhysicalRuns.size).toBe(0);
  } finally { fulfill(false); await run; }
});

it.each([500n, 501n])('preserves the public bigint target argument %s and binds only a matching ID', async target => {
  const { internals, resolve } = await fixture(1);
  resolve.mockResolvedValue({ onChainId: '500', provenance: 'ontology' });
  const agent = internals as unknown as DKGAgent;
  const sub = internals.subscribedContextGraphs.get('cg-0')!;
  await expect(agent.selfPrimeSubscriptionOnChainId('cg-0', sub as Parameters<DKGAgent['selfPrimeSubscriptionOnChainId']>[1], target)).resolves.toBe(target === 500n ? '500' : null);
  expect(sub.onChainId).toBe(target === 500n ? '500' : undefined);
});


it('finishes its admitted targets while an unrelated concurrent manual task remains active', async () => {
  const { internals } = await fixture(0);
  internals.subscribedContextGraphs.set('bound', { subscribed: true, onChainId: '1' });
  let release!: () => void;
  const blocked = new Promise<void>(done => { release = done; });
  const ran: string[] = [];
  const dispatcher = new VmReconcileDispatcher(async key => {
    ran.push(key);
    if (key === 'unrelated') await blocked;
    return true;
  }, () => undefined, { concurrency: 2 });
  internals.vmReconcileDispatcher = dispatcher;
  const manual = dispatcher.triggerManual('unrelated');
  let completed = false;
  const sweep = internals.runVmReconcileSweep().then(() => { completed = true; });
  try {
    await vi.waitFor(() => expect(completed).toBe(true), { timeout: 200 });
    expect(ran).toContain('bound');
    expect(dispatcher.isInFlight('unrelated')).toBe(true);
  } finally { release(); await manual; await sweep; await dispatcher.close(); }
});

it('completes one bounded discovery allowance despite a one-slot queue', async () => {
  const { internals, resolve } = await fixture(20, 1);
  await internals.runVmReconcileSweep();
  expect(resolve.mock.calls.map(([key]) => key)).toEqual(Array.from({ length: 8 }, (_, i) => `cg-${i}`));
  resolve.mockClear();
  await internals.runVmReconcileSweep();
  expect(resolve.mock.calls.map(([key]) => key)).toEqual(Array.from({ length: 8 }, (_, i) => `cg-${i + 8}`));
});

it('releases a capacity-waiting sweep on lifecycle closure without admitting its remaining keys', async () => {
  const { internals, canRead, order } = await fixture(0, 1);
  for (let i = 0; i < 3; i++) internals.subscribedContextGraphs.set(`bound-${i}`, { subscribed: true, onChainId: String(i + 1) });
  let release!: () => void;
  canRead.mockReturnValueOnce(new Promise<boolean>(done => { release = () => done(true); }));
  const sweep = internals.runVmReconcileSweep();
  try {
    await vi.waitFor(() => expect(canRead).toHaveBeenCalledOnce());
    internals.closeVmReconcileRotationState();
    await internals.vmReconcileDispatcher.close();
    await sweep;
    expect(order.filter(key => key.startsWith('dispatch:'))).toEqual(['dispatch:bound-0']);
  } finally { release(); await sweep; }
});

it('waits for relevant trailing capacity without spinning when another worker is free', async () => {
  const { internals } = await fixture(0);
  internals.subscribedContextGraphs.set('B', { subscribed: true, onChainId: '2' });
  const gates = new Map<string, () => void>();
  const runs = new Map<string, number>();
  const dispatcher = new VmReconcileDispatcher(async key => {
    const count = (runs.get(key) ?? 0) + 1; runs.set(key, count);
    if (count === 1) await new Promise<void>(resolve => { gates.set(key, resolve); });
    return true;
  }, () => undefined, { concurrency: 3, maxPending: 2 });
  dispatchers.push(dispatcher); internals.vmReconcileDispatcher = dispatcher;
  for (const key of ['A', 'B', 'C']) dispatcher.triggerLive(key);
  await vi.waitFor(() => expect(gates.size).toBe(3));
  dispatcher.triggerLive('A');
  gates.get('C')!(); await dispatcher.waitForIdle('C');
  expect(dispatcher.snapshot()).toMatchObject({ active: 2, queued: 1 });
  // Cap attempts so a regression reports a failure instead of hanging Vitest's event loop.
  const admission = dispatcher as unknown as { admit(key: string, source: string): unknown };
  const original = admission.admit.bind(dispatcher);
  const attempts = vi.spyOn(admission, 'admit').mockImplementation((key, source) => {
    if (attempts.mock.calls.length > 10) throw new Error('periodic admission busy-spin');
    return original(key, source);
  });
  let failure: unknown;
  const sweep = internals.runVmReconcileSweep().catch(error => { failure = error; });
  try {
    await new Promise(resolve => setTimeout(resolve, 5)); // event-loop heartbeat must run
    expect(failure).toBeUndefined();
    expect(attempts).toHaveBeenCalledTimes(1);
  } finally {
    gates.get('A')!(); gates.get('B')!();
    await sweep;
    await dispatcher.waitForIdle();
  }
  expect(runs.get('B')).toBe(2);
});

it.each(['pending', 'active'] as const)('awaits the exact %s coalesced or trailing target completion', async state => {
  const { internals } = await fixture(0);
  internals.subscribedContextGraphs.set('selected', { subscribed: true, onChainId: '2' });
  const releases: Array<() => void> = [];
  const sources: string[] = [];
  const dispatcher = new VmReconcileDispatcher(async (key, source) => {
    sources.push(`${key}:${source}`);
    await new Promise<void>(resolve => { releases.push(resolve); });
    return true;
  }, () => undefined, { concurrency: 1, maxPending: 4 });
  dispatchers.push(dispatcher); internals.vmReconcileDispatcher = dispatcher;
  if (state === 'pending') dispatcher.triggerLive('blocker');
  dispatcher.triggerLive('selected');
  await vi.waitFor(() => expect(releases).toHaveLength(1));
  let settled = false;
  const sweep = internals.runVmReconcileSweep().then(() => { settled = true; });
  try {
    await Promise.resolve(); expect(settled).toBe(false);
    releases[0]!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(settled).toBe(false);
    releases[1]!(); await sweep;
    expect(sources).toEqual(state === 'pending'
      ? ['blocker:live', 'selected:live'] : ['selected:live', 'selected:periodic']);
  } finally {
    for (const release of releases) release();
    await sweep;
  }
});

it('joins the leading admission of a timer turn resumed by a public sweep', async () => {
  const { internals } = await fixture(1);
  internals.subscribedContextGraphs.set('A', { subscribed: true, onChainId: '1' });
  internals.subscribedContextGraphs.set('B', { subscribed: true, onChainId: '2' });
  let releaseX!: () => void;
  let releaseA!: () => void;
  const x = new Promise<void>(resolve => { releaseX = resolve; });
  const a = new Promise<void>(resolve => { releaseA = resolve; });
  const ran: string[] = [];
  const dispatcher = new VmReconcileDispatcher(async key => {
    ran.push(key);
    if (key === 'X') await x;
    if (key === 'A') await a;
    return true;
  }, () => {}, { concurrency: 2, maxPending: 1 });
  dispatchers.push(dispatcher); internals.vmReconcileDispatcher = dispatcher;
  const unrelated = dispatcher.triggerManual('X');
  internals.scheduleVmReconcileSweep();
  let settled = false;
  const sweep = internals.runVmReconcileSweep().then(() => { settled = true; });
  try {
    await vi.waitFor(() => expect(ran).toEqual(['X', 'A']));
    internals.scheduleVmReconcileSweep();
    releaseX(); await unrelated;
    await vi.waitFor(() => expect(ran).toContain('B'));
    await dispatcher.waitForIdle('B');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(ran).toContain('cg-0');
    expect(settled).toBe(false);
    expect(dispatcher.isInFlight('A')).toBe(true);
    releaseA(); await sweep;
  } finally { releaseX(); releaseA(); await sweep; }
});

it('gives overlapping public sweeps their own admitted completion boundaries', async () => {
  const { internals } = await fixture(1);
  internals.subscribedContextGraphs.set('A', { subscribed: true, onChainId: '1' });
  const release: Array<() => void> = [];
  const ran: string[] = [];
  let draining = false;
  const dispatcher = new VmReconcileDispatcher(async key => {
    ran.push(key);
    if (key === 'A' && !draining) await new Promise<void>(resolve => { release.push(resolve); });
    return true;
  }, () => {}, { concurrency: 1, maxPending: 4 });
  dispatchers.push(dispatcher); internals.vmReconcileDispatcher = dispatcher;
  let firstSettled = false, secondSettled = false;
  const first = internals.runVmReconcileSweep().then(() => { firstSettled = true; });
  const second = internals.runVmReconcileSweep().then(() => { secondSettled = true; });
  try {
    await vi.waitFor(() => expect(release).toHaveLength(1));
    expect(firstSettled).toBe(false); expect(secondSettled).toBe(false);
    release[0]!();
    await vi.waitFor(() => expect(release).toHaveLength(2));
    await vi.waitFor(() => expect(firstSettled).toBe(true), { timeout: 300 });
    expect(secondSettled).toBe(false);
    expect(ran).toEqual(['A', 'cg-0', 'A']);
    release[1]!(); await second;
  } finally {
    draining = true;
    for (const done of release) done();
    await Promise.all([first, second]);
  }
});

it('joins overlapping public calls and timer ticks on one retained one-slot admission turn', async () => {
  const { internals } = await fixture(1);
  internals.subscribedContextGraphs.set('A', { subscribed: true, onChainId: '1' });
  let releaseA!: () => void, releaseU!: () => void;
  const a = new Promise<void>(resolve => { releaseA = resolve; });
  const u = new Promise<void>(resolve => { releaseU = resolve; });
  const ran: string[] = [];
  const dispatcher = new VmReconcileDispatcher(async key => {
    ran.push(key); await (key === 'A' ? a : u); return true;
  }, () => {}, { concurrency: 1, maxPending: 1 });
  dispatchers.push(dispatcher); internals.vmReconcileDispatcher = dispatcher;
  let completed = 0;
  const first = internals.runVmReconcileSweep().then(() => { completed++; });
  const second = internals.runVmReconcileSweep().then(() => { completed++; });
  internals.scheduleVmReconcileSweep();
  try {
    await vi.waitFor(() => expect(ran).toEqual(['A']));
    releaseA();
    await vi.waitFor(() => expect(ran).toEqual(['A', 'cg-0']));
    expect(completed).toBe(0);
    releaseU(); await Promise.all([first, second]);
    expect(completed).toBe(2);
    expect(ran).toEqual(['A', 'cg-0']);
  } finally { releaseA(); releaseU(); await Promise.all([first, second]); }
});
