/**
 * PR #2300 r1 (🔴 3809054817) — no mined verdict before finality.
 *
 * A status-0 receipt in an UNFINALIZED block is not permanent proof: a reorg can re-include the
 * very same signed transaction on a chain where it SUCCEEDS. `reverted` releases the job's
 * lifecycle hold as proven-ineffective, `confirmed` finalizes it as published, and `unrecognized`
 * feeds update recognition — every one of them authorises a real action, so every one of them now
 * waits for the receipt's block to be FINAL and CANONICAL (its hash still occupying its height,
 * not merely any block at a finalized depth). Until then the answer is `pending`: the
 * transaction's fate is literally not final.
 *
 * Also here (🟡 3809054848): the adapter-level failure semantics — a receipt-stage or
 * transaction-stage lookup failure REJECTS, it never resolves to a status. An RPC error is an
 * absence of information, never information about an absence; the CLI resolver owns the mapping
 * of that rejection to `inconclusive`.
 */
import { describe, expect, it, vi } from 'vitest';
import { PublishMethods } from '../src/evm-adapter-publish.js';
import { MockChainAdapter } from '../src/mock-adapter.js';

const TX_HASH = `0x${'ab'.repeat(32)}`;
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;

function adapter(overrides: Record<string, unknown> = {}) {
  return Object.assign(Object.create(PublishMethods.prototype), {
    init: vi.fn(async () => undefined),
    finalityConfirmations: 1,
    contracts: { knowledgeAssetStorage: {} },
    getTransactionReceiptWithFailover: vi.fn(async () => null),
    getTransactionWithFailover: vi.fn(async () => null),
    getBlockTimestamp: vi.fn(async () => 1_234_567),
    parseV10PublishReceipt: vi.fn(async () => null),
    ...overrides,
  }) as PublishMethods;
}

function receipt(status: number) {
  return { hash: TX_HASH, status, blockNumber: 123, blockHash: BLOCK_HASH, index: 4, logs: [] };
}

describe('resolvePublishTransaction gates every mined verdict on finality [PR#2300 r1]', () => {
  it('reports pending — NOT reverted — for a status-0 receipt in an unfinalized block', async () => {
    // The reviewer's scenario: released as proven-ineffective, then the reorg re-includes the
    // same signed tx on a chain where it succeeds — a double publish authorised by a verdict
    // that was never permanent.
    const chain = adapter({
      getTransactionReceiptWithFailover: vi.fn(async () => receipt(0)),
      isReceiptBlockFinalAndCanonical: vi.fn(async () => false),
    });

    const resolution = await chain.resolvePublishTransaction(TX_HASH);

    // The observation marker reports the mined-but-not-deep receipt; the VERDICT stays pending.
    expect(resolution).toEqual({ status: 'pending', phase: 'awaiting-confirmations' });
    expect(resolution.status).not.toBe('reverted');
  });

  it('reports reverted for a status-0 receipt once its block is final and canonical', async () => {
    const chain = adapter({
      getTransactionReceiptWithFailover: vi.fn(async () => receipt(0)),
      isReceiptBlockFinalAndCanonical: vi.fn(async () => true),
    });

    expect(await chain.resolvePublishTransaction(TX_HASH)).toEqual({ status: 'reverted' });
  });

  it('holds status-1 verdicts behind the same gate — confirmed and unrecognized alike', async () => {
    // The class sweep: a confirmed-unfinalized receipt reaches the dispatcher's finalize and a
    // mined-unrecognized one feeds update recognition, so both wait exactly like the revert.
    const gateClosed = { isReceiptBlockFinalAndCanonical: vi.fn(async () => false) };
    const unrecognized = adapter({
      getTransactionReceiptWithFailover: vi.fn(async () => receipt(1)),
      ...gateClosed,
    });
    const confirmed = adapter({
      getTransactionReceiptWithFailover: vi.fn(async () => receipt(1)),
      parseV10PublishReceipt: vi.fn(async () => ({ batchId: 7n, txHash: TX_HASH })),
      ...gateClosed,
    });

    expect(await unrecognized.resolvePublishTransaction(TX_HASH))
      .toEqual({ status: 'pending', phase: 'awaiting-confirmations' });
    expect(await confirmed.resolvePublishTransaction(TX_HASH))
      .toEqual({ status: 'pending', phase: 'awaiting-confirmations' });
  });

  it('REJECTS when the finality read itself fails — a gate that cannot answer resolves nothing', async () => {
    const chain = adapter({
      getTransactionReceiptWithFailover: vi.fn(async () => receipt(0)),
      isReceiptBlockFinalAndCanonical: vi.fn(async () => {
        throw new Error('every endpoint rejected the finalized tag');
      }),
    });

    await expect(chain.resolvePublishTransaction(TX_HASH)).rejects.toThrow(/finalized tag/);
  });
});

