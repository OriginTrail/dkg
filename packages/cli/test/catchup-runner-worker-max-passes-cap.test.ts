// Proves the one-pass operator cap through the real worker loop.
// Configuration is resolved at job start, so this suite shares the canonical
// worker harness and no longer depends on module-import order.
import {
  durableCatchupResult as durableResult,
  runWorkerCatchup,
  sharedCatchupResult as sharedResult,
} from './helpers/catchup-runner-worker-test-harness.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSwmCatchupPassConfig } from '@origintrail-official/dkg-agent';

beforeEach(() => {
  vi.stubEnv('DKG_SWM_CATCHUP_MAX_PASSES', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('#2050 continuation-pass cap (DKG_SWM_CATCHUP_MAX_PASSES=1)', () => {
  const CG = 'continuation-maxpasses-cg';
  const PEER = 'peer-continuation-0001';

  /**
   * A round that resolved part of its manifest and did NOT complete cleanly —
   * the shape the repeat loop exists for, and the shape that makes this row
   * meaningful.
   *
   * `failedPhases: 1` is load-bearing: without it the shared plane is proven by
   * data and the loop stops at `plane-proven` BEFORE the cap is ever consulted,
   * so the row would pass or fail for reasons unrelated to the env var.
   *
   * `manifestComplete: true` with `2 < 3` is what makes the peer CAPABLE: it is
   * the peer's own statement that it holds a ref we lack. Weaken it (truncate
   * the manifest, or report `3/3`) and the loop stops at `no-capable-peers` or
   * `coverage-stalled` whether the cap is set or not — a green row that proves
   * the cap is wired would then be pure coincidence.
   */
  function partialSharedRound(resolved: number, total: number) {
    return {
      ...sharedResult(),
      failedPhases: 1,
      swmCoverage: {
        contextGraphId: CG,
        peerIdSuffix: PEER.slice(-8),
        snapshotsResolved: resolved,
        snapshotsTotal: total,
        manifestComplete: true,
        missingCount: total - resolved,
        missingSample: resolved < total ? ['sha256:unresolved'] : [],
        materializationFailures: 0,
      },
    };
  }

  it('stops after ONE shared-memory round instead of continuing', async () => {
    const sharedCalls: string[] = [];
    const durableCalls: string[] = [];
    const passLines: string[] = [];

    const result = await runWorkerCatchup(
      { contextGraphId: CG, includeSharedMemory: true },
      async (method, args) => {
        switch (method) {
          case 'prepareCatchup':
            return { isPrivateContextGraph: false, peerIds: [PEER], connectedPeers: 1 };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            durableCalls.push(String(args[0]));
            return durableResult();
          case 'syncSharedMemory': {
            sharedCalls.push(String(args[0]));
            // Kept identical to the control row in
            // `catchup-runner-worker-impl.test.ts`, second branch included: there
            // the peer finishes its manifest on the repeat. Here the repeat must
            // never happen, so the branch is deliberately unreachable — and its
            // presence is what makes the env var the ONLY difference between the
            // two fixtures.
            //
            // The peer therefore ends the job still one Knowledge Asset short.
            // That is the cap doing its job, not a defect: it is an explicit
            // operator instruction to stop paying for repeats, and the
            // background reconcile lane remains the convergence path.
            return sharedCalls.length === 1
              ? partialSharedRound(2, 3)
              : partialSharedRound(3, 3);
          }
          case 'logCatchupPass':
            passLines.push(String(args[0]));
            return null;
          default:
            return null;
        }
      },
    );

    // THE row. Asserted as the call list, not as a diagnostic counter: the
    // counters are written by the same loop that would have dispatched the
    // repeat, while this is the network work the operator actually pulled the
    // lever to stop.
    expect(sharedCalls).toEqual([PEER]);

    // Pass 1 is the ORIGINAL walk, which the cap of 1 must still permit — a cap
    // that suppressed the first durable+SWM round would disable catch-up rather
    // than disable repeats, and `sharedCalls` alone cannot tell those apart.
    expect(durableCalls).toEqual([PEER]);
    expect(result.sharedMemorySynced).toBe(1);
    expect(result.dataSynced).toBe(1);

    // `0`, not absent: the field is initialised on the diagnostics object and
    // overwritten only when a repeat actually ran.
    expect(result.diagnostics?.sharedMemory?.continuationPasses).toBe(0);
    // The REASON, not merely the absence of repeats. On this fixture the capable
    // peer clears the plane-proven, stall and capability gates, and the wall-clock
    // budget is still its 600 s default — so `max-passes-reached` is reachable
    // ONLY through this env var. Any other reason here would mean the loop
    // declined for its own reasons and the cap was never consulted.
    expect(result.diagnostics?.sharedMemory?.continuationStopReason).toBe('max-passes-reached');

    // What an operator reads back to confirm the lever took effect. The pass
    // loop's only per-pass observability is fire-and-forget, so a terminal line
    // that stopped naming the reason would fail silently.
    expect(passLines.filter((line) => line.includes('stopped after 1 pass(es): max-passes-reached')))
      .toHaveLength(1);
    expect(passLines.filter((line) => line.startsWith('Catch-up SWM pass 2'))).toHaveLength(0);
  });

  it('resolves the per-job config from the environment', () => {
    expect(resolveSwmCatchupPassConfig().maxPasses).toBe(1);
  });
});
