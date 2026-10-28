import { describe, expect, it } from 'vitest';
import { Rfc64CatalogReplayRecoveryRuntimeV1 } from '../src/rfc64/catalog-replay-recovery-runtime-v1.js';
describe('staged full replay corroboration across runs', () => {
  it.each(['provider-failed', 'local-unavailable', 'not-provider'] as const)
    ('retains staged full-pass freshness intent through %s outcomes', async outcome => {
      let initial = true;
      const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<string>({
        requestPeer: async () => {
          if (initial) return { status: 'completed', targets: ['old-head'] };
          if (outcome === 'provider-failed') throw new Error('provider unreachable');
          return { status: outcome };
        },
        whenReceiverIdleForContextGraph: async () => {}, targetIdentity: target => target,
        parityFailed: async () => false,
      });
      const full = () => runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'full-connected-peers', connectedPeerIds: ['a', 'b'] });
      await full(); initial = false;
      const leases = ['a', 'b'].map(peer => runtime.reservePeer('cg', 'p', peer)!);
      await expect(full()).resolves.toEqual({ requested: 0, failed: 0 });
      for (const lease of leases) {
        lease.admit();
        await runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'connection-demand', demand: lease });
        lease.release();
      }
      expect(runtime.status('cg', 'p')).toEqual({ active: false, failed: false,
        unverified: outcome !== 'not-provider', unresolvedPeerCount: outcome === 'provider-failed' ? 2 : 0 });
      expect(runtime.promisedTargets('cg', 'p')).toEqual(['old-head']);
    });

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


it.each(['complete', 'provider-failed', 'drain-timeout'] as const)('staged full replay replaces retained overflow only after %s observation', async finalOutcome => {
  let initial = true, final = false;
  const parity: string[][] = [];
  const runtime = new Rfc64CatalogReplayRecoveryRuntimeV1<string>({
    requestPeer: async (_cg, peer) => {
      if (initial) return { status: 'completed', targets: Array.from({ length: 65 }, (_, i) => `old-${i}`) };
      if (final && finalOutcome === 'provider-failed') throw new Error('provider unavailable');
      return { status: 'completed', targets: [`fresh-${peer}`] };
    },
    whenReceiverIdleForContextGraph: async () => {
      if (final && finalOutcome === 'drain-timeout') await new Promise<void>(() => {});
    },
    sleep: () => final && finalOutcome === 'drain-timeout' ? Promise.resolve() : new Promise(() => {}),
    targetIdentity: target => target,
    parityFailed: async (_cg, targets) => { parity.push([...targets]); return false; },
  });
  const full = (peers: readonly string[]) => runtime.request({ contextGraphId: 'cg', policyDigest: 'p',
    kind: 'full-connected-peers', connectedPeerIds: peers });
  await full(['old']);
  expect(runtime.status('cg', 'p')?.failed).toBe(true);
  expect(runtime.promisedTargets('cg', 'p')).toBeNull();
  initial = false;
  const a = runtime.reservePeer('cg', 'p', 'a')!, b = runtime.reservePeer('cg', 'p', 'b')!;
  await full(['a', 'b']);
  a.admit();
  await runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'connection-demand', demand: a }); a.release();
  expect(runtime.status('cg', 'p')?.failed).toBe(true);
  expect(runtime.promisedTargets('cg', 'p')).toBeNull();
  final = true; b.admit();
  await runtime.request({ contextGraphId: 'cg', policyDigest: 'p', kind: 'connection-demand', demand: b }); b.release();
  expect(runtime.status('cg', 'p')?.failed).toBe(finalOutcome !== 'complete');
  expect(runtime.promisedTargets('cg', 'p')).toEqual(finalOutcome === 'complete' ? ['fresh-a', 'fresh-b'] : null);
  expect(parity[0]).toEqual(['fresh-a']);
  if (finalOutcome === 'complete') expect(parity.at(-1)).toEqual(['fresh-a', 'fresh-b']);
});
