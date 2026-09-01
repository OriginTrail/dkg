import { describe, expect, it, vi } from 'vitest';
import {
  reconcileKnownTransaction,
  shouldInjectAcceptedBroadcastFault,
  type KnownTransaction,
} from './live-pca-publisher-lifecycle.js';

type Provider = Parameters<typeof reconcileKnownTransaction>[0];

const transaction: KnownTransaction = {
  from: '0x0000000000000000000000000000000000000001',
  hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  nonce: 7,
  signedTransaction: '0xdeadbeef',
};

function provider(overrides: Partial<Record<keyof Provider, unknown>> = {}): Provider {
  return {
    broadcastTransaction: vi.fn(),
    getTransaction: vi.fn().mockResolvedValue(null),
    getTransactionCount: vi.fn().mockResolvedValue(7),
    getTransactionReceipt: vi.fn().mockResolvedValue(null),
    waitForTransaction: vi.fn().mockResolvedValue({ status: 1 }),
    ...overrides,
  } as unknown as Provider;
}

describe('known transaction reconciliation', () => {
  it('never injects an accepted-broadcast fault when the hook or checkpoint is absent', () => {
    const fault = {
      checkpoint: 'pca-mint' as const,
      error: new Error('injected'),
    };

    expect(shouldInjectAcceptedBroadcastFault(undefined, undefined)).toBe(false);
    expect(shouldInjectAcceptedBroadcastFault(fault, undefined)).toBe(false);
    expect(shouldInjectAcceptedBroadcastFault(undefined, 'pca-mint')).toBe(false);
    expect(shouldInjectAcceptedBroadcastFault(fault, 'pca-funding')).toBe(false);
    expect(shouldInjectAcceptedBroadcastFault(fault, 'pca-mint')).toBe(true);
  });

  it('accepts an already-mined successful receipt without rebroadcasting', async () => {
    const rpc = provider({
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: 1 }),
    });

    await expect(reconcileKnownTransaction(rpc, transaction)).resolves.toBe('succeeded');
    expect(rpc.broadcastTransaction).not.toHaveBeenCalled();
  });

  it('rebroadcasts the exact signed payload while its nonce remains available', async () => {
    const rpc = provider({
      broadcastTransaction: vi.fn().mockResolvedValue({ hash: transaction.hash }),
    });

    await expect(reconcileKnownTransaction(rpc, transaction)).resolves.toBe('succeeded');
    expect(rpc.broadcastTransaction).toHaveBeenCalledWith(transaction.signedTransaction);
    expect(rpc.waitForTransaction).toHaveBeenCalledWith(transaction.hash, 1, 30_000);
  });

  it('reports replacement instead of rebroadcasting after the nonce is consumed', async () => {
    const rpc = provider({
      getTransactionCount: vi.fn().mockResolvedValue(8),
    });

    await expect(reconcileKnownTransaction(rpc, transaction)).resolves.toBe('replaced');
    expect(rpc.broadcastTransaction).not.toHaveBeenCalled();
  });

  it('never replaces an unrelated pending transaction at the recorded nonce', async () => {
    const getTransactionCount = vi.fn()
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(8);
    const rpc = provider({ getTransactionCount });

    await expect(reconcileKnownTransaction(rpc, transaction)).rejects.toThrow(
      'occupied by an unrelated pending transaction',
    );
    expect(rpc.broadcastTransaction).not.toHaveBeenCalled();
    expect(getTransactionCount).toHaveBeenNthCalledWith(1, transaction.from, 'latest');
    expect(getTransactionCount).toHaveBeenNthCalledWith(2, transaction.from, 'pending');
  });

  it('recovers an accepted transaction when the broadcast response is lost', async () => {
    const getTransactionReceipt = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 1 });
    const rpc = provider({
      broadcastTransaction: vi.fn().mockRejectedValue(new Error('connection reset')),
      getTransactionReceipt,
    });

    await expect(reconcileKnownTransaction(rpc, transaction)).resolves.toBe('succeeded');
    expect(getTransactionReceipt).toHaveBeenCalledTimes(2);
  });

  it('waits for a known pending transaction and reports a revert', async () => {
    const rpc = provider({
      getTransaction: vi.fn().mockResolvedValue({ hash: transaction.hash }),
      waitForTransaction: vi.fn().mockResolvedValue({ status: 0 }),
    });

    await expect(reconcileKnownTransaction(rpc, transaction)).resolves.toBe('reverted');
    expect(rpc.broadcastTransaction).not.toHaveBeenCalled();
  });

  it('reports a replacement when a failed broadcast races a consumed nonce', async () => {
    const getTransactionCount = vi.fn()
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(8);
    const rpc = provider({
      broadcastTransaction: vi.fn().mockRejectedValue(new Error('nonce too low')),
      getTransactionCount,
    });

    await expect(reconcileKnownTransaction(rpc, transaction)).resolves.toBe('replaced');
  });
});
