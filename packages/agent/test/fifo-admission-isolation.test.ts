import { describe, expect, it } from 'vitest';
import { FIFOAdmission } from '../src/internal/fifo-admission.js';
import { StorageACKAdmission } from '../src/storage-ack-admission.js';
import { Rfc64CatalogReplayRecoveryRuntimeV1 } from '../src/rfc64/catalog-replay-recovery-runtime-v1.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function recovery(requestPeer: () => Promise<{ status: 'completed'; targets: never[] }>) {
  return new Rfc64CatalogReplayRecoveryRuntimeV1<never>({ requestPeer,
    whenReceiverIdleForContextGraph: async () => {}, targetIdentity: target => target,
    parityFailed: async () => false });
}
function replay(owner: Rfc64CatalogReplayRecoveryRuntimeV1<never>, count: number) {
  return owner.request({ kind: 'full-connected-peers', contextGraphId: 'isolated', policyDigest: 'p',
    connectedPeerIds: Array.from({ length: count }, (_, i) => `peer-${i}`) });
}

describe('independent admission capacities with a shared FIFO implementation', () => {
  it('does not make an ACK collector wait for four occupied replay permits', async () => {
    const held = Promise.withResolvers<void>(); let active = 0;
    const owner = recovery(async () => { active++; await held.promise; active--; return { status: 'completed', targets: [] }; });
    const pending = replay(owner, 4);
    try {
      await turn(); expect(active).toBe(4);
      await expect(new StorageACKAdmission(() => 1).run(async () => 'ack')).resolves.toBe('ack');
      expect(active).toBe(4);
    } finally { held.resolve(); await pending; }
  });

  it('does not make replay wait for an occupied ACK collector permit', async () => {
    const held = Promise.withResolvers<void>(); let entered = false; let settled = false;
    const ack = new StorageACKAdmission(() => 1).run(async () => { entered = true; await held.promise; });
    void ack.then(() => { settled = true; });
    try {
      await turn(); expect(entered).toBe(true);
      await expect(replay(recovery(async () => ({ status: 'completed', targets: [] })), 4))
        .resolves.toEqual({ requested: 4, failed: 0 });
      expect(settled).toBe(false);
    } finally { held.resolve(); await ack; }
  });

  it('checks cancellation after physical work and releases error paths for the next owner', async () => {
    const gate = new FIFOAdmission(() => 1); const held = Promise.withResolvers<void>();
    const stop = new AbortController(); const calls: string[] = [];
    const active = gate.run(async () => { calls.push('active'); await held.promise; return 1; }, stop.signal);
    const cancelled = expect(active).rejects.toThrow('cancelled active owner');
    const next = gate.run(async () => { calls.push('next'); throw new Error('provider failed'); });
    const failed = expect(next).rejects.toThrow('provider failed');
    try {
      await turn(); stop.abort(new Error('cancelled active owner'));
      await turn(); expect(calls).toEqual(['active']);
    } finally { held.resolve(); }
    await cancelled; await failed;
    await expect(gate.run(async () => 3)).resolves.toBe(3);
    expect(calls).toEqual(['active', 'next']);
  });
});
