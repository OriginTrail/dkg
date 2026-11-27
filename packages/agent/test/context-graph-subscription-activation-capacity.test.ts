import { describe, expect, it, vi } from 'vitest';
import { ContextGraphSubscriptionActivations, isCommittedSubscription } from '../src/context-graph-subscription-activation-state.js';
import { StorageAckDemandActivations } from '../src/storage-ack-demand-activation.js';
import { promoteDormantContextGraphSubscriptions } from '../src/context-graph-subscription-authority-recovery.js';
import { RollingSubscriptionChecks } from '../src/context-graph-subscription-rolling-checks.js';
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
  const pending = new Set<string>(), slots = new Set<string>();
  const owner = new ContextGraphSubscriptionActivations({
    subscribedContextGraphs: live, contextGraphSubscriptionDormancyById: dormancy,
    contextGraphSubscriptionRehydrationPendingIds: pending, contextGraphSubscriptionRehydrationSlotIds: slots,
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
  return { owner, ports, live, dormancy, pending, slots, status: () => status! };
}

describe('authority recovery activation capacity', () => {
  it.each([true, false])('accounts for installing recovery/rolling work while hosted recovery stays exempt (reserved=%s)', async reserved => {
    const a = row('a'), b = row('b'), hosted = row('hosted', true);
    const f = fixture([a, b, hosted]);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = f.owner.activate(a, f.ports, { respectActivationCap: reserved, prepare: () => held });
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

  it.each([true, false])('releases failed recovery/rolling installation capacity (reserved=%s)', async reserved => {
    const a = row('a'), b = row('b');
    const f = fixture([a, b]);
    let fail!: (error: Error) => void;
    const held = new Promise<void>((_resolve, reject) => { fail = reject; });
    const first = f.owner.activate(a, f.ports, { respectActivationCap: reserved, prepare: () => held });
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


describe('demand and rolling activation share commit ownership', () => {
  it.each([false, true])('never adopts a provisional demand row (preparation fails=%s)', async failPreparation => {
    const target = { ...row('overlap'), onChainId: '1' };
    const f = fixture([target]);
    f.owner.transition({ id: target.id, kind: 'dormancy', reason: 'activationCap' });
    const authority = { outcome: 'allowed' as const, grantScope: 'public' as const,
      source: 'registered-chain' as const, reason: 'open-context-graph', metadataBootstrap: 'forbidden' as const, onChainId: 1n };
    let answer!: () => void, beginRead!: () => void, release!: () => void, beginPreparation!: () => void;
    const readStarted = new Promise<void>(resolve => { beginRead = resolve; });
    const reading = new Promise<void>(resolve => { answer = resolve; });
    const preparing = new Promise<void>(resolve => { beginPreparation = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    const rolling = promoteDormantContextGraphSubscriptions({
      store: { load: async () => ({ ...target }), loadAll: async () => [target] },
      getStatus: f.status, isCurrent: () => !controller.signal.aborted,
      contextGraphSubscriptionRollingChecks: new RollingSubscriptionChecks({ minPauseMs: 0, pausePerCheckTime: 0 }),
      contextGraphSubscriptionRehydrationPendingIds: f.pending, contextGraphSubscriptionRehydrationSlotIds: f.slots,
      contextGraphSubscriptionDormancyById: f.dormancy, contextGraphSubscriptionPersistRevisions: new Map(),
      subscribedContextGraphs: f.live, log: { info: () => {}, warn: () => {}, debug: () => {} },
      transitionDormancy: (id, reason) => f.owner.transition({ id, kind: 'dormancy', reason }),
      touchStatus: () => {}, recordContextGraphSubscriptionClear: () => {}, wakeAuthorityRecovery: () => {},
      resolveAuthority: async () => { beginRead(); await reading; return authority; },
      activate: async () => { throw new Error('rolling must not adopt the provisional row'); },
    }, controller.signal);
    await readStarted;
    const demand = new StorageAckDemandActivations({
      signal: controller.signal, isCurrent: () => !controller.signal.aborted,
      dormancy: id => f.dormancy.get(id), revision: () => 0, subscription: id => f.live.get(id),
      load: async () => ({ ...target }), resolveAuthority: async () => authority,
      activate: async (record, onChainId, isCurrent) => { await f.owner.activate(record, f.ports, {
        onChainId, isCurrent, prepare: async () => { beginPreparation(); await held;
          if (failPreparation) throw new Error('reconciliation failed'); },
      }); },
      clear: () => {}, retire: (id, reason) => f.owner.transition({ id, kind: 'dormancy', reason }),
      track: () => {}, log: { info: () => {}, warn: () => {}, debug: () => {} },
    });
    demand.request(target.id, '1');
    await preparing;
    answer(); await rolling;
    expect(isCommittedSubscription(f.live, f.dormancy, target.id)).toBe(false);
    expect(f.status().activated).toBe(0);
    release();
    if (failPreparation) controller.abort();
    await demand.whenIdle();
    expect(isCommittedSubscription(f.live, f.dormancy, target.id)).toBe(!failPreparation);
    expect(f.status().activated).toBe(failPreparation ? 0 : 1);
    if (failPreparation) expect(f.live.has(target.id)).toBe(false);
  });
  it('preserves independently accepted hosting when an earlier provisional activation fails', async () => {
    const a = row('a'), f = fixture([a]);
    let fail!: (error: Error) => void;
    const first = f.owner.activate(a, f.ports, { prepare: () => new Promise<void>((_, reject) => { fail = reject; }) });
    const rejected = expect(first).rejects.toThrow('preparation failed');
    const hosted = f.live.get('a')!;
    hosted.coreHosted = true;
    f.owner.replaceLiveIntent('a', hosted);
    fail(new Error('preparation failed'));
    await rejected;
    expect(f.live.get('a')).toBe(hosted);
    expect(f.live.get('a')?.coreHosted).toBe(true);
  });

});
