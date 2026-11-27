import { describe, expect, it, vi } from 'vitest';
import { ContextGraphSubscriptionActivations } from '../src/context-graph-subscription-activation-state.js';
import { SubscriptionActivationCapacityError } from '../src/context-graph-subscription-activation-capacity.js';
import type { PersistedContextGraphSubscriptionActivationPorts } from '../src/context-graph-subscription-authority-recovery.js';
import type { ContextGraphSub, ContextGraphSubscriptionRecord, ContextGraphSubscriptionRehydrationInternalStatus } from '../src/dkg-agent-types.js';
import type { ContextGraphDormancyReason } from '../src/context-graph-subscription-dormancy.js';

const row = (id: string, coreHosted = false): ContextGraphSubscriptionRecord => ({
  id, subscribed: true, synced: true, syncScoped: true, coreHosted,
});
function fixture(rows: ContextGraphSubscriptionRecord[]) {
  const live = new Map<string, ContextGraphSub>();
  const dormancy = new Map<string, ContextGraphDormancyReason>();
  let status: ContextGraphSubscriptionRehydrationInternalStatus | null = null;
  const owner = new ContextGraphSubscriptionActivations({
    subscribedContextGraphs: live, contextGraphSubscriptionDormancyById: dormancy,
    contextGraphSubscriptionRehydrationPendingIds: new Set(), contextGraphSubscriptionRehydrationSlotIds: new Set(),
    contextGraphSubscriptionRehydrationAccountedIds: new Set(),
    getStatus: () => status, setStatus: next => { status = next; },
    slotReleased: () => {}, clearPersistRevision: () => {}, publish: () => {},
  });
  owner.reset(rows);
  owner.beginRehydration(rows, { rehydrationEnabled: true, systemExcluded: 0, activationCap: 1 });
  owner.completeRehydration();
  const ports: PersistedContextGraphSubscriptionActivationPorts = {
    install: vi.fn(record => {
      const subscription: ContextGraphSub = {
        syncMode: 'always-on', subscribed: record.subscribed, synced: record.synced, coreHosted: record.coreHosted,
      };
      live.set(record.id, subscription);
      return subscription;
    }),
    remove: id => { live.delete(id); }, rollbackNetworkEffects: () => {},
    trackSync: () => {}, subscribe: () => {}, persistMembership: () => {},
    persistBinding: async () => undefined, commit: id => live.get(id)!,
  };
  return { owner, ports, live, dormancy, status: () => status! };
}

describe('authority recovery activation capacity', () => {
  it('reserves the final slot through asynchronous preparation, while hosted recovery stays exempt', async () => {
    const a = row('a'), b = row('b'), hosted = row('hosted', true);
    const f = fixture([a, b, hosted]);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = f.owner.activate(a, f.ports, { respectActivationCap: true, prepare: () => held });
    try {
      expect(f.status().activated).toBe(0);
      await expect(f.owner.activate(b, f.ports, { respectActivationCap: true })).rejects.toBeInstanceOf(SubscriptionActivationCapacityError);
      expect(f.live.has('b')).toBe(false);
      await f.owner.activate(hosted, f.ports, { respectActivationCap: true });
      expect(f.status()).toMatchObject({ activated: 1, hostedActivated: 1 });
    } finally { release(); await first; }
    expect(f.status()).toMatchObject({ activated: 2, hostedActivated: 1 });
    expect(f.dormancy.get('b')).toBe('authorityUnavailable');
  });

  it('releases the reserved slot after failed preparation and rolls back the provisional row', async () => {
    const a = row('a'), b = row('b');
    const f = fixture([a, b]);
    let fail!: (error: Error) => void;
    const held = new Promise<void>((_resolve, reject) => { fail = reject; });
    const first = f.owner.activate(a, f.ports, { respectActivationCap: true, prepare: () => held });
    const rejected = expect(first).rejects.toThrow('binding repair failed');
    await expect(f.owner.activate(b, f.ports, { respectActivationCap: true })).rejects.toBeInstanceOf(SubscriptionActivationCapacityError);
    fail(new Error('binding repair failed'));
    await rejected;
    expect(f.live.has('a')).toBe(false);
    await f.owner.activate(b, f.ports, { respectActivationCap: true });
    expect(f.status().activated).toBe(1);
    expect(f.dormancy.has('b')).toBe(false);
  });
});
