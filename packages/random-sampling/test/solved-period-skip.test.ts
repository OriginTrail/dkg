// SPDX-License-Identifier: Apache-2.0

import type {
  ChainAdapter,
  NodeChallenge,
  RandomSamplingReadContext,
  RandomSamplingReadContextReader,
} from '@origintrail-official/dkg-chain';
import { describe, expect, it, vi } from 'vitest';
import {
  readCachedChallengeStaleness,
  SOLVED_PERIOD_MAX_SKIP_MS,
  SolvedPeriodSkip,
} from '../src/solved-period-skip.js';

function fixture() {
  const state = {
    head: 1010,
    ready: true,
    bindingId: 'rs-a:rss-a' as string | undefined,
    epoch: 3n,
    now: 0,
  };
  const chain = {
    getBlockNumber: vi.fn(async () => state.head),
    readRandomSamplingContext: vi.fn(async () =>
      state.ready && state.bindingId !== undefined
        ? Object.freeze({ bindingId: state.bindingId, chronosEpoch: state.epoch })
        : undefined),
    isRandomSamplingReadContextCurrent: vi.fn((context: RandomSamplingReadContext) =>
      state.ready && state.bindingId === context.bindingId),
  } as unknown as ChainAdapter & RandomSamplingReadContextReader;
  const skip = new SolvedPeriodSkip(chain, () => state.now);
  return { state, chain, skip };
}

async function remember(skip: SolvedPeriodSkip): Promise<void> {
  const context = await skip.captureReadContext();
  expect(context).toBeDefined();
  expect(skip.observe({
    context,
    challenge: {
      epoch: 3n,
      activeProofPeriodStartBlock: 1000n,
    } as NodeChallenge,
    staleness: { stale: false, head: 1010n },
    durationInBlocks: 100n,
  })).toBe(true);
}

describe('SolvedPeriodSkip', () => {
  it('reuses only inside the head, half-period, time, pair, and epoch guards', async () => {
    const { state, skip } = fixture();
    await remember(skip);
    state.head = 1059;
    expect(await skip.reusable()).toMatchObject({ periodStartBlock: 1000n });

    state.head = 1060;
    expect(await skip.reusable()).toBeUndefined();
  });

  it('caps a late observation at the last open-period block', async () => {
    const { state, skip } = fixture();
    state.head = 1075;
    const context = await skip.captureReadContext();
    expect(skip.observe({
      context,
      challenge: {
        epoch: 3n,
        activeProofPeriodStartBlock: 1000n,
      } as NodeChallenge,
      staleness: { stale: false, head: 1075n },
      durationInBlocks: 100n,
    })).toBe(true);

    state.head = 1098;
    expect(await skip.reusable()).toMatchObject({ rereadAtBlock: 1099n });
    state.head = 1099;
    expect(await skip.reusable()).toBeUndefined();
  });

  it.each([
    ['binding rotation', (state: ReturnType<typeof fixture>['state']) => { state.bindingId = 'rs-b:rss-b'; }],
    ['epoch transition', (state: ReturnType<typeof fixture>['state']) => { state.epoch = 4n; }],
    ['binding clear', (state: ReturnType<typeof fixture>['state']) => { state.ready = false; }],
    ['chain reset', (state: ReturnType<typeof fixture>['state']) => { state.head = 999; }],
    ['period rollover', (state: ReturnType<typeof fixture>['state']) => { state.head = 1100; }],
    ['wall-clock bound', (state: ReturnType<typeof fixture>['state']) => {
      state.now = SOLVED_PERIOD_MAX_SKIP_MS;
    }],
  ] as const)('forgets the record on %s', async (_label, mutate) => {
    const { state, skip } = fixture();
    await remember(skip);
    mutate(state);
    expect(await skip.reusable()).toBeUndefined();
    expect(await skip.reusable()).toBeUndefined();
  });

  it.each([
    ['binding rotation', (state: ReturnType<typeof fixture>['state']) => { state.bindingId = 'rs-b:rss-b'; }],
    ['binding clear', (state: ReturnType<typeof fixture>['state']) => { state.ready = false; }],
    ['wall-clock bound', (state: ReturnType<typeof fixture>['state']) => {
      state.now = SOLVED_PERIOD_MAX_SKIP_MS;
    }],
  ] as const)('rejects %s before spending head or epoch RPCs', async (_label, mutate) => {
    const { state, chain, skip } = fixture();
    await remember(skip);
    vi.mocked(chain.getBlockNumber!).mockClear();
    vi.mocked(chain.readRandomSamplingContext).mockClear();

    mutate(state);
    expect(await skip.reusable()).toBeUndefined();
    expect(chain.getBlockNumber).not.toHaveBeenCalled();
    expect(chain.readRandomSamplingContext).not.toHaveBeenCalled();
  });

  it('refuses to record unless context, head, and a positive live duration are present', async () => {
    const { skip } = fixture();
    const context = await skip.captureReadContext();
    const challenge = {
      epoch: 3n,
      activeProofPeriodStartBlock: 1000n,
    } as NodeChallenge;

    expect(skip.observe({
      context: undefined,
      challenge,
      staleness: { stale: false, head: 1010n },
      durationInBlocks: 100n,
    })).toBe(false);
    expect(skip.observe({
      context,
      challenge,
      staleness: { stale: false },
      durationInBlocks: 100n,
    })).toBe(false);
    expect(skip.observe({
      context,
      challenge,
      staleness: { stale: false, head: 1010n },
    })).toBe(false);
    expect(skip.observe({
      context,
      challenge,
      staleness: { stale: false, head: 1010n },
      durationInBlocks: 0n,
    })).toBe(false);
  });

  it('does not capture a reusable context without every capability', async () => {
    const { chain } = fixture();
    Reflect.deleteProperty(chain, 'isRandomSamplingReadContextCurrent');
    expect(await new SolvedPeriodSkip(chain).captureReadContext()).toBeUndefined();
  });

  it('returns the head with the cached-challenge staleness decision', async () => {
    const { chain, state } = fixture();
    const challenge = {
      activeProofPeriodStartBlock: 1000n,
      proofingPeriodDurationInBlocks: 20n,
    } as NodeChallenge;
    state.head = 1019;
    expect(await readCachedChallengeStaleness(chain, challenge, 20n))
      .toEqual({ stale: false, head: 1019n });
    state.head = 1020;
    expect(await readCachedChallengeStaleness(chain, challenge, 20n))
      .toEqual({ stale: true, head: 1020n });
  });
});
