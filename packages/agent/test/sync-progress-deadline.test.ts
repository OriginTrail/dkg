import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchSyncPages, type SyncPageResult } from '../src/sync/requester/page-fetch.js';
import type { OperationContext } from '@origintrail-official/dkg-core';

/**
 * Regression tests for the v10.0.3 durable-sync timeout storm.
 *
 * Symptom on mainnet cores: the durable-data phase of a large SYSTEM context
 * graph ("agents"/"ontology" are 20k+ triples) timed out mid-stream — logging
 * "…(20000 triples received so far)…" — because the phase deadline
 * (`createContextGraphSyncDeadline` → `Date.now() + budgetMs`) is a FIXED
 * wall-clock window that cannot drain the whole graph while the responder is
 * under load. Each timeout retried, the responder-session supersede path wiped
 * the checkpoint, and the next attempt restarted from offset 0
 * ("…(0 triples received…)"): a non-converging retry storm that saturated the
 * node and starved its StorageACK handler (publish quorum failed network-wide).
 *
 * The fix (page-fetch.ts) makes the phase budget progress-aware: it is re-armed
 * after every page that makes forward progress, so a healthy-but-large transfer
 * completes in ONE session, while an absolute cap still bounds a peer that only
 * ever trickles a row per page.
 *
 * Time is driven through a `Date`-only fake clock advanced from inside the
 * `send` stub, so each page "costs" wall-clock time deterministically without a
 * real sleep. `send` resolves immediately (no retries), so `sendSyncRequest`'s
 * real `withRetry` timers never fire — leaving them un-faked is safe.
 */

const REMOTE_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const CG_ID = 'did:dkg:context-graph:agents';
const GRAPH_URI = `${CG_ID}/graph`;
const PROTOCOL_ID = '/dkg/10.0.2/sync';
const PAGE_SIZE = 500;
const BASE_MS = 1_700_000_000_000;
const BUDGET_MS = 10_000; // the floored/divided per-phase budget

function noopLog(): void {}
function makeCtx(): OperationContext {
  return { kind: 'system', id: 'test', startedAt: Date.now() } as never;
}

const nullCheckpointStore = {
  get: () => undefined,
  set: () => {},
  delete: () => {},
};

/**
 * Runs one durable-data phase against a peer that serves `fullPages` full pages
 * — each advancing the fake clock by `stepMs` — and then, if `terminate` is set,
 * an empty page that ends the phase cleanly. Returns the page result plus the
 * final fake-clock value so tests can assert elapsed wall-clock time.
 */
async function runPhase(opts: {
  fullPages: number;
  stepMs: number;
  terminate: boolean;
}): Promise<{ result: SyncPageResult; elapsedMs: number }> {
  let pagesSent = 0;
  const result = await fetchSyncPages({
    ctx: makeCtx(),
    remotePeerId: REMOTE_PEER_ID,
    contextGraphId: CG_ID,
    includeSharedMemory: false,
    phase: 'data',
    graphUri: GRAPH_URI,
    deadline: Date.now() + BUDGET_MS,
    syncPageTimeoutMs: 45_000,
    syncRouterAttempts: 3,
    syncPageRetryAttempts: 1,
    syncPageSize: PAGE_SIZE,
    syncDeniedResponse: '#DENIED',
    debugSyncProgress: false,
    protocolSync: PROTOCOL_ID,
    checkpointStore: nullCheckpointStore,
    buildSyncRequest: async () => new TextEncoder().encode('request'),
    parseAndFilter: async (nquadsText: string) => (
      nquadsText ? { quads: [], totalQuads: PAGE_SIZE } : { quads: [], totalQuads: 0 }
    ),
    send: async () => {
      // Each page "costs" `stepMs` of wall-clock time.
      vi.setSystemTime(Date.now() + opts.stepMs);
      pagesSent += 1;
      if (pagesSent > opts.fullPages) {
        // Empty body ⇒ end-of-stream; the phase completes cleanly.
        return opts.terminate ? new Uint8Array() : new TextEncoder().encode('page');
      }
      return new TextEncoder().encode('page');
    },
    logWarn: noopLog,
    logInfo: noopLog,
    logDebug: noopLog,
  });
  return { result, elapsedMs: Date.now() - BASE_MS };
}

describe('durable-sync progress-aware phase deadline (v10.0.3 storm fix)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BASE_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drains a large-but-healthy phase to completion even after the initial budget elapses', async () => {
    // 5 pages, 6s each = 30s of wall-clock, THREE TIMES the fixed 10s budget.
    // Pre-fix, the phase would have timed out after ~2 pages (~1000 triples,
    // the "20000 triples received so far" symptom at scale); the checkpoint
    // then thrashed and the next round restarted from 0.
    const { result, elapsedMs } = await runPhase({ fullPages: 5, stepMs: 6_000, terminate: true });

    expect(result.completed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.nextOffset).toBe(5 * PAGE_SIZE);
    // Proves the phase kept running well past the fixed initial budget.
    expect(elapsedMs).toBeGreaterThan(BUDGET_MS);
  });

  it('still times out (with an intact, resumable checkpoint) when a peer only trickles rows forever', async () => {
    // Every page makes progress but costs 30s — far slower than the phase can
    // ever finish. The absolute cap (8 × 10s = 80s) must bound it so it cannot
    // pin the responder slot indefinitely.
    const { result, elapsedMs } = await runPhase({ fullPages: 1_000, stepMs: 30_000, terminate: false });

    expect(result.timedOut).toBe(true);
    expect(result.completed).toBe(false);
    // Progress made before the cap is preserved — the next round resumes from
    // this offset instead of restarting from 0.
    expect(result.nextOffset).toBeGreaterThan(0);
    // Bounded by the absolute cap, not left running forever.
    expect(elapsedMs).toBeLessThanOrEqual(8 * BUDGET_MS + 30_000);
    expect(elapsedMs).toBeGreaterThan(BUDGET_MS);
  });

  it('completes a small phase within the initial budget unchanged (no regression)', async () => {
    // Two fast pages that finish comfortably inside the 10s budget behave
    // exactly as before the fix.
    const { result, elapsedMs } = await runPhase({ fullPages: 2, stepMs: 500, terminate: true });

    expect(result.completed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.nextOffset).toBe(2 * PAGE_SIZE);
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });
});
