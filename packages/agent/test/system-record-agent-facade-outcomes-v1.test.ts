import { describe, expect, it } from 'vitest';

import type {
  Quad,
  SystemRecordApplyOutcomeV1,
  SystemRecordLaneActivationV1,
  SystemRecordLaneControllerV1,
  SystemRecordLaneSessionV1,
  TripleStore,
} from '@origintrail-official/dkg-storage';

import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';

const ACTIVATION: SystemRecordLaneActivationV1 = {
  networkId: 'testnet',
  kinds: ['agents'],
  mode: 'shadow',
};

/**
 * The agent cache facade has DIFFERENT outcome semantics from the graph-set
 * index, and until now only the index half was covered.
 *
 * The index tracks graph MEMBERSHIP, so it refreshes on `applied` and
 * `indeterminate` only. This facade tracks readable CONTENT, so
 * `root-collision` matters to it too: that outcome durably quarantines and
 * rewrites state, which changes what a reader should observe even though no
 * named graph appears or disappears.
 *
 *   applied         -> invalidate + mark dirty
 *   root-collision  -> invalidate + mark dirty
 *   indeterminate   -> mark dirty only
 *   everything else -> neither
 */
class FakeInner implements Partial<TripleStore> {
  outcome: SystemRecordApplyOutcomeV1 = { outcome: 'stale' };
  laneAdvertised = true;

  private readonly session: SystemRecordLaneSessionV1 = {
    state: 'enabled',
    activationGeneration: '1',
    applyVerified: async () => this.outcome,
    close: async () => undefined,
  };

  async listGraphs(): Promise<string[]> {
    return [];
  }

  async insert(_quads: Quad[]): Promise<void> {}
  async close(): Promise<void> {}

  getSystemRecordLaneControllerV1(): SystemRecordLaneControllerV1 | undefined {
    if (!this.laneAdvertised) return undefined;
    return Object.freeze({ open: async () => this.session });
  }
}

const drive = async (outcome: SystemRecordApplyOutcomeV1) => {
  const inner = new FakeInner();
  let invalidated = 0;
  let dirtied = 0;
  const store = createListContextGraphsCacheInvalidatingStore(
    inner as unknown as TripleStore,
    () => {
      invalidated += 1;
    },
    () => {
      dirtied += 1;
    },
  );

  const lane = store.getSystemRecordLaneControllerV1?.();
  expect(lane).toBeDefined();
  const session = await lane!.open(ACTIVATION);

  inner.outcome = outcome;
  const returned = await session.applyVerified({});
  return { returned, invalidated, dirtied };
};

describe('agent cache facade applyVerified side effects', () => {
  it('invalidates and dirties on APPLIED', async () => {
    const { returned, invalidated, dirtied } = await drive({
      outcome: 'applied',
      stateRevision: '1',
      appliedStateDigest: `0x${'a'.repeat(64)}`,
    });
    expect(returned.outcome).toBe('applied');
    expect(invalidated).toBe(1);
    expect(dirtied).toBe(1);
  });

  it('invalidates and dirties on ROOT-COLLISION', async () => {
    // The behaviour that differs from the graph-set index, and the reason this
    // file exists: a root collision durably quarantines state, so a reader must
    // not keep serving what it cached — even though graph membership is
    // unchanged.
    const { returned, invalidated, dirtied } = await drive({ outcome: 'root-collision' });
    expect(returned.outcome).toBe('root-collision');
    expect(invalidated).toBe(1);
    expect(dirtied).toBe(1);
  });

  it('dirties WITHOUT invalidating on INDETERMINATE', async () => {
    // The write may or may not have landed. The projection must be rebuilt, but
    // there is nothing proven to invalidate a cached read against.
    const { returned, invalidated, dirtied } = await drive({
      outcome: 'indeterminate',
      recoveryGeneration: '2',
    });
    expect(returned.outcome).toBe('indeterminate');
    expect(invalidated).toBe(0);
    expect(dirtied).toBe(1);
  });

  for (const outcome of [
    { outcome: 'stale' },
    { outcome: 'capacity-exhausted' },
    { outcome: 'capability-lost' },
    { outcome: 'deferred', reason: 'validation-mismatch' },
    { outcome: 'already-applied', stateRevision: '1', appliedStateDigest: `0x${'b'.repeat(64)}` },
  ] as SystemRecordApplyOutcomeV1[]) {
    it(`does neither on ${outcome.outcome}`, async () => {
      const { returned, invalidated, dirtied } = await drive(outcome);
      expect(returned.outcome).toBe(outcome.outcome);
      expect(invalidated).toBe(0);
      expect(dirtied).toBe(0);
    });
  }

  it('stops advertising the lane once the inner store denies it', async () => {
    // Presence used to be memoized, so a cached wrapper kept advertising after
    // ownership was lost while the adapter underneath would have denied.
    const inner = new FakeInner();
    const store = createListContextGraphsCacheInvalidatingStore(
      inner as unknown as TripleStore,
      () => {},
      () => {},
    );

    expect(store.getSystemRecordLaneControllerV1?.()).toBeDefined();
    inner.laneAdvertised = false;
    expect(store.getSystemRecordLaneControllerV1?.()).toBeUndefined();
  });
});
