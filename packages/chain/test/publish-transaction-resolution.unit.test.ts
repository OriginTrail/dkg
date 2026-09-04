/**
 * GH#2270 — `MockChainAdapter.resolvePublishTransaction` must be able to say
 * "I do not know whether this publish happened".
 *
 * `resolvePublishByTxHash` answers `OnChainPublishResult | null`, and recovery
 * used to read that `null` as absence. It is not: a transaction still sitting
 * in the mempool produces the same `null` as one the node has never heard of.
 * Resending on the first is a double publish. These tests pin that the mock —
 * the adapter the offline daemon runs, and the adapter every recovery unit test
 * will drive — can express each state distinctly, so a dispatcher built on it
 * is tested against something that can actually contradict it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MockChainAdapter } from '../src/mock-adapter.js';

const UNKNOWN_TX = `0x${'ab'.repeat(32)}`;

describe('MockChainAdapter publish-transaction tri-state [GH#2270]', () => {
  let adapter: MockChainAdapter;

  beforeEach(() => {
    adapter = new MockChainAdapter();
  });

  it('reports not-found only for a transaction it neither mined nor was told about', async () => {
    expect(await adapter.resolvePublishTransaction(UNKNOWN_TX)).toEqual({ status: 'not-found' });
  });

  it('reports pending — never not-found — for a declared in-flight transaction', async () => {
    // The load-bearing case: same hash, same empty event log, and the ONLY
    // difference is that the node holds the transaction. A resolver that
    // inferred absence from "no publish event" would answer 'not-found' here
    // and recovery would resend a tx that is about to be mined.
    adapter.__setTransactionState(UNKNOWN_TX, 'pending');

    const resolution = await adapter.resolvePublishTransaction(UNKNOWN_TX);

    expect(resolution).toEqual({ status: 'pending-mempool' });
    expect(resolution.status).not.toBe('not-found');
  });

  it('reports reverted for a mined failure receipt', async () => {
    adapter.__setTransactionState(UNKNOWN_TX, 'reverted');
    expect(await adapter.resolvePublishTransaction(UNKNOWN_TX)).toEqual({ status: 'reverted' });
  });

  it('reports unrecognized — not not-found — for a mined tx carrying no publish', async () => {
    // A successful tx that is not a publish is NOT proof that no publish
    // happened; it is proof about this transaction only. Keeping it off
    // 'not-found' keeps that distinction available to the caller.
    adapter.__setTransactionState(UNKNOWN_TX, 'mined');

    const resolution = await adapter.resolvePublishTransaction(UNKNOWN_TX);

    expect(resolution).toEqual({ status: 'unrecognized' });
    expect(resolution.status).not.toBe('not-found');
  });

  it('reports confirmed with the same publish resolvePublishByTxHash returns', async () => {
    adapter.minimumRequiredSignatures = 0;
    const { contextGraphId } = await adapter.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1, // open
    });
    const published = await adapter.publishToContextGraph({
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

    const resolution = await adapter.resolvePublishTransaction(published.txHash);
    const legacy = await adapter.resolvePublishByTxHash(published.txHash);

    expect(legacy).not.toBeNull();
    expect(resolution.status).toBe('confirmed');
    expect(resolution.status === 'confirmed' ? resolution.publish : null).toEqual(legacy);
  });

  it('clears a declared state back to not-found', async () => {
    adapter.__setTransactionState(UNKNOWN_TX, 'pending');
    adapter.__clearTransactionState(UNKNOWN_TX);
    expect(await adapter.resolvePublishTransaction(UNKNOWN_TX)).toEqual({ status: 'not-found' });
  });

  describe('resolveCanonicalFinalizationReceipt reads the same seam', () => {
    // The named-KA (KA-VM) recovery lane goes through this surface, so the same
    // pending-vs-absent distinction has to hold here or that lane keeps
    // fabricating absence. `rejected` fuses reverted with mined-but-unparseable
    // exactly as the EVM adapter does on this surface.
    it('reports pending for a declared in-flight transaction', async () => {
      adapter.__setTransactionState(UNKNOWN_TX, 'pending');
      expect(await adapter.resolveCanonicalFinalizationReceipt(UNKNOWN_TX))
        .toEqual({ status: 'pending' });
    });

    it('reports rejected for a reverted transaction', async () => {
      adapter.__setTransactionState(UNKNOWN_TX, 'reverted');
      expect(await adapter.resolveCanonicalFinalizationReceipt(UNKNOWN_TX))
        .toEqual({ status: 'rejected' });
    });

    it('still reports not-found for an undeclared transaction', async () => {
      expect(await adapter.resolveCanonicalFinalizationReceipt(UNKNOWN_TX))
        .toEqual({ status: 'not-found' });
    });
  });
});
