// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { resolveEvmFinalityAnchorBlockV1 } from '../src/evm-finality-anchor.js';

const HASH = `0x${'ab'.repeat(32)}`;

function unavailable(detail: string): Error {
  return new Error(`anchor unavailable: ${detail}`);
}

function anchorReader(
  finalityConfirmations: number,
  head: number,
  blocks: (blockNumber: number) => { number: number; hash: string | null } | null,
  requested: number[] = [],
) {
  return {
    requested,
    resolve: () => resolveEvmFinalityAnchorBlockV1({
      finalityConfirmations,
      readHeadBlockNumber: async () => head,
      readBlockAt: async (blockNumber) => {
        requested.push(blockNumber);
        return blocks(blockNumber);
      },
      unavailable,
    }),
  };
}

describe('the single chain finality anchor', () => {
  it.each([
    [1, 100, 100],
    [2, 100, 99],
    [10, 100, 91],
    [101, 100, 0],
  ])('pins head - confirmations + 1 (depth %i, head %i)', async (
    confirmations,
    head,
    expected,
  ) => {
    const reader = anchorReader(
      confirmations,
      head,
      (blockNumber) => ({ number: blockNumber, hash: HASH }),
    );

    await expect(reader.resolve()).resolves.toEqual({ number: expected, hash: HASH });
    expect(reader.requested).toEqual([expected]);
  });

  it('fails closed when the head is below the configured depth', async () => {
    await expect(anchorReader(
      5,
      3,
      () => ({ number: 0, hash: HASH }),
    ).resolve()).rejects.toThrow('chain head 3 is below the configured finality depth 5');
  });

  it.each([Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])(
    'fails closed on an unusable head (%p)',
    async (head) => {
      await expect(anchorReader(
        1,
        head,
        () => ({ number: 0, hash: HASH }),
      ).resolve()).rejects.toThrow('is not a usable block height');
    },
  );

  it('fails closed when the anchor block is missing', async () => {
    await expect(anchorReader(1, 100, () => null).resolve())
      .rejects.toThrow('anchor block 100 is unavailable');
  });

  it('fails closed when an endpoint answers a different height', async () => {
    // Under the `finalized` tag there was no expected height to compare
    // against; under an operator-selected depth there is, so an endpoint that
    // answers about a chain view this node did not select is rejected.
    await expect(anchorReader(1, 100, () => ({ number: 97, hash: HASH })).resolve())
      .rejects.toThrow('anchor block 100 was answered by block 97');
  });

  it.each([null, ''])('fails closed when the anchor carries no hash (%p)', async (hash) => {
    // Hash pinning is the contract: callers re-read this block later and refuse
    // a snapshot whose anchor hash moved. A number alone cannot support that.
    await expect(anchorReader(1, 100, () => ({ number: 100, hash })).resolve())
      .rejects.toThrow('anchor block 100 carries no block hash');
  });
});
