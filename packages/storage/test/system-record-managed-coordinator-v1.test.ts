import { beforeEach, describe, expect, it, vi } from 'vitest';

const probes = vi.hoisted(() => ({
  atomicFactory: vi.fn(),
  laneFactory: vi.fn(),
  resolveRuntime: vi.fn(),
  execute: vi.fn(),
  discard: vi.fn(),
  open: vi.fn(),
}));

vi.mock('../src/system-record-atomic-apply-executor-v1-internal.js', () => ({
  createSystemRecordAtomicApplyExecutorV1: probes.atomicFactory,
}));

// One controller constructor (#2179 round 3): the coordinator calls the
// single factory with its typed-only deps shape. The structural invariant is
// asserted below on the DEPS VALUE the factory receives — no 'barrier' key —
// rather than on which of two factories was called, because there is only
// one.
vi.mock('../src/system-record-materializer-v1.js', () => ({
  createSystemRecordLaneControllerV1: probes.laneFactory,
}));

vi.mock('../src/system-record-runtime-v1-internal.js', () => ({
  resolveOwnedSystemRecordRuntimeV1: probes.resolveRuntime,
}));

import { createManagedSystemRecordCoordinatorV1 } from '../src/adapters/system-record-managed-coordinator-v1-internal.js';

describe('managed system-record coordinator composition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    probes.resolveRuntime.mockReturnValue({ consumer: Object.freeze({ consumer: true }) });
    probes.atomicFactory.mockReturnValue({ execute: probes.execute, discard: probes.discard });
    probes.laneFactory.mockReturnValue({ open: probes.open });
  });

  it('wires the owned runtime, endpoints, legacy path and settlement executor exactly once', async () => {
    const lease = Object.freeze({ lease: true });
    const handoff = Object.freeze({ handoff: true });
    const storeId = Object.freeze({ store: true });
    const resolveClient = vi.fn();
    const applyLegacy = vi.fn().mockResolvedValue({ outcome: 'stale' });
    const typedBarrier = vi.fn();
    const setAdmissionActive = vi.fn();
    const controller = createManagedSystemRecordCoordinatorV1({
      lease,
      handoff,
      storeId,
      queryEndpoint: 'http://127.0.0.1:1/query',
      updateEndpoint: 'http://127.0.0.1:1/update',
      resolveClient,
      applyLegacy,
      typedBarrier,
      setAdmissionActive,
    } as never);

    expect(controller).toBe(probes.laneFactory.mock.results[0].value);
    expect(probes.resolveRuntime).toHaveBeenCalledExactlyOnceWith(lease);
    expect(probes.atomicFactory).toHaveBeenCalledExactlyOnceWith({
      consumer: { consumer: true },
      storeId,
      queryEndpoint: 'http://127.0.0.1:1/query',
      updateEndpoint: 'http://127.0.0.1:1/update',
      resolveClient,
    });

    const laneDeps = probes.laneFactory.mock.calls[0][0] as {
      lease: unknown;
      handoff: unknown;
      typedBarrier: unknown;
      setAdmissionActive: unknown;
      executor: {
        applyVerified(proof: unknown, childGeneration: string): Promise<unknown>;
        discardVerified(proof: unknown): void;
        applyVerifiedSettlementBound(
          proof: unknown,
          binding: unknown,
          registerRecovery: unknown,
        ): Promise<unknown>;
      };
    };
    expect(laneDeps).toMatchObject({
      lease,
      handoff,
      typedBarrier,
      setAdmissionActive,
    });
    // The typed factory receives NO string barrier — not undefined-valued,
    // structurally absent. This is the managed path's #2179 invariant at the
    // composition boundary, asserted on the deps object production passes.
    expect('barrier' in laneDeps).toBe(false);

    const proof = Object.freeze({ proof: true });
    const binding = Object.freeze({ binding: true });
    const registerRecovery = vi.fn();
    const settlement = Object.freeze({ settlement: 'no-mutation', outcome: { outcome: 'stale' } });
    probes.execute.mockResolvedValue(settlement);

    await expect(laneDeps.executor.applyVerified(proof, 'child-1')).resolves.toEqual({
      outcome: 'stale',
    });
    expect(applyLegacy).toHaveBeenCalledExactlyOnceWith(proof, 'child-1');
    laneDeps.executor.discardVerified(proof);
    expect(probes.discard).toHaveBeenCalledExactlyOnceWith(proof);
    await expect(laneDeps.executor.applyVerifiedSettlementBound(
      proof,
      binding,
      registerRecovery,
    )).resolves.toBe(settlement);
    expect(probes.execute).toHaveBeenCalledExactlyOnceWith(proof, binding, registerRecovery);
  });
});
