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

    expect(resolution).toEqual({ status: 'pending' });
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

    expect(await unrecognized.resolvePublishTransaction(TX_HASH)).toEqual({ status: 'pending' });
    expect(await confirmed.resolvePublishTransaction(TX_HASH)).toEqual({ status: 'pending' });
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
    finalized: { number: number; hash: string } | null;
    atHeight: { number: number; hash: string } | null;
  }) {
    const provider = {
      getBlock: vi.fn(async (tag: string | number) =>
        tag === 'finalized' ? script.finalized : script.atHeight),
    };
    return adapter({
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
    finalized: { number: number; hash: string } | null;
    atHeight: { number: number; hash: string } | null;
  }>) {
    const seen: number[] = [];
    const readOpts: Array<{ isEmptyResult?: (v: unknown) => boolean }> = [];
    const providers = scripts.map((script, index) => ({
      getBlock: async (tag: string | number) => {
        seen.push(index);
        return tag === 'finalized' ? script.finalized : script.atHeight;
      },
    }));
    const chain = adapter({
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

  it('an endpoint with no finalized view fails the gate OVER to a capable one [PR#2300 r5]', async () => {
    // 3812435954 — the `null` added in r5 exists to trigger failover, and nothing proved it did:
    // a regression returning `false` would stop at the incapable primary and pin every held job at
    // `pending` forever. Provider 0 cannot serve `finalized`; provider 1 can, and proves the
    // receipt final and canonical.
    const { chain, seen, readOpts } = chainOverProviders([
      { finalized: null, atHeight: null },
      { finalized: { number: 200, hash: `0x${'ee'.repeat(32)}` }, atHeight: { number: 123, hash: BLOCK_HASH } },
    ]);

    await expect(chain.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(true);
    // The answer came from the SECOND endpoint, and the read asked for empty-result failover.
    expect(seen).toContain(1);
    expect(readOpts[0]?.isEmptyResult?.(null)).toBe(true);
  });

  it('an endpoint missing the RECEIPT block also fails over, rather than answering false [r8]', async () => {
    // 3812585310 — the frontier read already treated a missing view as empty; the block-at-height
    // read did not, so a pruned or incomplete primary that serves `finalized` but not the older
    // receipt block answered `false` and stranded the job. `false` is now reserved for a block
    // that IS served and whose hash differs.
    const { chain, seen } = chainOverProviders([
      { finalized: { number: 200, hash: `0x${'ee'.repeat(32)}` }, atHeight: null },
      { finalized: { number: 200, hash: `0x${'ee'.repeat(32)}` }, atHeight: { number: 123, hash: BLOCK_HASH } },
    ]);

    await expect(chain.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(true);
    expect(seen).toContain(1);
  });

  it('true only when the height is behind the finalized frontier AND the hash still matches', async () => {
    const chain = chainOver({
      finalized: { number: 200, hash: `0x${'ee'.repeat(32)}` },
      atHeight: { number: 123, hash: BLOCK_HASH },
    });
    await expect(chain.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(true);
  });

  it('false while the receipt height is past the finalized frontier', async () => {
    const chain = chainOver({
      finalized: { number: 100, hash: `0x${'ee'.repeat(32)}` },
      atHeight: { number: 123, hash: BLOCK_HASH },
    });
    await expect(chain.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(false);
  });

  it('false when a DIFFERENT block occupies the receipt height — depth alone is not the test', async () => {
    // The canonicality half: the height is finalized, but the hash there is not the receipt's —
    // the receipt describes an orphaned copy of history.
    const chain = chainOver({
      finalized: { number: 200, hash: `0x${'ee'.repeat(32)}` },
      atHeight: { number: 123, hash: `0x${'99'.repeat(32)}` },
    });
    await expect(chain.isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(false);
  });

  it('false when the endpoint cannot serve the finalized frontier or the height', async () => {
    await expect(chainOver({ finalized: null, atHeight: { number: 123, hash: BLOCK_HASH } })
      .isReceiptBlockFinalAndCanonical(RECEIPT)).resolves.toBe(false);
    await expect(chainOver({ finalized: { number: 200, hash: `0x${'ee'.repeat(32)}` }, atHeight: null })
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
    expect(await mock.resolvePublishTransaction(TX_HASH)).toEqual({ status: 'pending' });

    mock.__setTransactionState(TX_HASH, 'mined');
    expect(await mock.resolvePublishTransaction(TX_HASH)).toEqual({ status: 'pending' });

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
    expect(gated).toEqual({ status: 'pending' });
    expect(gated.status).not.toBe('confirmed');

    mock.__setTransactionUnfinalized(published.txHash, false);
    expect((await mock.resolvePublishTransaction(published.txHash)).status).toBe('confirmed');
  });
});
