import { afterEach, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';

type Subscription = { subscribed: boolean; coreHosted?: boolean; onChainId?: string };
interface Internals {
  subscribedContextGraphs: Map<string, Subscription>;
  node: unknown;
  vmReconcileDispatcher: {
    dispatch(cg: string, source: string): Promise<boolean>;
    triggerLive(cg: string): void;
  };
  runVmReconcileSweep(): Promise<void>;
  handleKARegisteredNudge(id: string, ka: bigint, context: ReturnType<typeof createOperationContext>): Promise<string | null>;
  openVmReconcileRotationState(): void;
  closeVmReconcileRotationState(): void;
  resolveContextGraphOnChainIdBinding(id: string): Promise<{ onChainId: string; provenance: 'ontology' } | null>;
}
const agents: DKGAgent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
  vi.restoreAllMocks();
});
async function fixture(unbound: number) {
  const agent = await DKGAgent.create({ name: 'BoundedSelfPrime', chainAdapter: new MockChainAdapter() });
  agents.push(agent);
  const internals = agent as unknown as Internals;
  internals.node = { peerId: '12D3KooWSelfPrimeBudget', libp2p: { getPeers: () => [] } };
  internals.openVmReconcileRotationState();
  for (let i = 0; i < unbound; i++) internals.subscribedContextGraphs.set(`cg-${i}`, { subscribed: true });
  const order: string[] = [];
  const dispatch = vi.fn(async (cg: string) => { order.push(`dispatch:${cg}`); return true; });
  const triggerLive = vi.fn();
  internals.vmReconcileDispatcher = { dispatch, triggerLive };
  const canRead = vi.spyOn(agent, 'canReadContextGraph').mockResolvedValue(true);
  const resolve = vi.spyOn(internals, 'resolveContextGraphOnChainIdBinding').mockImplementation(async (id) => {
    order.push(`resolve:${id}`); return null;
  });
  return { internals, resolve, canRead, order, dispatch, triggerLive };
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
      await internals.runVmReconcileSweep();
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
  await internals.runVmReconcileSweep();
  expect(order[0]).toBe('dispatch:bound');
});

it('counts denied read-authority checks against the unbound attempt budget', async () => {
  const { internals, canRead, resolve } = await fixture(30);
  canRead.mockResolvedValue(false);
  await internals.runVmReconcileSweep();
  expect(canRead).toHaveBeenCalledTimes(8);
  expect(resolve).not.toHaveBeenCalled();
});

it('handles deletion, binding, replacement and appended subscriptions without skipping surviving candidates', async () => {
  const { internals, resolve } = await fixture(20);
  await internals.runVmReconcileSweep();
  internals.subscribedContextGraphs.delete('cg-8');
  internals.subscribedContextGraphs.set('cg-9', { subscribed: true });
  internals.subscribedContextGraphs.set('cg-10', { subscribed: true, onChainId: '110' });
  for (let i = 20; i < 23; i++) internals.subscribedContextGraphs.set(`cg-${i}`, { subscribed: true });
  resolve.mockClear();
  await internals.runVmReconcileSweep();
  await internals.runVmReconcileSweep();
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
  await internals.runVmReconcileSweep();
  expect(resolve).not.toHaveBeenCalled();
});

it.each(['binding', 'read-authority'])('stops during %s lookup and starts a new cursor when reopened', async (stage) => {
  const { internals, resolve, canRead } = await fixture(20);
  let release!: () => void;
  const pending = new Promise<void>((done) => { release = done; });
  const blocked = stage === 'binding' ? resolve : canRead;
  if (stage === 'binding') resolve.mockReturnValueOnce(pending.then(() => null));
  else canRead.mockReturnValueOnce(pending.then(() => true));
  try {
    const sweep = internals.runVmReconcileSweep();
    await vi.waitFor(() => expect(blocked.mock.calls.length).toBe(1));
    internals.closeVmReconcileRotationState();
    await sweep;
    expect(resolve.mock.calls.length).toBe(stage === 'binding' ? 1 : 0);
    internals.openVmReconcileRotationState();
    resolve.mockClear();
    await internals.runVmReconcileSweep();
    expect(resolve.mock.calls.map(([id]) => id)).toEqual(Array.from({ length: 8 }, (_, i) => `cg-${i}`));
  } finally { release(); }
});
