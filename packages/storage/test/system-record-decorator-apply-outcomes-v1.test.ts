import { describe, expect, it } from 'vitest';

import { GraphSetIndexStore } from '../src/graph-set-index-store.js';
import type {
  SystemRecordApplyOutcomeV1,
  SystemRecordLaneActivationV1,
  SystemRecordLaneControllerV1,
  SystemRecordLaneSessionV1,
} from '../src/system-record-materializer-v1.js';
import type { Quad, QueryOptions, QueryResult, TripleStore } from '../src/triple-store.js';

const ACTIVATION: SystemRecordLaneActivationV1 = {
  networkId: 'testnet',
  kinds: ['agents'],
  mode: 'shadow',
};

/**
 * The graph-set index wraps the lane session and applies OUTCOME-SPECIFIC cache
 * invalidation: `applied` dirties the index and schedules a full refresh,
 * `indeterminate` schedules a refresh without dirtying, and every other outcome
 * provably wrote nothing and must cost nothing — dirtying on those would force a
 * full-store scan, the exact cost this class exists to avoid.
 *
 * Until now the suite proved DISCOVERY (that the facade is forwarded) and not
 * the side effects, so all four branches could have been collapsed into one
 * without a test noticing.
 *
 * The observable used is `listGraphs()` reaching the inner store: a dirtied
 * index must re-scan, a clean one must answer from its warm set.
 */
class CountingInnerStore implements Partial<TripleStore> {
  listGraphCalls = 0;
  outcome: SystemRecordApplyOutcomeV1 = { outcome: 'root-collision' };

  private readonly session: SystemRecordLaneSessionV1 = {
    state: 'enabled',
    activationGeneration: '1',
    applyVerified: async () => this.outcome,
    close: async () => undefined,
  };

  async listGraphs(): Promise<string[]> {
    this.listGraphCalls += 1;
    return ['urn:g:1'];
  }

  async hasGraph(): Promise<boolean> {
    return true;
  }

  async query(): Promise<QueryResult> {
    return { type: 'boolean', value: true };
  }

  async insert(_quads: Quad[], _options?: QueryOptions): Promise<void> {}
  async close(): Promise<void> {}

  getSystemRecordLaneControllerV1(): SystemRecordLaneControllerV1 {
    return Object.freeze({ open: async () => this.session });
  }
}

const build = () => {
  const inner = new CountingInnerStore();
  // A long revalidation window, so any re-scan observed below is caused by the
  // apply outcome and not by the clock.
  const store = new GraphSetIndexStore(inner as unknown as TripleStore, {
    revalidateMs: 600_000,
  });
  return { inner, store };
};

describe('graph-set index applyVerified side effects', () => {
  const warmAndApply = async (outcome: SystemRecordApplyOutcomeV1) => {
    const { inner, store } = build();
    await store.listGraphs(); // warm
    const callsWhenWarm = inner.listGraphCalls;

    const lane = store.getSystemRecordLaneControllerV1?.();
    expect(lane).toBeDefined();
    const session = await lane!.open(ACTIVATION);

    inner.outcome = outcome;
    const returned = await session.applyVerified({});
    await store.listGraphs();

    const rescans = inner.listGraphCalls - callsWhenWarm;
    await store.close().catch(() => undefined);
    return { returned, rescans };
  };

  it('re-scans after an APPLIED outcome', async () => {
    const { returned, rescans } = await warmAndApply({
      outcome: 'applied',
      stateRevision: '1',
      appliedStateDigest: `0x${'a'.repeat(64)}`,
    });
    expect(returned.outcome).toBe('applied');
    expect(rescans).toBeGreaterThan(0);
  });

  it('re-scans after an INDETERMINATE outcome', async () => {
    // The write may or may not have landed, so the index cannot trust its set.
    const { returned, rescans } = await warmAndApply({
      outcome: 'indeterminate',
      recoveryGeneration: '2',
    });
    expect(returned.outcome).toBe('indeterminate');
    expect(rescans).toBeGreaterThan(0);
  });

  for (const outcome of [
    { outcome: 'root-collision' },
    { outcome: 'stale' },
    { outcome: 'capacity-exhausted' },
    { outcome: 'capability-lost' },
    { outcome: 'deferred', reason: 'validation-mismatch' },
    { outcome: 'already-applied', stateRevision: '1', appliedStateDigest: `0x${'b'.repeat(64)}` },
  ] as SystemRecordApplyOutcomeV1[]) {
    it(`does NOT re-scan after a ${outcome.outcome} outcome`, async () => {
      // Each of these provably wrote nothing. Dirtying the index would force a
      // full-store scan for no reason.
      const { returned, rescans } = await warmAndApply(outcome);
      expect(returned.outcome).toBe(outcome.outcome);
      expect(rescans).toBe(0);
    });
  }
});
