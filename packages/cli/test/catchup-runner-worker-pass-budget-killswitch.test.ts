// Pins the operator kill switch for the issue #2050 continuation passes,
// END TO END through the daemon-side Worker catch-up implementation.
//
// `DKG_SWM_CATCHUP_PASS_BUDGET_MS=0` is what an operator reaches for during an
// incident when a node's repeat walk is costing more than the partial graph it
// is chasing: it makes `deadlineMs` equal the job start, so the policy's `>=`
// comparison stops the loop before the first repeat, with no redeploy and no
// separate disabled branch in the walk.
//
// WHAT THIS FILE ADDS OVER THE EXISTING COVERAGE. The agent-side row
// (`packages/agent/test/catchup-pass-policy.test.ts`) exercises the PURE
// parser — `resolveSwmCatchupPassBudgetMs('0')` returns 0 — and the pure stop
// rule. Neither touches `process.env`, and neither runs the worker. So the
// whole delivery path was unproven: `SWM_CATCHUP_PASS_BUDGET_MS` is resolved
// ONCE AT MODULE LOAD in `catchup-pass-policy.ts` from
// `process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS`, exported from the agent,
// imported by `catchup-runner-worker-impl.ts`, and only there added to
// `catchupPassNowMs()` to form the deadline. A typo in the env NAME, a broken
// export/import, or a worker that used a literal default instead of the
// constant would leave every existing test green while the switch did nothing
// — and an operator would be pulling a lever wired to nothing, mid-incident.
//
// WHY IT IS ITS OWN FILE. The constant freezes at the first import of the
// policy module, so the env has to be set before that import. `vi.hoisted`
// runs before imports, and vitest gives each test FILE a fresh module registry,
// so a whole file under the switch is the shape the harness supports. It also
// keeps the switch off every other file: `runWorkerCatchup` here is a
// deliberate copy of the helper in `catchup-runner-worker-impl.test.ts` rather
// than a shared import, matching what `catchup-runner-worker-killswitch.test.ts`
// already does for `DKG_CATCHUP_STOP_ON_PROOF`.
//
// ANTI-VACUITY. The fixture below is copied verbatim from the control row
// `'runs a SECOND shared-memory pass, and only the shared-memory plane'` in
// `catchup-runner-worker-impl.test.ts`, which asserts that this exact fixture
// produces TWO `syncSharedMemory` calls. The env var is therefore the ONLY
// difference between a fixture that continues and this one that does not; a
// row whose fixture could never have continued would prove nothing about the
// switch.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SWM_CATCHUP_PASS_BUDGET_MS } from '@origintrail-official/dkg-agent';
import type { CatchupJobResult, CatchupRunRequest } from '../src/catchup-runner.js';

// Mutates the REAL process env, and vitest can reuse a worker process across
// files in a shard (both CLI configs run `maxWorkers: 1`). Without the restore
// below, anything loaded afterwards — a sibling suite's worker impl, a spawned
// daemon — would inherit a node that never runs a continuation pass, and those
// files would go green for a reason none of them state.
const previousSWMCATCHUPPASSBUDGETMS = vi.hoisted(() => {
  const before = process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS;
  process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS = '0';
  return before;
});

afterAll(() => {
  if (previousSWMCATCHUPPASSBUDGETMS === undefined) delete process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS;
  else process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS = previousSWMCATCHUPPASSBUDGETMS;
});

// The worker impl wires itself to `parentPort` at module load, so a
// controllable port has to be in place BEFORE the module is imported.
// Everything else from node:worker_threads stays real.
const fakeParentPort = vi.hoisted(() => {
  const messageListeners: Array<(message: any) => void> = [];
  const port = {
    on(event: string, listener: (message: any) => void) {
      if (event === 'message') messageListeners.push(listener);
    },
    /** Set per run by `runWorkerCatchup`; receives what the impl posts back. */
    onPosted: undefined as ((message: any) => void) | undefined,
    postMessage(message: any) {
      port.onPosted?.(message);
    },
    emitMessage(message: any) {
      for (const listener of messageListeners) listener(message);
    },
  };
  return port;
});

vi.mock('node:worker_threads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:worker_threads')>()),
  parentPort: fakeParentPort,
}));

function durableResult() {
  return {
    insertedTriples: 1,
    complete: true,
    fetchedMetaTriples: 0,
    fetchedDataTriples: 1,
    insertedMetaTriples: 0,
    insertedDataTriples: 1,
    bytesReceived: 10,
    resumedPhases: 0,
    timedOutPhases: 0,
    completedPhases: 1,
    checkpointAdvances: 0,
    emptyResponses: 0,
    metaOnlyResponses: 0,
    dataRejectedMissingMeta: 0,
    rejectedKcs: 0,
    failedPeers: 0,
    failedPhases: 0,
    deniedPhases: 0,
    deferredBackpressure: 0,
  };
}

