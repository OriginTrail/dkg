// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { resolveEvmFinalityAnchorBlockV1 } from '../src/evm-finality-anchor.js';

const HASH = `0x${'ab'.repeat(32)}`;
const HEAD_HASH = `0x${'cd'.repeat(32)}`;

type Block = { number: number; hash: string | null };

function unavailable(detail: string): Error {
  return new Error(`anchor unavailable: ${detail}`);
}

function anchorReader(
  finalityConfirmations: number,
  head: Block | null | undefined,
  blocks: (blockNumber: number) => Block | null = (blockNumber) => (
    { number: blockNumber, hash: HASH }
  ),
) {
  const requested: number[] = [];
  let headReads = 0;
  return {
    requested,
    headReads: () => headReads,
    resolve: () => resolveEvmFinalityAnchorBlockV1<Block>({
      finalityConfirmations,
      readHead: async () => {
        headReads += 1;
        return head;
      },
      readBlockAt: async (blockNumber) => {
        requested.push(blockNumber);
        return blocks(blockNumber);
      },
      unavailable,
    }),
  };
}

const headAt = (number: number): Block => ({ number, hash: HEAD_HASH });

describe('the single chain finality anchor', () => {
  it.each([
    [2, 100, 99],
    [10, 100, 91],
    [101, 100, 0],
  ])('pins head - confirmations + 1 (depth %i, head %i)', async (
    confirmations,
    head,
    expected,
  ) => {
    const reader = anchorReader(confirmations, headAt(head));

    await expect(reader.resolve()).resolves.toEqual({ number: expected, hash: HASH });
    expect(reader.requested).toEqual([expected]);
  });

  it('reuses the head block as the anchor at the default depth', async () => {
    // Confirmation 1 IS the head, so the block already in hand is the anchor.
    // A second `readBlockAt` here would be a billed round-trip that a sibling
    // backend of a load-balanced URL can answer `null` — the race that used to
    // fail an authority read closed with a non-retryable error.
    const reader = anchorReader(1, headAt(100));

    await expect(reader.resolve()).resolves.toEqual({ number: 100, hash: HEAD_HASH });
    expect(reader.requested).toEqual([]);
    expect(reader.headReads()).toBe(1);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])(
    'fails closed on a depth that is not an integer >= 1 (%p)',
    async (confirmations) => {
      // A depth of 0 resolves to head + 1 — an anchor ABOVE the head this
      // module exists to make unrepresentable. The head is never even read.
      const reader = anchorReader(confirmations, headAt(100));

      await expect(reader.resolve()).rejects.toThrow('is not an integer >= 1');
      expect(reader.headReads()).toBe(0);
    },
  );

  it('fails closed when the head is below the configured depth', async () => {
    await expect(anchorReader(5, headAt(3)).resolve())
      .rejects.toThrow('chain head 3 is below the configured finality depth 5');
  });

  it.each([null, undefined])('fails closed when the head is missing (%p)', async (head) => {
    await expect(anchorReader(1, head).resolve())
      .rejects.toThrow('chain head is unavailable');
  });

  it.each([Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])(
    'fails closed on an unusable head height (%p)',
    async (number) => {
      await expect(anchorReader(1, { number, hash: HEAD_HASH }).resolve())
        .rejects.toThrow('chain head is not a usable block height');
    },
  );

  it.each([null, ''])('fails closed when the head carries no hash (%p)', async (hash) => {
    // The head is the anchor at the default depth, so it must satisfy the same
    // hash-pinning contract a deeper anchor does.
    await expect(anchorReader(1, { number: 100, hash }).resolve())
      .rejects.toThrow('chain head carries no block hash');
  });

  it.each([null, undefined])(
    'fails closed when the anchor block is missing (%p)',
    async (block) => {
      await expect(anchorReader(2, headAt(100), () => block as null).resolve())
        .rejects.toThrow('anchor block 99 is unavailable');
    },
  );

  it('fails closed when an endpoint answers a different height', async () => {
    // Under the `finalized` tag there was no expected height to compare
    // against; under an operator-selected depth there is, so an endpoint that
    // answers about a chain view this node did not select is rejected.
    await expect(anchorReader(2, headAt(100), () => ({ number: 97, hash: HASH })).resolve())
      .rejects.toThrow('anchor block 99 was answered by block 97');
  });

  it.each([Number.NaN, -1, 1.5])(
    'fails closed on an unusable anchor height (%p)',
    async (number) => {
      await expect(anchorReader(2, headAt(100), () => ({ number, hash: HASH })).resolve())
        .rejects.toThrow('anchor block 99 is not a usable block height');
    },
  );

  it.each([null, ''])('fails closed when the anchor carries no hash (%p)', async (hash) => {
    // Hash pinning is the contract: callers re-read this block later and refuse
    // a snapshot whose anchor hash moved. A number alone cannot support that.
    await expect(anchorReader(2, headAt(100), () => ({ number: 99, hash })).resolve())
      .rejects.toThrow('anchor block 99 carries no block hash');
  });
});
