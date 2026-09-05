import { describe, expect, it, vi } from 'vitest';
import {
  connectLibp2pPeer,
  planLibp2pPeerConnectionAddresses,
} from '../src/network/libp2p-peer-connect.js';

const TARGET = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const RELAY_A = '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const RELAY_B = '/ip4/49.12.4.64/tcp/9090/p2p/12D3KooWJqhnnfouiNRUyJBEREpuKtV4A448LUbS6JiVCe8Q82bZ';
const CIRCUIT_A = `${RELAY_A}/p2p-circuit/p2p/${TARGET}`;
const CIRCUIT_B = `${RELAY_B}/p2p-circuit/p2p/${TARGET}`;
const TARGETLESS_DIRECT = '/ip4/178.105.87.39/tcp/9090';
const WRONG_TARGET = '12D3KooWR5C8ajtPigVGnBwDGTZ4XAtCepRs2WCgfPuBPrgGqcNK';
const RELAY_C_PEER = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const RELAY_D_PEER = '12D3KooWFWm8sg6dkitmdBd5Uxaqp3CDRL27mFcM7vEHK92Xapyy';
const RELAY_E_PEER = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';

const CONFIGURED_RELAYS = [
  { peerId: RELAY_A.split('/').at(-1)!, addresses: [RELAY_A] },
  { peerId: RELAY_B.split('/').at(-1)!, addresses: [RELAY_B] },
  {
    peerId: RELAY_C_PEER,
    addresses: [`/ip4/178.104.54.30/tcp/9090/p2p/${RELAY_C_PEER}`],
  },
  {
    peerId: RELAY_D_PEER,
    addresses: [`/ip4/178.104.54.31/tcp/9090/p2p/${RELAY_D_PEER}`],
  },
  {
    peerId: RELAY_E_PEER,
    addresses: [`/ip4/178.104.54.32/tcp/9090/p2p/${RELAY_E_PEER}`],
  },
];

function targetString(target: unknown): string {
  return (target as { toString(): string }).toString();
}

describe('planLibp2pPeerConnectionAddresses', () => {
  it('replaces private-only resolver output with configured relay circuits', () => {
    expect(planLibp2pPeerConnectionAddresses(TARGET, [
      `/ip4/127.0.0.1/tcp/9090/p2p/${TARGET}`,
      `/ip4/192.168.0.20/tcp/9090/p2p/${TARGET}`,
      `/ip4/100.105.212.110/tcp/9090/p2p/${TARGET}`,
    ], [CONFIGURED_RELAYS[0]!])).toEqual([CIRCUIT_A]);
  });

  it('normalizes long trailing-slash runs on configured relay addresses', () => {
    expect(planLibp2pPeerConnectionAddresses(
      TARGET,
      [],
      [{
        peerId: RELAY_A.split('/').at(-1)!,
        addresses: [`${RELAY_A}${'/'.repeat(8_192)}`],
      }],
    )).toEqual([CIRCUIT_A]);
  });

  it('discards a long non-matching trailing-slash run without pathological matching', () => {
    expect(planLibp2pPeerConnectionAddresses(
      TARGET,
      [],
      [{
        peerId: RELAY_A.split('/').at(-1)!,
        addresses: [`${RELAY_A}${'/'.repeat(65_536)}x`],
      }],
    )).toEqual([]);
  });

  it('preserves configured relay order and caps fallback at four circuits', () => {
    const planned = planLibp2pPeerConnectionAddresses(
      TARGET,
      [`/ip4/192.168.0.20/tcp/9090/p2p/${TARGET}`],
      CONFIGURED_RELAYS,
    );
    const expected = CONFIGURED_RELAYS.slice(0, 4).map(
      ({ addresses }) => `${addresses[0]}/p2p-circuit/p2p/${TARGET}`,
    );

    expect(planned).toEqual(expected);
    expect(planned).not.toContain(
      `${CONFIGURED_RELAYS[4]!.addresses[0]}/p2p-circuit/p2p/${TARGET}`,
    );
  });

  it('treats the whole IPv6 fe80::/10 range as private', () => {
    expect(planLibp2pPeerConnectionAddresses(
      TARGET,
      [`/ip6/fe90::1/tcp/9090/p2p/${TARGET}`],
      [CONFIGURED_RELAYS[0]!],
    )).toEqual([CIRCUIT_A]);
  });

  it('suppresses configured fallbacks when a public direct route exists', () => {
    const publicDirect = `${TARGETLESS_DIRECT}/p2p/${TARGET}`;
    expect(planLibp2pPeerConnectionAddresses(
      TARGET,
      [publicDirect],
      CONFIGURED_RELAYS,
    )).toEqual([publicDirect]);
  });

  it('keeps an existing circuit before configured fallbacks', () => {
    expect(planLibp2pPeerConnectionAddresses(
      TARGET,
      [CIRCUIT_B],
      [CONFIGURED_RELAYS[0]!],
    )).toEqual([CIRCUIT_B, CIRCUIT_A]);
  });
});

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

  it('preserves a configured-relay failure when the identity fallback has no addresses', async () => {
    const relayFailure = new Error('configured relay unavailable');
    const noAddresses = Object.assign(new Error('no valid addresses'), {
      name: 'NoValidAddressesError',
    });
    const host = {
      getConnections: () => [],
      dial: vi.fn((target: unknown) => {
        const address = targetString(target);
        return Promise.reject(address === TARGET ? noAddresses : relayFailure);
      }),
      peerStore: { merge: vi.fn(async () => undefined) },
    };

    await expect(connectLibp2pPeer(host, TARGET, [], {
      configuredRelayTargets: [CONFIGURED_RELAYS[0]!],
    })).rejects.toBe(relayFailure);
    expect(host.dial.mock.calls.map(([target]) => targetString(target)))
      .toEqual([RELAY_A, TARGET]);
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
