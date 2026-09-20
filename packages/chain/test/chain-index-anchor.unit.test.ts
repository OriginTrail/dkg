// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';

import {
  chainIndexAuthorityAnchorHolds,
  resolveChainIndexAuthorityAnchor,
} from '../src/chain-index/chain-index-anchor.js';
import type { ChainEventLogState } from '../src/chain-index/chain-event-log.js';

const STORAGE = `0x${'cd'.repeat(20)}`;
const hash = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(32)}`;

/** Chain time and wall clock agree in the fixture; each guard moves one of them. */
const HEAD_TIMESTAMP_SECONDS = 1_700_000_000;
const NOW_MS = HEAD_TIMESTAMP_SECONDS * 1_000;

function state(overrides: {
  settled?: number;
  head?: number;
  coveredFrom?: number;
  coveredThrough?: number;
  floor?: number;
  revision?: number;
  fetchedAtMs?: number;
  headTimestampSeconds?: number;
  suspectedForkBlockNumber?: number;
} = {}): ChainEventLogState {
  const settled = overrides.settled ?? 100;
  const head = overrides.head ?? settled + 5;
  return {
    cursor: {
      revision: overrides.revision ?? 1,
      lineage: hash(0x01),
      deploymentBlockNumber: 10,
      settledBlockNumber: settled,
      settledBlockHash: hash(settled),
      head: {
        number: head,
        hash: hash(head),
        timestampSeconds: overrides.headTimestampSeconds ?? HEAD_TIMESTAMP_SECONDS,
        fetchedAtMs: overrides.fetchedAtMs ?? NOW_MS,
      },
      topicSetVersion: 'v1',
    },
    coverage: [{
      family: 'context-graph-authority',
      address: STORAGE,
      coveredFromBlock: overrides.coveredFrom ?? 10,
      coveredThroughBlock: overrides.coveredThrough ?? head,
      floorBlock: overrides.floor ?? 10,
    }],
    ...(overrides.suspectedForkBlockNumber === undefined
      ? {}
      : { suspectedForkBlockNumber: overrides.suspectedForkBlockNumber }),
  };
}

const resolve = (
  input: Partial<Parameters<typeof resolveChainIndexAuthorityAnchor>[0]> = {},
) => resolveChainIndexAuthorityAnchor({
  state: state(),
  contractAddress: STORAGE,
  deploymentBlockNumber: 10,
  finalityConfirmations: 1,
  nowMs: NOW_MS,
  maxHeadAgeMs: 18_000,
  headTimestampToleranceMs: 5 * 60_000,
  ...input,
});

describe('resolveChainIndexAuthorityAnchor', () => {
  it('anchors at the operator depth — the HEAD at the default — and carries its CHAIN time', () => {
    const { anchor } = resolve();

    // The same block `resolveEvmFinalityAnchorBlockV1` pins at depth 1, so
    // moving the authority index onto the log does not move its horizon.
    expect(anchor?.finalized).toEqual({ number: 105, hash: hash(105) });
    expect(anchor?.head.timestampSeconds).toBe(HEAD_TIMESTAMP_SECONDS);
    expect(anchor?.complete).toBe(true);
    expect(anchor?.revision).toBe(1);
  });

  it('drops to the settled boundary once the operator asks for depth', () => {
    // head 105, depth 6 → the deepest admissible block is 100, which the head
    // is not; the settled boundary is, and it is the only other block the log
    // can name with a hash.
    const { anchor } = resolve({ finalityConfirmations: 6 });

    expect(anchor?.finalized).toEqual({ number: 100, hash: hash(100) });
  });

  it('refuses when nothing the log can name is as DEEP as the operator asked', () => {
    // depth 10 → deepest admissible is 96; the settled boundary is 100, above
    // it, and the log holds no hash for 96.
    expect(resolve({ finalityConfirmations: 10 }).refusal).toBe('below-finality-depth');
  });

  it('refuses a depth that is not an integer >= 1, rather than anchoring above the head', () => {
    // Depth 0 resolves to `head + 1`; admitting the head against it would make
    // the whole check decorative.
    expect(resolve({ finalityConfirmations: 0 }).refusal).toBe('below-finality-depth');
  });

  it('refuses when the tick has stored nothing for this scope', () => {
    expect(resolve({ state: undefined }).refusal).toBe('no-cursor');
  });

  it('refuses a contract the coverage record does not mention', () => {
    expect(resolve({ contractAddress: `0x${'ef'.repeat(20)}` }).refusal).toBe('no-coverage');
  });

  it('refuses while history below the cursor is still being backfilled', () => {
    // The anchor would otherwise be served from a prefix nobody has walked.
    const result = resolve({ state: state({ coveredFrom: 60 }) });

    expect(result.anchor).toBeUndefined();
    expect(result.refusal).toBe('no-coverage');
  });

  it('refuses when coverage stops below the anchor the depth selected', () => {
    // A catch-up still climbing: the head is known, the blocks under it are not.
    const result = resolve({ state: state({ coveredThrough: 103 }) });

    expect(result.refusal).toBe('no-coverage');
  });

  it('reports an incomplete family rather than letting it answer absent', () => {
    const result = resolve({ state: state({ coveredFrom: 10, floor: 1 }) });

    expect(result.anchor).toBeDefined();
    expect(result.anchor?.complete).toBe(false);
  });

  it('S6: refuses an answer below this node own just-written block', () => {
    expect(resolve({ requiredBlockNumber: 140 }).refusal).toBe('below-required-block');
    expect(resolve({ requiredBlockNumber: 90 }).anchor).toBeDefined();
  });

  it('refuses before the log has settled anything at all', () => {
    const result = resolve({ state: state({ settled: 9, head: 9 }) });

    expect(result.refusal).toBe('nothing-settled');
  });

  it('refuses a head the tick stopped refreshing, however servable the rows look', () => {
    // The whole coverage story is unchanged; only the tick went quiet. Without
    // this, a stalled log would pin its last head as "the chain" for good.
    expect(resolve({ nowMs: NOW_MS + 18_001 }).refusal).toBe('stale-head');
    expect(resolve({ nowMs: NOW_MS + 17_999 }).anchor).toBeDefined();
  });

  it('refuses a wall clock that stepped backwards, which proves no age at all', () => {
    expect(resolve({ nowMs: NOW_MS - 1 }).refusal).toBe('stale-head');
  });

  it('refuses a head that is fresh in FETCH time but old in CHAIN time', () => {
    // A responsive but lagging endpoint: the tick committed a second ago, and
    // what it committed is twenty minutes of the chain behind.
    const result = resolve({
      state: state({
        fetchedAtMs: NOW_MS,
        headTimestampSeconds: HEAD_TIMESTAMP_SECONDS - 20 * 60,
      }),
    });

    expect(result.refusal).toBe('head-behind-chain-time');
  });

  it('refuses while a settled-hash mismatch is held but not yet confirmed', () => {
    const result = resolve({ state: state({ suspectedForkBlockNumber: 98 }) });

    expect(result.refusal).toBe('fork-suspected');
  });
});

describe('chainIndexAuthorityAnchorHolds', () => {
  const anchorOf = (input: Parameters<typeof resolve>[0] = {}) => {
    const { anchor } = resolve(input);
    expect(anchor).toBeDefined();
    return anchor!;
  };

  it('holds while not one row under the fold has moved', async () => {
    const anchor = anchorOf();

    await expect(chainIndexAuthorityAnchorHolds(
      async () => state(),
      anchor,
    )).resolves.toBe(true);
  });

  it('refuses when the tick committed during the fold', async () => {
    // Every way the rows under a fold can change is a commit, and the store
    // never reuses a revision — so this is the whole of the `stabilize()` fence.
    const anchor = anchorOf();

    await expect(chainIndexAuthorityAnchorHolds(
      async () => state({ revision: 2 }),
      anchor,
    )).resolves.toBe(false);
  });

  it('refuses when the scope was tombstoned out from under the fold', async () => {
    const anchor = anchorOf();

    await expect(chainIndexAuthorityAnchorHolds(
      async () => undefined,
      anchor,
    )).resolves.toBe(false);
  });

  it('refuses a scope that picked up a fork suspicion during the fold', async () => {
    const anchor = anchorOf();
    const load = vi.fn(async () => ({
      ...state(),
      suspectedForkBlockNumber: 104,
    }));

    await expect(chainIndexAuthorityAnchorHolds(load, anchor)).resolves.toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
