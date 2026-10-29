import { describe, expect, it, vi } from 'vitest';
import { createOperationContext, ed25519Sign } from '@origintrail-official/dkg-core';
import { NetworkAdmissionCoordinator } from '../src/p2p/network-admission-coordinator.js';
import { NetworkAdmissionService } from '../src/p2p/network-admission.js';
import { signNetworkIdentityResponse } from '../src/p2p/network-identity-proof.js';
const remote = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const self = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const seed = Buffer.from('vHxcSg3ecwP9UfJWdmlnWQeJe83jD2yKtOJlWuLpIrTRh3QiB5sL6iRhAidCZ3bHQLaE0RwBfHBNEmV7ylcjqg==', 'base64').slice(0, 32);
const identity = { networkId: 'network-a', genesisId: 'base-testnet' };
const refused = () => Object.assign(new Error('no handler yet'), { name: 'UnsupportedProtocolError' });
function fixture(sendIdentityProbe: ConstructorParameters<typeof NetworkAdmissionCoordinator>[0]['sendIdentityProbe'], timeout = 1500) {
  const admission = new NetworkAdmissionService({ networkId: identity.networkId, selfPeerId: self });
  const coordinator = new NetworkAdmissionCoordinator({ admission, identity, selfPeerId: self,
    sign: async () => new Uint8Array(), sendIdentityProbe, probeTimeoutMs: timeout,
    getConnections: () => [], deletePeerFromPeerStore: async () => undefined });
  return { coordinator, admission };
}
describe('released-peer identity startup compatibility', () => {
  it('retries only the identity probe within a shrinking budget and accepts its signed response', async () => {
    const probe = vi.fn(async (_peer: string, data: Uint8Array, _options: { timeoutMs: number }) => {
      if (probe.mock.calls.length === 1) throw refused();
      const request = JSON.parse(new TextDecoder().decode(data));
      const response = await signNetworkIdentityResponse({ request, identity, responderPeerId: remote,
        sign: payload => ed25519Sign(payload, seed) });
      return new TextEncoder().encode(JSON.stringify(response));
    });
    const { coordinator, admission } = fixture(probe);
    await expect(coordinator.ensureAdmitted(remote, createOperationContext('connect'))).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls[1]![2].timeoutMs).toBeLessThan(probe.mock.calls[0]![2].timeoutMs);
    expect(admission.getRetryableProbeBackoff(remote)).toBeUndefined();
  });
  it('bounds permanent refusals and records a transient backoff', async () => {
    const probe = vi.fn(async () => { throw refused(); });
    const { coordinator, admission } = fixture(probe, 20);
    await expect(coordinator.ensureAdmitted(remote, createOperationContext('connect')))
      .rejects.toMatchObject({ code: 'NETWORK_ADMISSION_PROBE_FAILED' });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(admission.getRetryableProbeBackoff(remote)).toBeDefined();
  });
  it('cancels the compatibility wait without another probe or a backoff', async () => {
    const first = Promise.withResolvers<void>();
    const probe = vi.fn(async () => { first.resolve(); throw refused(); });
    const { coordinator, admission } = fixture(probe);
    const abort = new AbortController();
    const pending = coordinator.ensureAdmitted(remote, createOperationContext('connect'), { signal: abort.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await first.promise;
    abort.abort();
    await rejected;
    expect(probe).toHaveBeenCalledTimes(1);
    expect(admission.getRetryableProbeBackoff(remote)).toBeUndefined();
  });
});
