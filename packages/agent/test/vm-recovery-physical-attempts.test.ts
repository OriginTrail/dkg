import { describe, expect, it, vi } from 'vitest';
import type { OrdinalRecoveryTarget } from '../src/chain-reconciler.js';
import { vmRecoverySlotKey } from '../src/internal/vm-recovery-slot-registry.js';
import type { VmRecoveryUalDisposition } from '../src/vm-recovery-provider-policy.js';
import { createVmRecoveryHostHarness } from './_helpers/vm-recovery-host.js';

const peers = ['12D3KooWPhysicalAttemptA', '12D3KooWPhysicalAttemptB'];

async function createHarness(disposition: VmRecoveryUalDisposition = 'incomplete') {
  const localCgId = 'physical-attempt-accounting';
  return createVmRecoveryHostHarness({
    name: 'PhysicalAttemptAccounting', localCgId, peers, targetCount: 1,
    targetForOrdinal: (ordinal): OrdinalRecoveryTarget => ({
      localCgId, onChainCgId: '1', ordinal, kaId: String(ordinal),
      ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}`,
      merkleRoot: 'current-root', reason: 'no-swm',
    }),
    onFetch: () => disposition,
  });
}

describe('completed exact-VM physical attempt accounting', () => {
  it.each<VmRecoveryUalDisposition>(['incomplete', 'clean-absent', 'found'])(
    'rotates after a %s response followed by plain pending without proving absence',
    async disposition => {
      const harness = await createHarness(disposition);
      const host = harness.internals;
      const target = harness.targets[0]!;
      host.reconcileChainOrdinal = async () => ({ status: 'pending' });
      try {
        const first = await harness.run();
        expect(first.outcomes.get(target.ordinal)).toEqual({ status: 'pending' });
        // Admit the next network-eligible sweep without waiting on a wall timer.
        host.clearVmReconcileActiveFetchCooldown(target.localCgId);
        await harness.run();
        expect(harness.fetched.map(fetch => fetch.peerId)).toEqual(peers);
        const record = host.vmRecoverySlots.snapshot().get(vmRecoverySlotKey(target));
        expect(record?.lastAttemptedPeerId).toBe(peers[1]);
        expect(record?.attemptedPeerIds).toEqual(new Set(peers));
        expect(record?.cleanAbsentPeerIds.size).toBe(0);
        expect(record?.backoffKind).toBe('incomplete-cycle');
        expect(record?.failures).toBe(1);
        host.clearVmReconcileActiveFetchCooldown(target.localCgId);
        await harness.run();
        expect(harness.fetched).toHaveLength(2);
      } finally { await harness.agent.stop().catch(() => undefined); }
    },
  );

  it('retains the physical cursor while the post-fetch chain read is still pending', async () => {
    const harness = await createHarness('clean-absent');
    const host = harness.internals;
    const target = harness.targets[0]!;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    host.reconcileChainOrdinal = async () => {
      entered();
      await held;
      return { status: 'pending' };
    };
    const recovery = harness.run();
    try {
      await reading;
      const record = host.vmRecoverySlots.snapshot().get(vmRecoverySlotKey(target));
      expect(record?.lastAttemptedPeerId).toBe(peers[0]);
      expect(record?.attemptedPeerIds).toEqual(new Set([peers[0]]));
      expect(record?.cleanAbsentPeerIds.size).toBe(0);
      expect(record?.phase).toBe('collecting');
    } finally {
      release();
      await recovery;
      await harness.agent.stop().catch(() => undefined);
    }
  });

  it('retains the physical cursor if a still-current post-fetch chain read rejects', async () => {
    const harness = await createHarness();
    const host = harness.internals;
    const target = harness.targets[0]!;
    const failure = new Error('chain reread failed');
    const reconcile = vi.spyOn(host, 'reconcileChainOrdinal').mockRejectedValueOnce(failure);
    try {
      await expect(harness.run()).rejects.toBe(failure);
      reconcile.mockResolvedValue({ status: 'pending' });
      host.clearVmReconcileActiveFetchCooldown(target.localCgId);
      await harness.run();
      expect(harness.fetched.map(fetch => fetch.peerId)).toEqual(peers);
    } finally { await harness.agent.stop().catch(() => undefined); }
  });

  it('credits clean absence only to the peer whose target was revalidated', async () => {
    const harness = await createHarness('clean-absent');
    const host = harness.internals;
    const target = harness.targets[0]!;
    vi.spyOn(host, 'reconcileChainOrdinal').mockResolvedValueOnce({ status: 'pending' });
    try {
      await harness.run();
      host.clearVmReconcileActiveFetchCooldown(target.localCgId);
      await harness.run();
      expect(harness.fetched.map(fetch => fetch.peerId)).toEqual(peers);
      const record = host.vmRecoverySlots.snapshot().get(vmRecoverySlotKey(target));
      expect(record?.cleanAbsentPeerIds).toEqual(new Set([peers[1]]));
      expect(record?.backoffKind).toBe('incomplete-cycle');
      expect(record?.failures).toBe(1);
    } finally { await harness.agent.stop().catch(() => undefined); }
  });
});
