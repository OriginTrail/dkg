import { describe, expect, it, vi } from 'vitest';
import {
  planVmRecoveryTransport,
  type VmRecoveryTransportPlanningOptions,
} from '../src/vm-recovery-transport-plan.js';

function fixture(count = 3) {
  const attempts = Array.from({ length: count }, (_, ordinal) => ({ ordinal, credit: new Set<string>() }));
  const candidates = attempts.map(attempt => ({
    attempt, kaId: String(attempt.ordinal + 1),
    assetUal: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${attempt.ordinal + 1}`,
  }));
  const readUpdateContext = vi.fn(async (_kaId: bigint) => ({
    merkleRootsCount: 1n, byteSize: 1_024n, merkleLeafCount: 8,
  }));
  const ports = {
    resolvePublicAccess: vi.fn(async () => true),
    createSizingReader: vi.fn(() => ({ readUpdateContext })),
  };
  const options: VmRecoveryTransportPlanningOptions<typeof attempts[number]> = {
    candidates, providerAttemptKind: 'proven-holder-reuse', onChainCgId: 1n,
    streamEligible: false, registeredPublicAccess: false, isCurrent: () => true,
  };
  return { attempts, options, ports, readUpdateContext };
}

describe('VM recovery transport planning pipeline', () => {
  it('keeps ordinary probes singleton without inspecting authority or sizing ports', async () => {
    const f = fixture();
    const plan = await planVmRecoveryTransport({ ...f.options, providerAttemptKind: 'probe' }, f.ports);
    expect(plan).toMatchObject({ attempts: [f.attempts[0]], transportMode: 'legacy', publicAccessEvidence: undefined });
    expect(f.ports.createSizingReader).not.toHaveBeenCalled();
    expect(f.ports.resolvePublicAccess).not.toHaveBeenCalled();
    expect(f.readUpdateContext).not.toHaveBeenCalled();
  });

  it('uses one sizing read for a streaming probe without granting holder evidence', async () => {
    const f = fixture();
    const plan = await planVmRecoveryTransport({ ...f.options, providerAttemptKind: 'probe',
      streamEligible: true, registeredPublicAccess: true }, f.ports);
    expect(plan.attempts).toEqual([f.attempts[0]]);
    expect(plan.transportMode).toBe('stream-preferred');
    expect(plan.publicAccessEvidence).toBeUndefined();
    expect(f.readUpdateContext.mock.calls.map(([id]) => id)).toEqual([1n]);
    expect(f.ports.resolvePublicAccess).not.toHaveBeenCalled();
  });

  it('retains required streaming for a sized one-asset holder prefix', async () => {
    const f = fixture(1);
    const plan = await planVmRecoveryTransport({ ...f.options,
      streamEligible: true, registeredPublicAccess: true }, f.ports);
    expect(plan.transportMode).toBe('stream-required');
    expect(plan.attempts).toEqual(f.attempts);
    expect(plan.publicAccessEvidence).toBe(true);
  });

  it('sizes at most ten holder candidates and freezes the decision without changing credit ownership', async () => {
    const f = fixture(20);
    const plan = await planVmRecoveryTransport({ ...f.options,
      streamEligible: true, registeredPublicAccess: true }, f.ports);
    expect(f.readUpdateContext.mock.calls.map(([id]) => id)).toEqual(Array.from({ length: 10 }, (_, i) => BigInt(i + 1)));
    expect(plan.attempts).toEqual(f.attempts.slice(0, 10));
    expect(plan.transportMode).toBe('stream-required');
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.attempts)).toBe(true);
    expect(Object.isFrozen(plan.packing)).toBe(true);
    expect(() => (plan.attempts as typeof f.attempts).pop()).toThrow(TypeError);
    f.attempts[0]!.credit.add('host-owned');
    expect(plan.attempts[0]).toBe(f.attempts[0]);
    expect(plan.attempts[0]!.credit).toEqual(new Set(['host-owned']));
  });

  it.each(['unknown', 'oversize'] as const)('keeps the first %s candidate on ordinary singleton recovery', async footprint => {
    const f = fixture();
    if (footprint === 'unknown') f.readUpdateContext.mockRejectedValueOnce(new Error('Sizing unavailable'));
    else f.readUpdateContext.mockResolvedValueOnce({ merkleRootsCount: 1n, byteSize: 9n * 1024n * 1024n, merkleLeafCount: 10_000 });
    const plan = await planVmRecoveryTransport({ ...f.options,
      streamEligible: true, registeredPublicAccess: true }, f.ports);
    expect(plan.attempts).toEqual([f.attempts[0]]);
    expect(plan.transportMode).toBe('legacy');
  });

  it('packs ordinary holder recovery from one live public-access observation', async () => {
    const f = fixture();
    const plan = await planVmRecoveryTransport(f.options, f.ports);
    expect(plan.attempts).toEqual(f.attempts);
    expect(plan.transportMode).toBe('legacy');
    expect(plan.publicAccessEvidence).toBe(true);
    expect(f.ports.resolvePublicAccess).toHaveBeenCalledOnce();
    expect(f.ports.createSizingReader).toHaveBeenCalledOnce();
  });

  it('does not size private work and returns the observed non-public evidence', async () => {
    const f = fixture();
    f.ports.resolvePublicAccess.mockResolvedValue(false);
    const plan = await planVmRecoveryTransport(f.options, f.ports);
    expect(plan.attempts).toEqual([f.attempts[0]]);
    expect(plan.publicAccessEvidence).toBe(false);
    expect(f.readUpdateContext).not.toHaveBeenCalled();
  });

  it('keeps failed authority unobserved and does not read footprints', async () => {
    const f = fixture();
    f.ports.resolvePublicAccess.mockRejectedValue(new Error('Authority unavailable'));
    const plan = await planVmRecoveryTransport(f.options, f.ports);
    expect(plan.attempts).toEqual([f.attempts[0]]);
    expect(plan.publicAccessEvidence).toBeUndefined();
    expect(f.readUpdateContext).not.toHaveBeenCalled();
  });

  it('cannot acquire public evidence from an authority callback that settles after cancellation', async () => {
    const f = fixture();
    const controller = new AbortController();
    let settleAuthority!: (allowed: boolean) => void;
    f.ports.resolvePublicAccess.mockImplementation(() => new Promise(resolve => { settleAuthority = resolve; }));
    const pending = planVmRecoveryTransport({ ...f.options, signal: controller.signal }, f.ports);
    expect(f.ports.resolvePublicAccess).toHaveBeenCalledOnce();
    controller.abort();
    const plan = await pending;
    settleAuthority(true);
    await Promise.resolve();
    expect(plan.publicAccessEvidence).toBeUndefined();
    expect(plan.transportMode).toBe('legacy');
    expect(plan.attempts).toEqual([f.attempts[0]]);
    expect(f.readUpdateContext).not.toHaveBeenCalled();
  });

  it('discards evidence when sizing outlives the current recovery authority', async () => {
    const f = fixture(1);
    let current = true;
    f.readUpdateContext.mockImplementation(async () => {
      current = false;
      return { merkleRootsCount: 1n, byteSize: 1_024n, merkleLeafCount: 8 };
    });
    const plan = await planVmRecoveryTransport({ ...f.options,
      streamEligible: true, registeredPublicAccess: true, isCurrent: () => current }, f.ports);
    expect(plan.transportMode).toBe('legacy');
    expect(plan.publicAccessEvidence).toBeUndefined();
  });
});
