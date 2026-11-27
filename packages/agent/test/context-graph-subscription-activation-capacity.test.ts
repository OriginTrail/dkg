import { SubscriptionRecoveryCoordinator } from '../src/subscription-recovery-owner.js';
import { PersistedSubscriptionNameBindingRetry } from '../src/context-graph-subscription-name-binding-retry.js';
import type { SubscriptionRecoverySchedulingPorts } from '../src/context-graph-subscription-recover-row.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
function fixture(rows: ContextGraphSubscriptionRecord[], cap = 1, publish: (id: string) => void = () => {}) {
  const live = new Map<string, ContextGraphSub>();
  const dormancy = new Map<string, ContextGraphDormancyReason>();
  let status: ContextGraphSubscriptionRehydrationInternalStatus | null = null;
  const pending = new Set<string>(), slots = new Set<string>();
  const owner = new ContextGraphSubscriptionActivations({
    subscribedContextGraphs: live, contextGraphSubscriptionDormancyById: dormancy,
    contextGraphSubscriptionRehydrationPendingIds: pending, contextGraphSubscriptionRehydrationSlotIds: slots,
    contextGraphSubscriptionRehydrationAccountedIds: new Set(),
    getStatus: () => status, setStatus: next => { status = next; },
    slotReleased: () => {}, clearPersistRevision: () => {}, publish,
  });
  owner.reset(rows);
  owner.beginRehydration(rows, { rehydrationEnabled: true, systemExcluded: 0, activationCap: cap });
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
  it('counts a committed activation once while its outer reservation is retiring', async () => {
    const a = row('a'), b = row('b'), c = row('c');
    let second: Promise<ContextGraphSub> | undefined;
    const f = fixture([a, b, c], 2, id => {
      if (id === 'a') second = f.owner.activate(b, f.ports, { respectActivationCap: true });
    });
    await f.owner.activate(a, f.ports, { respectActivationCap: true });
    await expect(second).resolves.toMatchObject({ subscribed: true });
    expect(f.status().activated).toBe(2);
    await expect(f.owner.activate(c, f.ports, { respectActivationCap: true }))
      .rejects.toBeInstanceOf(SubscriptionActivationCapacityError);
  });

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
  afterEach(() => { vi.useRealTimers(); });
  it('rolls back failed preparation while current and commits exactly once on demand retry', async () => {
    vi.useFakeTimers();
    const target = { ...row('retry'), onChainId: '1' }, published = vi.fn();
    const f = fixture([target], 1, published);
    f.owner.transition({ id: target.id, kind: 'dormancy', reason: 'activationCap' });
    const controller = new AbortController(), prepare = vi.fn()
      .mockRejectedValueOnce(new Error('reconciliation failed')).mockResolvedValue(undefined);
    const activate = vi.fn(async (record, onChainId, isCurrent) => {
      await f.owner.activate(record, f.ports, { onChainId, isCurrent, prepare });
    });
    const demand = new StorageAckDemandActivations({
      recovery: new SubscriptionRecoveryCoordinator(),
      signal: controller.signal, isCurrent: () => true,
      dormancy: id => f.dormancy.get(id), revision: () => 0, subscription: id => f.live.get(id),
      load: async () => ({ ...target }), resolveAuthority: async () => ({ outcome: 'allowed', grantScope: 'public',
        source: 'registered-chain', reason: 'open-context-graph', metadataBootstrap: 'forbidden', onChainId: 1n }),
      activate, clear: () => {}, capped: () => {}, retire: () => {}, track: () => {},
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    }, { retryMinMs: 10, retryMaxMs: 10 });
    demand.request(target.id, '1');
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.signal.aborted).toBe(false);
    expect(activate).toHaveBeenCalledOnce();
    await expect(activate.mock.results[0]!.value).rejects.toThrow('reconciliation failed');
    expect(f.live.has(target.id)).toBe(false);
    expect(f.status().activated).toBe(0);
    expect(published).not.toHaveBeenCalled();
    expect(demand.size).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    await demand.whenIdle();
    expect(activate).toHaveBeenCalledTimes(2);
    expect(isCommittedSubscription(f.live, f.dormancy, target.id)).toBe(true);
    expect(f.status().activated).toBe(1);
    expect(published).toHaveBeenCalledOnce();
  });
  it.each(['success', 'retired'] as const)('never adopts a provisional demand row (outcome=%s)', async outcome => {
    const retired = outcome === 'retired';
    const target = { ...row('overlap'), onChainId: '1' };
    const published = vi.fn();
    const f = fixture([target], 1, published);
    f.owner.transition({ id: target.id, kind: 'dormancy', reason: 'activationCap' });
    const authority = { outcome: 'allowed' as const, grantScope: 'public' as const,
      source: 'registered-chain' as const, reason: 'open-context-graph', metadataBootstrap: 'forbidden' as const, onChainId: 1n };
    let answer!: () => void, beginRead!: () => void, release!: () => void, beginPreparation!: () => void;
    const readStarted = new Promise<void>(resolve => { beginRead = resolve; });
    const reading = new Promise<void>(resolve => { answer = resolve; });
    const preparing = new Promise<void>(resolve => { beginPreparation = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController(), recovery = new SubscriptionRecoveryCoordinator();
    const rolling = promoteDormantContextGraphSubscriptions({
      row: {
        recovery, isCurrent: () => !controller.signal.aborted,
        dormancy: id => f.dormancy.get(id), revision: () => 0, subscription: id => f.live.get(id),
        load: async () => ({ ...target }), clear: () => {}, capped: () => {},
        retire: (id, reason) => f.owner.transition({ id, kind: 'dormancy', reason }),
        resolveAuthority: async () => { beginRead(); await reading; return authority; },
        activate: async () => { throw new Error('rolling must not adopt the provisional row'); },
      },
      getStatus: f.status, isCurrent: () => !controller.signal.aborted,
      contextGraphSubscriptionRollingChecks: new RollingSubscriptionChecks({ minPauseMs: 0, pausePerCheckTime: 0 }),
      contextGraphSubscriptionRehydrationPendingIds: f.pending, contextGraphSubscriptionRehydrationSlotIds: f.slots,
      contextGraphSubscriptionDormancyById: f.dormancy,
      subscribedContextGraphs: f.live, log: { info: () => {}, warn: () => {}, debug: () => {} },
      touchStatus: () => {}, wakeAuthorityRecovery: () => {},
    }, controller.signal);
    await readStarted;
    const demand = new StorageAckDemandActivations({
      recovery,
      signal: controller.signal, isCurrent: () => !controller.signal.aborted,
      dormancy: id => f.dormancy.get(id), revision: () => 0, subscription: id => f.live.get(id),
      load: async () => ({ ...target }), resolveAuthority: async () => authority,
      activate: async (record, onChainId, isCurrent) => { await f.owner.activate(record, f.ports, {
        onChainId, isCurrent, prepare: async () => { beginPreparation(); await held;
        },
      }); },
      clear: () => {}, retire: (id, reason) => f.owner.transition({ id, kind: 'dormancy', reason }),
      track: () => {}, log: { info: () => {}, warn: () => {}, debug: () => {} },
    });
    demand.request(target.id, '1');
    answer(); await rolling; // The successor waits for the superseded read to retire.
    await preparing;
    expect(isCommittedSubscription(f.live, f.dormancy, target.id)).toBe(false);
    expect(f.status().activated).toBe(0);
    if (retired) controller.abort();
    release();
    await demand.whenIdle();
    expect(isCommittedSubscription(f.live, f.dormancy, target.id)).toBe(!retired);
    expect(f.status().activated).toBe(retired ? 0 : 1);
    expect(published).toHaveBeenCalledTimes(retired ? 0 : 1);
    if (retired) expect(f.live.has(target.id)).toBe(false);
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


describe('one recovery owner across scheduling policies', () => {
  afterEach(() => { vi.useRealTimers(); });
  it.each([
    ['authority', false], ['preparation', false], ['authority', true], ['preparation', true],
  ] as const)('upgrades stalled %s to verified ACK demand (shutdown=%s)', async (phase, shutdown) => {
    vi.useFakeTimers();
    const target = row('shared-owner'), published = vi.fn(), f = fixture([target], 1, published);
    const recovery = new SubscriptionRecoveryCoordinator(), controller = new AbortController();
    let release!: () => void, answer!: (value: any) => void;
    const preparing = new Promise<void>(resolve => { release = resolve; });
    const lookup = new Promise<any>(resolve => { answer = resolve; });
    const allowed = { outcome: 'allowed' as const, grantScope: 'public' as const, source: 'registered-chain' as const,
      reason: 'open-context-graph', metadataBootstrap: 'forbidden' as const, onChainId: 1n };
    let originalReadSignal: AbortSignal | undefined;
    const resolveAuthority = vi.fn(async (record, signal) => {
      if (!record.onChainId && phase === 'authority') { originalReadSignal = signal; return lookup; }
      return allowed;
    });
    const prepare = vi.fn(async () => { if (phase === 'preparation' && prepare.mock.calls.length === 1) await preparing; });
    const ports: SubscriptionRecoverySchedulingPorts = {
      recovery, isCurrent: () => !controller.signal.aborted,
      dormancy: id => f.dormancy.get(id), revision: () => 0, subscription: id => f.live.get(id),
      load: async () => ({ ...target }), resolveAuthority,
      activate: async (record, onChainId, isCurrent) => {
        await f.owner.activate(record, f.ports, { onChainId, isCurrent, prepare, respectActivationCap: true });
      },
      clear: () => {}, capped: () => {}, retire: () => {},
    };
    const scheduled = { ...ports, signal: controller.signal, track: () => {},
      log: { info: () => {}, warn: () => {}, debug: () => {} } };
    const retry = new PersistedSubscriptionNameBindingRetry(scheduled);
    retry.take([target.id]);
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveAuthority).toHaveBeenCalledOnce();
    // The periodic owner consults the same key, including during retry backoff.
    expect(recovery.claim(target.id, 0, controller.signal)).toBeUndefined();
    expect(resolveAuthority).toHaveBeenCalledOnce();
    const demand = new StorageAckDemandActivations(scheduled);
    expect(demand.request(target.id, '1')).toBe(true);
    if (shutdown) controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    if (phase === 'authority') expect(originalReadSignal?.aborted).toBe(true);
    if (phase === 'preparation') {
      // Demand owns the key but cannot read/install until the old activation
      // finishes compensating its provisional row.
      expect(resolveAuthority).toHaveBeenCalledOnce();
      expect(published).not.toHaveBeenCalled();
    }
    release();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([retry.whenIdle(), demand.whenIdle()]);
    answer(allowed); // Even an uncooperative old lookup cannot commit late.
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toHaveBeenCalledTimes(shutdown ? 0 : 1);
    expect(f.status().activated).toBe(shutdown ? 0 : 1);
    expect(isCommittedSubscription(f.live, f.dormancy, target.id)).toBe(!shutdown);
    expect(recovery.has(target.id)).toBe(false);
    expect(resolveAuthority).toHaveBeenCalledTimes(shutdown ? 1 : 2);
    if (!shutdown) expect(resolveAuthority.mock.calls[1]![0]).toMatchObject({ onChainId: '1' });
  });
});
