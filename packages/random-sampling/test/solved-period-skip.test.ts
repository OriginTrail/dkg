// SPDX-License-Identifier: Apache-2.0

import type {
  ChainAdapter,
  NodeChallenge,
  RandomSamplingReadContextReader,
} from '@origintrail-official/dkg-chain';
import { describe, expect, it, vi } from 'vitest';
import {
  SOLVED_PERIOD_MAX_SKIP_MS,
  SolvedPeriodSkip,
  type SolvedPeriodReadResult,
} from '../src/solved-period-skip.js';

function fixture() {
  const state = {
    head: 1010,
    ready: true,
    bindingId: 'rs-a:rss-a' as string | undefined,
    epoch: 3n,
    now: 0,
  };
  const contextReader: RandomSamplingReadContextReader = {
    getRandomSamplingBindingId: vi.fn(() =>
      state.ready ? state.bindingId : undefined),
    readRandomSamplingContext: vi.fn(async () =>
      state.ready && state.bindingId !== undefined
        ? Object.freeze({ bindingId: state.bindingId, chronosEpoch: state.epoch })
        : undefined),
    isRandomSamplingBindingCurrent: vi.fn((bindingId: string) =>
      state.ready && state.bindingId === bindingId),
  };
  const chain = {
    getBlockNumber: vi.fn(async () => state.head),
    getRandomSamplingReadContextReader: vi.fn(() => contextReader),
  } as unknown as ChainAdapter;
  const skip = new SolvedPeriodSkip(chain, () => state.now);
  return { state, chain, contextReader, skip };
}

function challenge(overrides: Partial<NodeChallenge> = {}): NodeChallenge {
  return {
    epoch: 3n,
    activeProofPeriodStartBlock: 1000n,
    proofingPeriodDurationInBlocks: 100n,
    solved: true,
    ...overrides,
  } as NodeChallenge;
}

async function observe(
  skip: SolvedPeriodSkip,
  options: Readonly<{
    value?: string;
    challenge?: NodeChallenge;
    durationInBlocks?: bigint;
    includeDuration?: boolean;
  }> = {},
): Promise<SolvedPeriodReadResult<string>> {
  const liveChallenge = options.challenge ?? challenge();
  return skip.read(async () => ({
    value: options.value ?? 'live',
    currentChallenge: {
      challenge: liveChallenge,
      ...(options.includeDuration === false
        ? {}
        : { durationInBlocks: options.durationInBlocks ?? 100n }),
    },
  }));
}

async function readWithoutChallenge(skip: SolvedPeriodSkip) {
  const read = vi.fn(async () => ({ value: 'live' }));
  const result = await skip.read(read);
  return { read, result };
}

