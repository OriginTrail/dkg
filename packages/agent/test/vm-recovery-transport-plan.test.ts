import { describe, expect, it, vi } from 'vitest';
import {
  planVmRecoveryTransport,
  type VmRecoveryTransportPlanningOptions,
} from '../src/vm-recovery-transport-plan.js';
import type { VmRecoveryFootprintObservation, VmRecoveryPreparedHints } from '../src/vm-recovery-footprint.js';
import type { VmRecoveryChainFootprint } from '../src/vm-recovery-types.js';

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

  it('periodically leaves a competing legacy probe unbounded without using absence-proof state', async () => {
    const f = fixture();
    for (const ordinal of [0, 1, 2, 3, 4]) {
      const plan = await planVmRecoveryTransport({
        ...f.options,
        providerAttemptKind: 'probe',
        registeredPublicAccess: true,
        competingStreamAvailable: true,
        physicalAttemptOrdinal: ordinal,
      }, f.ports);
      expect(plan.transportMode).toBe('legacy');
      expect(plan.legacyAttemptTimeoutMs).toBe(ordinal === 3 ? undefined : 120_000);
    }
    expect((await planVmRecoveryTransport({ ...f.options, providerAttemptKind: 'probe',
      competingStreamAvailable: true }, f.ports)).legacyAttemptTimeoutMs).toBeUndefined();
    expect((await planVmRecoveryTransport({ ...f.options, providerAttemptKind: 'probe',
      registeredPublicAccess: true }, f.ports)).legacyAttemptTimeoutMs).toBeUndefined();
    expect((await planVmRecoveryTransport({ ...f.options, registeredPublicAccess: true,
      competingStreamAvailable: true }, f.ports)).legacyAttemptTimeoutMs).toBeUndefined();
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

describe('VM recovery transport planning with prepared sizing', () => {
  const hint = (byteSize: bigint): VmRecoveryChainFootprint => ({
    kind: 'public-v10', byteSize, merkleLeafCount: 8n, assertionVersion: '1', anchor: { kind: 'latest-bounded' },
  });
  function hints(ready: Record<string, VmRecoveryChainFootprint>) {
    const take = vi.fn(async (kaId: string) => ready[kaId]);
    return { take, port: { take } satisfies VmRecoveryPreparedHints };
  }

  it('serves a holder prefix from prepared hints without a live read for those assets', async () => {
    const f = fixture(4);
    const prepared = hints({ '1': hint(2_048n), '2': hint(2_048n) });
    const observed: VmRecoveryFootprintObservation[] = [];
    const plan = await planVmRecoveryTransport({ ...f.options, observeSizing: o => observed.push(o) },
      { ...f.ports, preparedHints: prepared.port });
    expect(plan.attempts).toEqual(f.attempts);
    expect(f.readUpdateContext.mock.calls.map(([id]) => id)).toEqual([3n, 4n]);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ requested: 4, prepared: 2, resolved: 2 });
  });

  it('plans exactly the same batch with or without prepared hints', async () => {
    const without = fixture(6);
    const baseline = await planVmRecoveryTransport(without.options, without.ports);
    const withHints = fixture(6);
    const prepared = hints(Object.fromEntries(withHints.attempts.map(a => [String(a.ordinal + 1), hint(1_024n)])));
    const plan = await planVmRecoveryTransport(withHints.options, { ...withHints.ports, preparedHints: prepared.port });
    expect(plan.attempts.map(a => a.ordinal)).toEqual(baseline.attempts.map(a => a.ordinal));
    expect(plan.transportMode).toBe(baseline.transportMode);
    expect(withHints.readUpdateContext).not.toHaveBeenCalled();
  });

  it('never consumes prepared hints for a probe, which sizes one asset to choose its wire', async () => {
    const f = fixture();
    const prepared = hints({ '1': hint(1_024n) });
    const plan = await planVmRecoveryTransport({ ...f.options, providerAttemptKind: 'probe',
      streamEligible: true, registeredPublicAccess: true }, { ...f.ports, preparedHints: prepared.port });
    expect(plan.transportMode).toBe('stream-preferred');
    expect(prepared.take).not.toHaveBeenCalled();
    expect(f.readUpdateContext.mock.calls.map(([id]) => id)).toEqual([1n]);
    expect(plan.unplanned).toEqual([]);
  });

  it('hands back the sized candidates after the selected prefix with their observed footprints', async () => {
    const f = fixture(12);
    // Candidate 4 cannot be sized, so the stable prefix stops there (unknown stays singleton).
    f.readUpdateContext.mockImplementation(async (kaId: bigint) => {
      if (kaId === 4n) throw new Error('Sizing unavailable');
      return { merkleRootsCount: 1n, byteSize: 1_024n, merkleLeafCount: 8 };
    });
    const plan = await planVmRecoveryTransport(f.options, f.ports);
    expect(plan.attempts.map(a => a.ordinal)).toEqual([0, 1, 2]);
    // Only the first ten candidates are sized; the unsized tail carries no footprint.
    expect(plan.unplanned.map(item => item.kaId)).toEqual(['4', '5', '6', '7', '8', '9', '10', '11', '12']);
    const byKa = new Map(plan.unplanned.map(item => [item.kaId, item.recoveryFootprint]));
    expect(byKa.get('4')).toEqual({ kind: 'unknown' });
    expect(byKa.get('5')?.kind).toBe('public-v10');
    expect(byKa.get('12')).toEqual({ kind: 'unknown' });
    expect(Object.isFrozen(plan.unplanned)).toBe(true);
    for (const item of plan.unplanned) expect(item.attempt).toBe(f.attempts[Number(item.kaId) - 1]);
  });

  it('bounds in-flight live sizing reads when asked, and only then', async () => {
    const run = async (sizingReadConcurrency?: number) => {
      const f = fixture(6);
      let active = 0;
      let maxActive = 0;
      f.readUpdateContext.mockImplementation(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        return { merkleRootsCount: 1n, byteSize: 1_024n, merkleLeafCount: 8 };
      });
      const options = sizingReadConcurrency === undefined ? f.options : { ...f.options, sizingReadConcurrency };
      await planVmRecoveryTransport(options, f.ports);
      return maxActive;
    };
    expect(await run()).toBe(6);
    expect(await run(2)).toBe(2);
  });
});

describe('VM recovery transport planning sizing deadline', () => {
  it('keeps the bridge deadline unless a longer one is requested, and only then waits that long', async () => {
    vi.useFakeTimers();
    try {
      const run = async (sizingReadTimeoutMs?: number) => {
        const f = fixture(1);
        f.readUpdateContext.mockImplementation(() => new Promise(resolve => setTimeout(
          () => resolve({ merkleRootsCount: 1n, byteSize: 1_024n, merkleLeafCount: 8 }), 3_000)));
        const observed: VmRecoveryFootprintObservation[] = [];
        const pending = planVmRecoveryTransport({ ...f.options, observeSizing: o => observed.push(o),
          ...(sizingReadTimeoutMs === undefined ? {} : { sizingReadTimeoutMs }) }, f.ports);
        await vi.advanceTimersByTimeAsync(6_000);
        await pending;
        return observed[0]!;
      };
      expect(await run()).toMatchObject({ timedOut: 1, resolved: 0 });
      expect(await run(5_000)).toMatchObject({ timedOut: 0, resolved: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});
