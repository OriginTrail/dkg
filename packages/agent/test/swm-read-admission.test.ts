import { describe, expect, it } from 'vitest';
import { resolvePrivateRootLegacyLaneAdmission, resolveSharedMemoryAdmission } from '../src/swm-read-admission.js';

describe('shared memory admission dependency outcomes', () => {
  it('identifies each unavailable dependency without turning it into a denial', async () => {
    const error = new Error('dependency unavailable');
    const fail = async () => { throw error; };
    const legacy = () => resolvePrivateRootLegacyLaneAdmission({ authorityId: () => '1',
      mergedMembership: fail, ownMembership: async () => true });
    await expect(legacy()).resolves.toEqual({ outcome: 'unavailable', source: 'legacy-membership', error });
    const reads = { acceptedAuthority: () => undefined, legacyLane: legacy,
      confirmedMetadata: async () => true, canRead: async () => true };
    await expect(resolveSharedMemoryAdmission({ ...reads, confirmedMetadata: fail }))
      .resolves.toEqual({ outcome: 'unavailable', source: 'confirmed-metadata', error });
    await expect(resolveSharedMemoryAdmission({ ...reads, canRead: fail }))
      .resolves.toEqual({ outcome: 'unavailable', source: 'read-authority', error });
  });

  it('preserves cancellation during a dependency failure as cancellation', async () => {
    const controller = new AbortController(), reason = new Error('cancelled');
    await expect(resolveSharedMemoryAdmission({ acceptedAuthority: () => undefined,
      legacyLane: async () => ({ outcome: 'denied' }), signal: controller.signal,
      confirmedMetadata: async () => { controller.abort(reason); throw new Error('transport closed'); },
      canRead: async () => true })).rejects.toBe(reason);
  });
});
