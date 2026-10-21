import { describe, expect, it, vi } from 'vitest';
import { NamedKaVmLifecycleRepair } from '../src/named-ka-vm-lifecycle-repair.js';
import { confirmedLifecycleRecoveryFixture } from './_helpers/confirmed-lifecycle-recovery-fixture.js';
import { assertionLifecycleWriteLockKey, withKeyedLocks } from '@origintrail-official/dkg-publisher';

it('returns pending after admitted retirement fails and bounds further attempts', async () => {
  const { input } = confirmedLifecycleRecoveryFixture();
  let now = 1000;
  const apply = vi.fn(async () => {});
  const owner = new NamedKaVmLifecycleRepair({ writeLocks: new Map(), now: () => now, apply,
    isCurrent: async () => true, warn: vi.fn() });
  const persist = vi.spyOn(owner as unknown as { persist(): Promise<void> }, 'persist')
    .mockResolvedValueOnce().mockRejectedValueOnce(new Error('retirement EIO')).mockResolvedValue();
  try {
    await expect(owner.submit(input)).resolves.toBe('pending');
    expect(apply).toHaveBeenCalledOnce();
    await owner.runDue(); expect(apply).toHaveBeenCalledOnce();
    now += 5000; await owner.runDue(); expect(apply).toHaveBeenCalledTimes(2);
    await owner.runDue(); expect(apply).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledTimes(3);
  } finally { await owner.stop(); }
});

describe('bounded independent lifecycle dispatch', () => {
  it('progresses B while A waits for its KA lock and drains both on shutdown', async () => {
    const { input } = confirmedLifecycleRecoveryFixture();
    let now = 1000, unavailable = true;
    const locks = new Map<string, Promise<void>>();
    const apply = vi.fn(async () => { if (unavailable) throw new Error('store pressure'); });
    const owner = new NamedKaVmLifecycleRepair({ writeLocks: locks, now: () => now, apply,
      isCurrent: async () => true, warn: vi.fn() });
    await owner.submit(input); await owner.submit({ ...input, name: 'independent-B' });
    unavailable = false; now += 5000; apply.mockClear();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const writer = withKeyedLocks(locks, [assertionLifecycleWriteLockKey(input.contextGraphId, input.name, input.agentAddress)], async () => { entered(); await held; });
    await ready;
    const pass = owner.runDue();
    try {
      await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce(), { timeout: 500 });
      expect(apply.mock.calls[0]).toEqual([{ ...input, name: 'independent-B', merkleRoot: input.merkleRoot.slice(2) }]);
      let stopped = false;
      const stop = owner.stop().then(() => { stopped = true; });
      await Promise.resolve(); expect(stopped).toBe(false);
      release(); await writer; await pass; await stop;
    } finally { release(); await writer; await pass; await owner.stop(); }
  });
});