function sharedResult() {
  return {
    insertedTriples: 1,
    fetchedMetaTriples: 0,
    fetchedDataTriples: 1,
    insertedMetaTriples: 0,
    insertedDataTriples: 1,
    bytesReceived: 10,
    resumedPhases: 0,
    timedOutPhases: 0,
    completedPhases: 1,
    checkpointAdvances: 0,
    emptyResponses: 0,
    droppedDataTriples: 0,
    failedPeers: 0,
    failedPhases: 0,
    deniedPhases: 0,
    deferredBackpressure: 0,
  };
}

let nextRunId = 1;

async function runWorkerCatchup(
  request: CatchupRunRequest,
  handler: (method: string, args: unknown[]) => Promise<unknown>,
): Promise<CatchupJobResult> {
  // The first call loads the module, which registers its message listener on
  // the mocked parentPort; later calls reuse it (distinct runIds).
  await import('../src/catchup-runner-worker-impl.js');
  const runId = nextRunId++;
  return new Promise<CatchupJobResult>((resolve, reject) => {
    fakeParentPort.onPosted = (message: any) => {
      if (message.type === 'invoke') {
        handler(message.method, message.args).then(
          (result) => fakeParentPort.emitMessage({ type: 'invoke-result', invokeId: message.invokeId, result }),
          (error: unknown) => fakeParentPort.emitMessage({
            type: 'invoke-result',
            invokeId: message.invokeId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return;
      }
      if (message.type === 'run-result' && message.runId === runId) {
        if (message.error) reject(new Error(message.error));
        else resolve(message.result as CatchupJobResult);
      }
    };
    fakeParentPort.emitMessage({ type: 'run', runId, request });
  });
}

describe('#2050 continuation-pass kill switch (DKG_SWM_CATCHUP_PASS_BUDGET_MS=0)', () => {
  const CG = 'continuation-killswitch-cg';
  const PEER = 'peer-continuation-0001';

  /**
   * A round that resolved part of its manifest and did NOT complete cleanly —
   * the shape the repeat loop exists for, and the shape that makes this row
   * meaningful.
   *
   * `failedPhases: 1` is load-bearing: without it the shared plane is proven by
   * data and the loop stops at `plane-proven` BEFORE the budget is ever
   * consulted, so the row would report `budget-exhausted`... never, and would
   * pass or fail for reasons unrelated to the switch.
   *
   * `manifestComplete: true` with `2 < 3` is what makes the peer CAPABLE: it is
   * the peer's own statement that it holds a ref we lack. Weaken it (truncate
   * the manifest, or report `3/3`) and the loop stops at `no-capable-peers` or
   * `coverage-stalled` whether the switch is set or not — a green row that
   * proves the switch is wired would then be pure coincidence.
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

    // Pass 1 is the ORIGINAL walk, which the budget must not touch — a switch
    // that also suppressed the first durable+SWM round would disable catch-up
    // rather than disable repeats, and `sharedCalls` alone cannot tell those
    // apart.
    expect(durableCalls).toEqual([PEER]);
    expect(result.sharedMemorySynced).toBe(1);
    expect(result.dataSynced).toBe(1);

    // `0`, not absent: the field is initialised on the diagnostics object and
    // overwritten only when a repeat actually ran.
    expect(result.diagnostics?.sharedMemory?.continuationPasses).toBe(0);
    // The REASON, not merely the absence of repeats. Every other stop reason on
    // this fixture would mean the loop declined for its own reasons and the
    // switch was never consulted; only `budget-exhausted` is reachable through
    // the env var, because the capable peer clears the plane-proven, stall and
    // capability gates ahead of it and `maxPasses` is still its default 4.
    expect(result.diagnostics?.sharedMemory?.continuationStopReason).toBe('budget-exhausted');

    // What an operator reads back to confirm the lever took effect. The pass
    // loop's only per-pass observability is fire-and-forget, so a terminal line
    // that stopped naming the reason would fail silently.
    expect(passLines.filter((line) => line.includes('stopped after 1 pass(es): budget-exhausted')))
      .toHaveLength(1);
    expect(passLines.filter((line) => line.startsWith('Catch-up SWM pass 2'))).toHaveLength(0);
  });

  it('resolves the module-load constant from the environment', async () => {
    // A localization aid, deliberately kept OUT of the behavioural row above so
    // that row proves the end-to-end path on its own. When both fail, the break
    // is in the env→constant hop (name, parse, export); when only the row above
    // fails, the constant is fine and the worker stopped using it.
    expect(SWM_CATCHUP_PASS_BUDGET_MS).toBe(0);
  });
});