describe('SolvedPeriodSkip', () => {
  it('reuses only inside the head, half-period, time, pair, and epoch guards', async () => {
    const { state, skip } = fixture();
    expect((await observe(skip)).kind).toBe('live');
    state.head = 1059;
    const reused = await readWithoutChallenge(skip);
    expect(reused.result).toMatchObject({ kind: 'reused', record: { periodStartBlock: 1000n } });
    expect(reused.read).not.toHaveBeenCalled();

    state.head = 1060;
    const live = await readWithoutChallenge(skip);
    expect(live.result.kind).toBe('live');
    expect(live.read).toHaveBeenCalledOnce();
  });

  it('caps a late observation at the last open-period block', async () => {
    const { state, skip } = fixture();
    state.head = 1075;
    await observe(skip);

    state.head = 1098;
    expect((await readWithoutChallenge(skip)).result)
      .toMatchObject({ kind: 'reused', record: { rereadAtBlock: 1099n } });
    state.head = 1099;
    expect((await readWithoutChallenge(skip)).result.kind).toBe('live');
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
    await observe(skip);
    mutate(state);
    expect((await readWithoutChallenge(skip)).result.kind).toBe('live');
    expect((await readWithoutChallenge(skip)).result.kind).toBe('live');
  });

  it('captures the binding before live reads and defers the epoch until a reusable result', async () => {
    const { chain, contextReader, skip } = fixture();
    const order: string[] = [];
    vi.mocked(contextReader.getRandomSamplingBindingId).mockImplementation(() => {
      order.push('binding');
      return 'rs-a:rss-a';
    });
    vi.mocked(contextReader.readRandomSamplingContext).mockImplementation(async () => {
      order.push('context');
      return { bindingId: 'rs-a:rss-a', chronosEpoch: 3n };
    });
    vi.mocked(chain.getBlockNumber!).mockImplementation(async () => {
      order.push('head');
      return 1010;
    });

    await skip.read(async () => {
      order.push('live');
      return {
        value: 'live',
        currentChallenge: { challenge: challenge(), durationInBlocks: 100n },
      };
    });
    expect(order).toEqual(['binding', 'live', 'head', 'context']);
  });

  it('uses one binding-checked block context for both head and epoch guards', async () => {
    const { state, chain, contextReader, skip } = fixture();
    contextReader.readRandomSamplingBlockContext = vi.fn(async () =>
      state.ready && state.bindingId !== undefined
        ? {
            bindingId: state.bindingId,
            chronosEpoch: state.epoch,
            headBlockNumber: BigInt(state.head),
          }
        : undefined);

    expect((await observe(skip)).kind).toBe('live');
    state.head = 1040;
    expect((await readWithoutChallenge(skip)).result.kind).toBe('reused');
    expect(chain.getBlockNumber).not.toHaveBeenCalled();
    expect(contextReader.readRandomSamplingContext).not.toHaveBeenCalled();
    expect(contextReader.readRandomSamplingBlockContext).toHaveBeenCalledTimes(2);

    state.epoch = 4n;
    const boundary = await readWithoutChallenge(skip);
    expect(boundary.result.kind).toBe('live');
    expect(boundary.read).toHaveBeenCalledOnce();
  });

  it('records a confirmed local submission without a follow-up challenge read', async () => {
    const { state, skip } = fixture();
    const first = await readWithoutChallenge(skip);
    expect(first.result).toMatchObject({
      kind: 'live',
      observationBindingId: 'rs-a:rss-a',
    });
    if (first.result.kind !== 'live') throw new Error('expected live result');

    await expect(skip.observeSubmittedProof({
      observationBindingId: first.result.observationBindingId,
      challenge: challenge({ solved: false }),
      durationInBlocks: 100n,
    })).resolves.toBe(true);

    state.head = 1040;
    const next = await readWithoutChallenge(skip);
    expect(next.result.kind).toBe('reused');
    expect(next.read).not.toHaveBeenCalled();
  });

  it('rejects a submitted-proof observation after the captured binding rotates', async () => {
    const { state, skip } = fixture();
    const first = await readWithoutChallenge(skip);
    if (first.result.kind !== 'live') throw new Error('expected live result');
    state.bindingId = 'rs-b:rss-b';

    await expect(skip.observeSubmittedProof({
      observationBindingId: first.result.observationBindingId,
      challenge: challenge({ solved: false }),
      durationInBlocks: 100n,
    })).resolves.toBe(false);
    expect((await readWithoutChallenge(skip)).result.kind).toBe('live');
  });

  it('does not read the Chronos epoch for a challenge that cannot be reused', async () => {
    const { contextReader, skip } = fixture();

    await observe(skip, { challenge: challenge({ solved: false }) });

    expect(contextReader.readRandomSamplingContext).not.toHaveBeenCalled();
  });

  it.each([
    ['missing context', (f: ReturnType<typeof fixture>) => { f.state.ready = false; }, {}],
    ['missing head', (f: ReturnType<typeof fixture>) => {
      vi.mocked(f.chain.getBlockNumber!).mockRejectedValue(new Error('head unavailable'));
    }, {}],
    ['missing live duration', () => undefined, { includeDuration: false }],
    ['zero live duration', () => undefined, { durationInBlocks: 0n }],
  ] as const)('does not record with %s', async (_label, arrange, options) => {
    const f = fixture();
    arrange(f);
    await observe(f.skip, options);
    const next = await readWithoutChallenge(f.skip);
    expect(next.result.kind).toBe('live');
    expect(next.read).toHaveBeenCalledOnce();
  });

  it('does not record without every read-context capability', async () => {
    const { chain } = fixture();
    vi.mocked(chain.getRandomSamplingReadContextReader!).mockReturnValue(undefined);
    const skip = new SolvedPeriodSkip(chain);
    await observe(skip);
    expect((await readWithoutChallenge(skip)).result.kind).toBe('live');
  });

  it('treats a read-context failure as unavailable for that observation', async () => {
    const { contextReader, skip } = fixture();
    vi.mocked(contextReader.readRandomSamplingContext)
      .mockRejectedValueOnce(new Error('Chronos RPC unavailable'));

    await observe(skip);
    expect((await observe(skip)).kind).toBe('live');
    expect((await readWithoutChallenge(skip)).result.kind).toBe('reused');
  });

  it('does not pair an old challenge with a newer Chronos epoch', async () => {
    const { state, skip } = fixture();
    const firstLive = vi.fn(async () => {
      state.epoch = 4n;
      return {
        value: 'first',
        currentChallenge: {
          challenge: challenge({ epoch: 3n }),
          durationInBlocks: 20n,
        },
      };
    });

    expect((await skip.read(firstLive)).kind).toBe('live');
    state.head = 1021;
    const next = await readWithoutChallenge(skip);
    expect(next.result.kind).toBe('live');
    expect(next.read).toHaveBeenCalledOnce();
  });

  it('returns the current challenge with its staleness decision', async () => {
    const { chain, state, skip } = fixture();
    const unsolved = challenge({
      proofingPeriodDurationInBlocks: 20n,
      solved: false,
    });
    state.head = 1019;
    expect(await observe(skip, { challenge: unsolved, durationInBlocks: 20n }))
      .toMatchObject({
        kind: 'live',
        currentChallenge: { challenge: unsolved, stale: false },
      });
    state.head = 1020;
    expect(await observe(skip, { challenge: unsolved, durationInBlocks: 20n }))
      .toMatchObject({
        kind: 'live',
        currentChallenge: { challenge: unsolved, stale: true },
      });
    expect(chain.getBlockNumber).toHaveBeenCalledTimes(2);
  });
});