describe('isReceiptBlockFinalAndCanonical [PR#2300 r1]', () => {
  function chainOver(script: {
    latestBlockNumber: number;
    atHeight: { number: number; hash: string } | null;
  }, finalityConfirmations = 1) {
    const provider = {
      getBlockNumber: vi.fn(async () => script.latestBlockNumber),
      getBlock: vi.fn(async () => script.atHeight),
    };
    return adapter({
      finalityConfirmations,
      readProvider: async (_label: string, fn: (p: unknown) => Promise<unknown>) => fn(provider),
    }) as PublishMethods & {
      isReceiptBlockFinalAndCanonical(r: { blockNumber: number; blockHash: string }): Promise<boolean>;
    };
  }
  /**
   * Ordered providers with the production EMPTY-RESULT policy modelled: a callback that yields
   * nothing moves to the next endpoint (that is what `readProviderRetryingNull` asks the transport
   * for), and only an all-empty walk answers null. The `readOpts` capture lets a row prove the
   * production code ASKED for that policy rather than relying on this stub's generosity.
   */
  function chainOverProviders(scripts: Array<{
    latestBlockNumber: number;
    atHeight: { number: number; hash: string } | null;
  }>, finalityConfirmations = 1) {
    const seen: number[] = [];
    const readOpts: Array<{ isEmptyResult?: (v: unknown) => boolean }> = [];
    const providers = scripts.map((script, index) => ({
      getBlockNumber: async () => {
        seen.push(index);
        return script.latestBlockNumber;
      },
      getBlock: async () => script.atHeight,
    }));
    const chain = adapter({
      finalityConfirmations,
      readProvider: async (
        _label: string,
        fn: (p: unknown) => Promise<unknown>,
        opts?: { isEmptyResult?: (v: unknown) => boolean },
      ) => {
        readOpts.push(opts ?? {});
        let sawEmpty = false;
        for (const provider of providers) {
          const value = await fn(provider);
          if (opts?.isEmptyResult?.(value)) { sawEmpty = true; continue; }
          return value;
        }
        return sawEmpty ? null : undefined;
      },
    }) as PublishMethods & {
      isReceiptBlockFinalAndCanonical(r: { blockNumber: number; blockHash: string }): Promise<boolean>;
    };
    return { chain, seen, readOpts };
  }

  const RECEIPT = { blockNumber: 123, blockHash: BLOCK_HASH };

  it('a lagging latest frontier fails over instead of deciding', async () => {
    const { chain, seen } = chainOverProviders([
      { latestBlockNumber: 123, atHeight: { number: 123, hash: BLOCK_HASH } },
      { latestBlockNumber: 124, atHeight: { number: 123, hash: BLOCK_HASH } },
    ], 2);

    await expect(chain.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(true);
    expect(seen).toContain(1);
  });

  it('answers false when no endpoint has reached the configured depth', async () => {
    const { chain } = chainOverProviders([
      { latestBlockNumber: 123, atHeight: { number: 123, hash: BLOCK_HASH } },
      { latestBlockNumber: 124, atHeight: { number: 123, hash: BLOCK_HASH } },
    ], 3);

    await expect(chain.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(false);
  });

  it('an endpoint missing the receipt block fails over rather than answering false', async () => {
    const { chain, seen, readOpts } = chainOverProviders([
      { latestBlockNumber: 123, atHeight: null },
      { latestBlockNumber: 123, atHeight: { number: 123, hash: BLOCK_HASH } },
    ]);

    await expect(chain.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(true);
    expect(seen).toContain(1);
    expect(readOpts[0]?.isEmptyResult?.(null)).toBe(true);
  });

  it('confirmation 1 accepts the receipt block itself when its hash is canonical', async () => {
    const chain = chainOver({
      latestBlockNumber: 123,
      atHeight: { number: 123, hash: BLOCK_HASH },
    });
    await expect(chain.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(true);
  });

  it('higher confirmation depths require the requested number of canonical blocks', async () => {
    const chain = chainOver({
      latestBlockNumber: 124,
      atHeight: { number: 123, hash: BLOCK_HASH },
    }, 3);
    await expect(chain.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(false);

    const reached = chainOver({
      latestBlockNumber: 125,
      atHeight: { number: 123, hash: BLOCK_HASH },
    }, 3);
    await expect(reached.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(true);
  });

  it('false when a different block occupies the receipt height — depth alone is not enough', async () => {
    const chain = chainOver({
      latestBlockNumber: 200,
      atHeight: { number: 123, hash: `0x${'99'.repeat(32)}` },
    });
    await expect(chain.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(false);
  });

  it('false when no endpoint can serve the receipt height', async () => {
    await expect(chainOver({ latestBlockNumber: 200, atHeight: null })
      .isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(false);
  });
});

describe('lookup failures REJECT — they never resolve to a status [PR#2300 r1, 🟡 3809054848]', () => {
  it('propagates a receipt-stage failure', async () => {
    const chain = adapter({
      getTransactionReceiptWithFailover: vi.fn(async () => {
        throw new Error('receipt lookup failed on every endpoint');
      }),
    });

    await expect(chain.resolvePublishTransaction(TX_HASH)).rejects.toThrow(/receipt lookup/);
  });

  it('propagates a transaction-stage failure', async () => {
    const chain = adapter({
      getTransactionReceiptWithFailover: vi.fn(async () => null),
      getTransactionWithFailover: vi.fn(async () => {
        throw new Error('transaction lookup failed on every endpoint');
      }),
    });

    await expect(chain.resolvePublishTransaction(TX_HASH)).rejects.toThrow(/transaction lookup/);
  });
});

describe('MockChainAdapter finality parity [PR#2300 r1]', () => {
  const WALLET = '0x1111111111111111111111111111111111111111';

  it('mines-and-finalizes instantly by default — existing verdicts unchanged', async () => {
    const mock = new MockChainAdapter('mock:31337', WALLET);
    mock.__setTransactionState(TX_HASH, 'reverted');
    expect(await mock.resolvePublishTransaction(TX_HASH)).toEqual({ status: 'reverted' });
  });

  it('reports pending for every mined verdict while a tx is declared unfinalized', async () => {
    const mock = new MockChainAdapter('mock:31337', WALLET);
    mock.__setTransactionState(TX_HASH, 'reverted');
    mock.__setTransactionUnfinalized(TX_HASH);
    expect(await mock.resolvePublishTransaction(TX_HASH))
      .toEqual({ status: 'pending', phase: 'awaiting-confirmations' });

    mock.__setTransactionState(TX_HASH, 'mined');
    expect(await mock.resolvePublishTransaction(TX_HASH))
      .toEqual({ status: 'pending', phase: 'awaiting-confirmations' });

    // Finality arrives; the underlying verdicts come back exactly as before.
    mock.__setTransactionUnfinalized(TX_HASH, false);
    expect(await mock.resolvePublishTransaction(TX_HASH)).toEqual({ status: 'unrecognized' });
  });

  it('gates the CONFIRMED-publish branch too: a real mock publish reads pending until final [PR#2300 r2]', async () => {
    // 🟡 3809616692 — the seam rows above drive declared states; this drives the mock's OWN
    // publish fixture (the event-log-backed confirmed branch), the one a recovery test actually
    // exercises, and proves the gate covers it in both polarities.
    const mock = new MockChainAdapter('mock:31337', WALLET);
    mock.minimumRequiredSignatures = 0;
    const { contextGraphId } = await mock.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1, // open
    });
    const published = await mock.publishToContextGraph({
      contextGraphId,
      kaCount: 1,
      publisherNodeIdentityId: 1n,
      merkleRoot: new Uint8Array(32),
      publicByteSize: 1n,
      epochs: 1,
      tokenAmount: 1n,
      publisherSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      receiverSignatures: [],
      participantSignatures: [{ identityId: 1n, r: new Uint8Array(32), vs: new Uint8Array(32) }],
      merkleLeafCount: 1,
    });

    mock.__setTransactionUnfinalized(published.txHash);
    const gated = await mock.resolvePublishTransaction(published.txHash);
    expect(gated).toEqual({ status: 'pending', phase: 'awaiting-confirmations' });
    expect(gated.status).not.toBe('confirmed');

    mock.__setTransactionUnfinalized(published.txHash, false);
    expect((await mock.resolvePublishTransaction(published.txHash)).status).toBe('confirmed');
  });
});
