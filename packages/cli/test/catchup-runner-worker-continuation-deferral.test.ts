// A best-effort CONTINUATION pass must never demote a job that already
// succeeded, and denial must count DISTINCT peers once the walk can repeat.
//
// Both of these are consequences of making the walk repeatable, and neither is
// visible in the terminal record — they are visible only in the two scalars the
// daemon route branches on. See the deferral gate in `accumulate`.
import {
  durableCatchupResult as durableResult,
  runWorkerCatchup,
  sharedCatchupResult as sharedResult,
} from './helpers/catchup-runner-worker-test-harness.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A locally-deferred plane is RETRIED first, and only surfaces as
// `deferredBackpressure` once its admission-retry budget expires
// (`CATCHUP_BACKPRESSURE_MAX_WAIT_MS`, 180 s by default). Left at the default
// these rows sit in that wait and die on the vitest timeout — which would read
// as a failing assertion while proving nothing. Collapsing the budget to zero
// makes "pressure never cleared" immediate, which is the state the daemon route
// actually branches on.
beforeEach(() => {
  vi.stubEnv('DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('#2050 continuation passes must not demote a successful job', () => {
  const CG = 'continuation-deferral-cg';
  const PEER = 'peer-continuation-0001';

  /**
   * A round that resolved part of its manifest and did NOT complete cleanly.
   *
   * `failedPhases: 1` is load-bearing: without it the shared plane is proven by
   * data and the loop stops at `plane-proven` BEFORE the capability gate is
   * consulted, so no continuation pass would run at all and the row would pass
   * for a reason unrelated to what it claims.
   *
   * `manifestComplete: true` with `resolved < total` is what makes the peer
   * CAPABLE — the peer's own statement that it holds a ref we lack.
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
        missingSample: [],
        materializationFailures: 0,
      },
    };
  }

  it('does NOT report job-level backpressure when only a CONTINUATION pass is deferred', async () => {
    // Pass 1 does its mandatory work with no deferral. The extra pass — which
    // the job never needed — is refused capacity by the local scheduler.
    const sharedCalls: string[] = [];

    const result = await runWorkerCatchup(
      { contextGraphId: CG, includeSharedMemory: true },
      async (method, args) => {
        switch (method) {
          case 'prepareCatchup':
            return { isPrivateContextGraph: false, peerIds: [PEER], connectedPeers: 1 };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            return durableResult();
          case 'syncSharedMemory': {
            sharedCalls.push(String(args[0]));
            return sharedCalls.length === 1
              ? partialSharedRound(2, 3)
              : { ...partialSharedRound(2, 3), deferredBackpressure: 1 };
          }
          default:
            return null;
        }
      },
    );

    // The continuation pass really ran and really was deferred — without this
    // the row proves nothing, because a job that never reached pass 2 trivially
    // reports zero deferrals.
    expect(sharedCalls).toHaveLength(2);
    expect(result.diagnostics?.sharedMemory?.deferredBackpressure).toBe(1);

    // ...and yet the JOB-LEVEL scalar stays 0. This is the whole property:
    // `deferredBackpressure > 0` makes the daemon route short-circuit before
    // classification, which is the only path to the readiness write, the
    // subscription patch and PROJECT_SYNCED. A refused OPTIONAL pass must not
    // discard the readiness that pass 1 legitimately earned.
    expect(result.deferredBackpressure).toBe(0);
  });

  it('DOES report job-level backpressure when the MANDATORY first pass is deferred', async () => {
    // The negative control, and the reason the row above is not vacuous: gating
    // on the wrong thing (or on nothing) would make both rows agree. Here the
    // deferral happens in pass 1, where the route's premise — "an incomplete
    // round has no readiness to inspect" — is true and must still hold.
    const result = await runWorkerCatchup(
      { contextGraphId: CG, includeSharedMemory: true },
      async (method) => {
        switch (method) {
          case 'prepareCatchup':
            return { isPrivateContextGraph: false, peerIds: [PEER], connectedPeers: 1 };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            return durableResult();
          case 'syncSharedMemory':
            return { ...sharedResult(), deferredBackpressure: 1 };
          default:
            return null;
        }
      },
    );

    expect(result.deferredBackpressure).toBe(1);
  });

  it('counts DISTINCT denied peers, not peer-passes', async () => {
    // Denial from inside the snapshot walk still attaches progress, so the peer
    // stays capable and is contacted again. A scalar `+= 1` per round counted
    // the same peer twice — the drift the review predicted, and a disagreement
    // with the agent driver, which already models this as a set.
    const sharedCalls: string[] = [];

    const result = await runWorkerCatchup(
      { contextGraphId: CG, includeSharedMemory: true },
      async (method, args) => {
        switch (method) {
          case 'prepareCatchup':
            return { isPrivateContextGraph: false, peerIds: [PEER], connectedPeers: 1 };
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            return durableResult();
          case 'syncSharedMemory': {
            sharedCalls.push(String(args[0]));
            return { ...partialSharedRound(2, 3), deniedPhases: 1 };
          }
          default:
            return null;
        }
      },
    );

    // One peer, contacted on two passes, denying on both.
    expect(sharedCalls).toHaveLength(2);
    expect(result.deniedPeers).toBe(1);
    expect(result.denied).toBe(true);
  });
});
