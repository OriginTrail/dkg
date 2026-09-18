// catchup-runner-worker-retry-fold.test.ts
//
// The Worker catch-up runner folds every admission attempt of one plane into a
// single result. That fold serves two different consumers at once:
//
//   * DIAGNOSTICS, which want the counters of every attempt summed, and
//   * CLASSIFICATION, which decides `peersSucceeded` / `recordPeerRound` and
//     must see only the LATEST attempt — a retry that came back clean means the
//     peer is clean, which is what the pre-retry replace-latest behaviour
//     reported.
//
// Splitting them is the whole point of the fold, so each half is pinned here.
import {
  durableCatchupResult as durableResult,
  runWorkerCatchup,
} from './helpers/catchup-runner-worker-test-harness.js';
import { afterAll, describe, expect, it, vi } from 'vitest';

// The foreground backpressure budget is wall-clock (default 180 s). Shrink it
// for this file — but not as far as the sibling worker suite does, because the
// three-attempt case below needs the first two backoffs (~250 ms and ~500 ms)
// to fit inside it with room to spare. As in that suite this mutates the REAL
// process env, so it is restored afterwards for any daemon a sibling shard
// spawns later.
const previousCATCHUPBACKPRESSUREMAXWAITMS = vi.hoisted(() => {
  const before = process.env.DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS;
  process.env.DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS = '5000';
  return before;
});

afterAll(() => {
  if (previousCATCHUPBACKPRESSUREMAXWAITMS === undefined) delete process.env.DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS;
  else process.env.DKG_CATCHUP_BACKPRESSURE_MAX_WAIT_MS = previousCATCHUPBACKPRESSUREMAXWAITMS;
});

const singlePeer = {
  preferredPeerId: undefined,
  isPrivateContextGraph: false,
  peerIds: ['peer-1'],
  connectedPeers: 1,
};

describe('worker catch-up retry folding', () => {
  it('counts every deferral when a plane is admitted on the third attempt', async () => {
    // The durable fold rewrites `deferredBackpressure` to the latest attempt's
    // own value, because the policy reads that field as the retry control
    // signal. The summing reducer therefore has to be re-seeded from the
    // cumulative total on the next fold, or every attempt past the second drops
    // the ones before it. The loop is bounded by a wall-clock budget rather
    // than two tries, so three attempts is an ordinary outcome under sustained
    // backpressure — and `diagnostics.durable.deferredBackpressure` is exactly
    // the pressure signal this lane exists to expose.
    let durableCalls = 0;

    const result = await runWorkerCatchup(
      { contextGraphId: 'cg-thrice-deferred', includeSharedMemory: false },
      async (method) => {
        switch (method) {
          case 'prepareCatchup':
            return singlePeer;
          case 'waitForSyncProtocol':
            return true;
          case 'syncDurable':
            durableCalls += 1;
            return durableCalls < 3
              ? {
                  ...durableResult(),
                  insertedTriples: 0,
                  fetchedDataTriples: 0,
                  insertedDataTriples: 0,
                  bytesReceived: 0,
                  completedPhases: 0,
                  deferredBackpressure: 1,
                }
              : durableResult();
          case 'finalizeCatchup':
            return null;
          default:
            throw new Error(`unexpected invoke: ${method}`);
        }
      },
    );

    expect(durableCalls).toBe(3);
    // Two refusals happened, so two must be reported.
    expect(result.diagnostics?.durable.deferredBackpressure).toBe(2);
    // The job itself was not cut short: the latest attempt was admitted.
    expect(result.deferredBackpressure).toBe(0);
    expect(result.peersSucceeded).toBe(1);
  });
});
