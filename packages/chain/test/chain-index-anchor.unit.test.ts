// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';

import {
  chainIndexAuthorityAnchorHolds,
  resolveChainIndexAuthorityAnchor,
} from '../src/chain-index/chain-index-anchor.js';
import type { ChainEventLogState } from '../src/chain-index/chain-event-log.js';
import { CG_REGISTRY_REORG_BUFFER_BLOCKS } from '../src/evm-adapter-constants.js';
import { resolveEvmFinalityAnchorBlockV1 } from '../src/evm-finality-anchor.js';

const STORAGE = `0x${'cd'.repeat(20)}`;
const hash = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(32)}`;

/** Chain time and wall clock agree in the fixture; each guard moves one of them. */
const HEAD_TIMESTAMP_SECONDS = 1_700_000_000;
const NOW_MS = HEAD_TIMESTAMP_SECONDS * 1_000;

/**
 * The PRODUCTION shape, not a convenient one: the tick holds its settled
 * boundary `reorgHoldbackBlocks` under the head (evm-adapter-base.ts, which
 * passes `CG_REGISTRY_REORG_BUFFER_BLOCKS`). A fixture with a shorter tail
 * makes the live and log anchors agree by arithmetic accident at exactly the
 * depths a test happens to pick, which is how a 49-block gap stayed invisible.
 */
const SETTLED = 100;
const HEAD = SETTLED + CG_REGISTRY_REORG_BUFFER_BLOCKS;
/** The ONE depth below the head that the settled boundary itself satisfies. */
const SETTLED_DEPTH = HEAD - SETTLED + 1;

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
  const settled = overrides.settled ?? SETTLED;
  const head = overrides.head ?? settled + CG_REGISTRY_REORG_BUFFER_BLOCKS;
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
    expect(anchor?.finalized).toEqual({ number: HEAD, hash: hash(HEAD) });
    expect(anchor?.head.timestampSeconds).toBe(HEAD_TIMESTAMP_SECONDS);
    expect(anchor?.revision).toBe(1);
  });

  it('takes the settled boundary only when the depth lands ON it', () => {
    // head 150, depth 51 → the deepest admissible block is 100, which the head
    // is not; the settled boundary IS, and it is the only other block the log
    // can name with a hash.
    const { anchor } = resolve({ finalityConfirmations: SETTLED_DEPTH });

    expect(anchor?.finalized).toEqual({ number: SETTLED, hash: hash(SETTLED) });
  });

  it('refuses a depth whose anchor sits between the two blocks the log can name', () => {
    // head 150, depth 6 → the live read would pin 145. The log can name 150
    // (too shallow) and 100 (45 blocks STALER than 145, which no age guard
    // here bounds), so there is no anchor to serve — only the live scan.
    const result = resolve({ finalityConfirmations: 6 });

    expect(result.anchor).toBeUndefined();
    expect(result.refusal).toBe('behind-finality-anchor');
  });

  it('refuses when nothing the log can name is as DEEP as the operator asked', () => {
    // depth 52 → deepest admissible is 99; the settled boundary is 100, above
    // it, and the log holds no hash for 99.
    expect(resolve({ finalityConfirmations: SETTLED_DEPTH + 1 }).refusal)
      .toBe('below-finality-depth');
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
    const result = resolve({ state: state({ coveredThrough: HEAD - 2 }) });

    expect(result.refusal).toBe('no-coverage');
  });

  it('an incomplete family never becomes an anchor at all', () => {
    // The anchor carries no `complete` flag for a caller to consult, because a
    // flag nothing reads is a guard nothing has. The coverage gate IS the
    // guard: this family's floor is the contract's deploy block, so a record
    // that has not walked down to `deploymentBlockNumber` has not reached its
    // floor either, and it refuses here rather than handing back an anchor an
    // absence could be read off.
    for (const coveredFrom of [11, 60, HEAD]) {
      const result = resolve({
        state: state({ coveredFrom, floor: 10 }),
        deploymentBlockNumber: 10,
      });

      expect(result.anchor).toBeUndefined();
      expect(result.refusal).toBe('no-coverage');
    }

    // And the converse: reaching the deploy block IS reaching the floor, so
    // there is no admitted anchor whose family is incomplete.
    expect(resolve({ state: state({ coveredFrom: 10, floor: 10 }) }).anchor).toBeDefined();
  });

  it('S6: refuses an answer below this node own just-written block', () => {
    expect(resolve({ requiredBlockNumber: HEAD + 1 }).refusal).toBe('below-required-block');
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

/**
 * The one equivalence the module claims, measured against the function it
 * claims equivalence WITH, at the production tail length.
 *
 * `resolveEvmFinalityAnchorBlockV1` is what every reader used before the log
 * existed and what it falls back to on a refusal, so the property is not "the
 * log anchor is deep enough" — deeper is the weaker side for a staleness-
 * sensitive read — but "the log anchor is that block, or there is none".
 */
describe('resolveChainIndexAuthorityAnchor depth vs resolveEvmFinalityAnchorBlockV1', () => {
  /** The live anchor over the same synthetic chain the fixture's cursor names. */
  const liveAnchorAt = async (finalityConfirmations: number) => (
    resolveEvmFinalityAnchorBlockV1({
      finalityConfirmations,
      readHead: async () => ({ number: HEAD, hash: hash(HEAD) }),
      readBlockAt: async (blockNumber) => ({ number: blockNumber, hash: hash(blockNumber) }),
      unavailable: (detail) => new Error(detail),
    })
  );

  it.each([1, 2, 6, 25, 51, 52])(
    'at depth %i serves the live anchor block itself or refuses outright',
    async (finalityConfirmations) => {
      const live = await liveAnchorAt(finalityConfirmations);
      const { anchor, refusal } = resolve({ finalityConfirmations });

      if (anchor === undefined) {
        expect(refusal).toBeDefined();
        return;
      }
      expect(anchor.finalized).toEqual({ number: live.number, hash: live.hash });
    },
  );

  it('serves exactly the two depths the log can name, and refuses the rest', () => {
    // Without this the ladder above is vacuous: refusing EVERY depth would
    // satisfy it. Depth 1 is the head and depth 51 is the settled boundary —
    // the two blocks the cursor carries a hash for — and nothing between or
    // beyond them may be served.
    expect(resolve({ finalityConfirmations: 1 }).anchor?.finalized)
      .toEqual({ number: HEAD, hash: hash(HEAD) });
    expect(resolve({ finalityConfirmations: SETTLED_DEPTH }).anchor?.finalized)
      .toEqual({ number: SETTLED, hash: hash(SETTLED) });
    expect(resolve({ finalityConfirmations: 2 }).refusal).toBe('behind-finality-anchor');
    expect(resolve({ finalityConfirmations: 25 }).refusal).toBe('behind-finality-anchor');
    expect(resolve({ finalityConfirmations: SETTLED_DEPTH + 1 }).refusal)
      .toBe('below-finality-depth');
  });
});

describe('chainIndexAuthorityAnchorHolds', () => {
  const holdOptions = {
    nowMs: NOW_MS,
    maxHeadAgeMs: 18_000,
    headTimestampToleranceMs: 5 * 60_000,
  } as const;

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
      holdOptions,
    )).resolves.toBe(true);
  });

  it('refuses when the tick committed during the fold', async () => {
    // Every way the rows under a fold can change is a commit, and the store
    // never reuses a revision — so this is the whole of the `stabilize()` fence.
    const anchor = anchorOf();

    await expect(chainIndexAuthorityAnchorHolds(
      async () => state({ revision: 2 }),
      anchor,
      holdOptions,
    )).resolves.toBe(false);
  });

  it('refuses when the scope was tombstoned out from under the fold', async () => {
    const anchor = anchorOf();

    await expect(chainIndexAuthorityAnchorHolds(
      async () => undefined,
      anchor,
      holdOptions,
    )).resolves.toBe(false);
  });

  it('refuses a scope that picked up a fork suspicion during the fold', async () => {
    const anchor = anchorOf();
    const load = vi.fn(async () => ({
      ...state(),
      suspectedForkBlockNumber: 104,
    }));

    await expect(chainIndexAuthorityAnchorHolds(load, anchor, holdOptions)).resolves.toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('refuses when fetch-time freshness expires during the fold', async () => {
    const anchor = anchorOf();

    await expect(chainIndexAuthorityAnchorHolds(
      async () => state(),
      anchor,
      { ...holdOptions, nowMs: NOW_MS + holdOptions.maxHeadAgeMs + 1 },
    )).resolves.toBe(false);
  });

  it('refuses when chain-time freshness expires during the fold', async () => {
    const anchor = anchorOf();

    await expect(chainIndexAuthorityAnchorHolds(
      async () => state(),
      anchor,
      {
        nowMs: NOW_MS + holdOptions.headTimestampToleranceMs + 1,
        maxHeadAgeMs: 60 * 60_000,
        headTimestampToleranceMs: holdOptions.headTimestampToleranceMs,
      },
    )).resolves.toBe(false);
  });
});
