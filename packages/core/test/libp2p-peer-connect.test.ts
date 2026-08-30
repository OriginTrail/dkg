import { describe, expect, it, vi } from 'vitest';
import { connectLibp2pPeer } from '../src/network/libp2p-peer-connect.js';

const TARGET = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const RELAY_A = '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const RELAY_B = '/ip4/49.12.4.64/tcp/9090/p2p/12D3KooWJqhnnfouiNRUyJBEREpuKtV4A448LUbS6JiVCe8Q82bZ';
const CIRCUIT_A = `${RELAY_A}/p2p-circuit/p2p/${TARGET}`;
const CIRCUIT_B = `${RELAY_B}/p2p-circuit/p2p/${TARGET}`;
const TARGETLESS_DIRECT = '/ip4/178.105.87.39/tcp/9090';
const WRONG_TARGET = '12D3KooWR5C8ajtPigVGnBwDGTZ4XAtCepRs2WCgfPuBPrgGqcNK';

function targetString(target: unknown): string {
  return (target as { toString(): string }).toString();
}

describe('connectLibp2pPeer', () => {
  it('skips a private direct candidate and walks the following explicit circuit', async () => {
    const calls: string[] = [];
    const host = {
      getConnections: () => calls.includes(CIRCUIT_A)
        ? [{ remotePeer: { toString: () => TARGET } }]
        : [],
      dial: vi.fn(async (target: unknown) => { calls.push(targetString(target)); }),
      peerStore: { merge: vi.fn(async () => undefined) },
    };

    await connectLibp2pPeer(host, TARGET, [
      `/ip4/127.0.0.1/tcp/9090/p2p/${TARGET}`,
      CIRCUIT_A,
    ]);

    expect(calls).toEqual([RELAY_A, CIRCUIT_A]);
    expect(host.peerStore.merge).toHaveBeenCalledOnce();
  });

  it('advances after a signal-aware candidate reaches its local timeout', async () => {
    const calls: string[] = [];
    const host = {
      getConnections: () => calls.includes(CIRCUIT_B)
        ? [{ remotePeer: { toString: () => TARGET } }]
        : [],
      dial: vi.fn((target: unknown, options?: { signal?: AbortSignal }) => {
        const address = targetString(target);
        calls.push(address);
        if (address !== CIRCUIT_A) return Promise.resolve();
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new DOMException('candidate timed out', 'AbortError'));
          }, { once: true });
        });
      }),
      peerStore: { merge: vi.fn(async () => undefined) },
    };

    await connectLibp2pPeer(host, TARGET, [CIRCUIT_A, CIRCUIT_B], {
      candidateTimeoutMs: 5,
    });

    expect(calls).toEqual([RELAY_A, CIRCUIT_A, RELAY_B, CIRCUIT_B]);
  });

  it('does not accept a targetless direct dial until the requested peer is observed', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const host = {
        getConnections: () => calls.includes(CIRCUIT_B)
          ? [{ remotePeer: { toString: () => TARGET } }]
          : calls.includes(TARGETLESS_DIRECT)
            ? [{ remotePeer: { toString: () => WRONG_TARGET } }]
            : [],
        dial: vi.fn(async (target: unknown) => { calls.push(targetString(target)); }),
        peerStore: { merge: vi.fn(async () => undefined) },
      };

      const connection = connectLibp2pPeer(host, TARGET, [TARGETLESS_DIRECT, CIRCUIT_B], {
        candidateTimeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(50);
      await connection;

      expect(calls).toEqual([TARGETLESS_DIRECT, RELAY_B, CIRCUIT_B]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caller cancellation interrupts post-dial observation without trying the next route', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const calls: string[] = [];
      const host = {
        getConnections: () => [],
        dial: vi.fn(async (target: unknown) => { calls.push(targetString(target)); }),
        peerStore: { merge: vi.fn(async () => undefined) },
      };

      const connection = connectLibp2pPeer(host, TARGET, [TARGETLESS_DIRECT, CIRCUIT_B], {
        signal: controller.signal,
        candidateTimeoutMs: 5_000,
      });
      await Promise.resolve();
      controller.abort();

      await expect(connection).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls).toEqual([TARGETLESS_DIRECT]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces the final fallback failure instead of a candidate-local AbortError', async () => {
    const fallback = new Error('fallback transport failed');
    const host = {
      getConnections: () => [],
      dial: vi.fn((target: unknown, options?: { signal?: AbortSignal }) => {
        const address = targetString(target);
        if (address === CIRCUIT_A) {
          return new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              reject(new DOMException('candidate timed out', 'AbortError'));
            }, { once: true });
          });
        }
        if (address === TARGET) return Promise.reject(fallback);
        return Promise.resolve();
      }),
      peerStore: { merge: vi.fn(async () => undefined) },
    };

    await expect(connectLibp2pPeer(host, TARGET, [CIRCUIT_A], {
      candidateTimeoutMs: 5,
    })).rejects.toBe(fallback);
    expect(fallback.cause).toMatchObject({ name: 'AbortError' });
  });

  it('stops immediately when the caller-owned signal aborts', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const host = {
      getConnections: () => [],
      dial: vi.fn((target: unknown, options?: { signal?: AbortSignal }) => {
        calls.push(targetString(target));
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new DOMException('caller aborted', 'AbortError'));
          }, { once: true });
        });
      }),
      peerStore: { merge: vi.fn(async () => undefined) },
    };

    const pending = connectLibp2pPeer(host, TARGET, [CIRCUIT_A, CIRCUIT_B], {
      signal: controller.signal,
      candidateTimeoutMs: 5_000,
    });
    while (calls.length < 1) await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual([RELAY_A]);
  });
});
