import { describe, expect, it } from 'vitest';
import { Rfc64CatalogReplayRecoveryRuntimeV1 } from '../src/rfc64/catalog-replay-recovery-runtime-v1.js';
describe('staged full replay corroboration across runs', () => {
  for (const order of [['provider', 'nonprovider'], ['nonprovider', 'provider']]) {
    for (const finalObservation of ['clean', 'failed', 'unobserved'] as const) {
      it(`${order.join(' then ')} retains evidence with ${finalObservation} final parity`, async () => {
        let initial = true;
        let last = false;
        const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<string>({
          requestPeer: async (_cg, peer) => initial || peer === 'provider'
            ? { status: 'completed', targets: ['head'] } : { status: 'not-provider' },
          whenReceiverIdleForContextGraph: async () => {
            if (last && finalObservation === 'unobserved') await new Promise<void>(() => undefined);
          },
          sleep: () => last && finalObservation === 'unobserved' ? Promise.resolve() : new Promise(() => undefined),
          targetIdentity: target => target,
          parityFailed: async () => initial || (last && finalObservation === 'failed'),
        });
        const full = () => runtime.request({ contextGraphId: 'cg', policyDigest: 'p',
          kind: 'full-connected-peers', connectedPeerIds: order });
        await full();
        expect(runtime.status('cg', 'p')?.failed).toBe(true);
        initial = false;
        const leases = order.map(peer => runtime.reservePeer('cg', 'p', peer)!);
        await expect(full()).resolves.toEqual({ requested: 0, failed: 0 });
        for (let i = 0; i < leases.length; i++) {
          last = i === 1;
          const lease = leases[i]; lease.admit();
          await runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'connection-demand', demand: lease });
          lease.release();
          expect(runtime.status('cg', 'p')?.failed).toBe(!last || finalObservation !== 'clean');
        }
        expect(runtime.promisedTargets('cg', 'p')).toEqual(['head']);
      });
    }
  }
});
