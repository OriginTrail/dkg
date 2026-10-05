import { describe, expect, it, vi } from 'vitest';
import {
  connectLibp2pPeer,
  parseLibp2pConnectCandidate,
  tryConnectLibp2pRecoveryStage,
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

describe('parseLibp2pConnectCandidate terminal peer policy', () => {
  it('accepts peer-bound private direct and circuit hints', () => {
    const direct = `/ip4/127.0.0.1/tcp/9090/p2p/${TARGET}`;
    expect(parseLibp2pConnectCandidate(direct, { requireTerminalTargetPeerId: true }))
      .toMatchObject({ kind: 'direct', address: direct, targetPeerId: TARGET });
    expect(parseLibp2pConnectCandidate(CIRCUIT_A, { requireTerminalTargetPeerId: true }))
      .toMatchObject({ kind: 'circuit', address: CIRCUIT_A, targetPeerId: TARGET });
  });

  it('rejects missing and nonterminal peer bindings for recovery hints', () => {
    const nonterminal = `/ip4/127.0.0.1/tcp/9090/p2p/${TARGET}/ws`;
    expect(() => parseLibp2pConnectCandidate(
      TARGETLESS_DIRECT, { requireTerminalTargetPeerId: true },
    )).toThrow('must end with a target peer id');
    expect(() => parseLibp2pConnectCandidate(
      nonterminal, { requireTerminalTargetPeerId: true },
    )).toThrow('must end with a target peer id');
    expect(parseLibp2pConnectCandidate(nonterminal).targetPeerId).toBe(TARGET);
  });
});

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

  it('does not repeat the cached identity dial after a recovery stage', async () => {
    const host = {
      getConnections: () => [],
      dial: vi.fn(async () => undefined),
      peerStore: { merge: vi.fn(async () => undefined) },
    };
    await expect(connectLibp2pPeer(host, TARGET, [], {
      skipIdentityFallback: true,
    })).rejects.toMatchObject({ code: 'PEER_CONNECTION_UNRESOLVED' });
    expect(host.dial).not.toHaveBeenCalled();
  });

  it('tries a fresh target-bound private route before configured relays', async () => {
    const privateRoute = `/ip4/192.168.1.20/tcp/9091/p2p/${TARGET}`;
    const calls: string[] = [];
    const host = {
      getConnections: () => calls.includes(privateRoute)
        ? [{ remotePeer: { toString: () => TARGET } }]
        : [],
      dial: vi.fn(async (target: unknown) => { calls.push(targetString(target)); }),
      peerStore: { merge: vi.fn(async () => undefined) },
    };

    await connectLibp2pPeer(host, TARGET, [privateRoute], {
      skipIdentityFallback: true,
      allowResolvedPrivateDirect: true,
      configuredRelayTargets: [CONFIGURED_RELAYS[0]!],
    });
    expect(calls).toEqual([privateRoute]);
  });

  it('keeps private eligibility separate from identity fallback control', async () => {
    const privateRoute = `/ip4/192.168.1.20/tcp/9091/p2p/${TARGET}`;
    const host = {
      getConnections: () => [],
      dial: vi.fn(async () => undefined),
      peerStore: { merge: vi.fn(async () => undefined) },
    };
    await expect(connectLibp2pPeer(host, TARGET, [privateRoute], {
      skipIdentityFallback: true,
    })).rejects.toMatchObject({ code: 'PEER_CONNECTION_UNRESOLVED' });
    expect(host.dial).not.toHaveBeenCalled();

    await expect(connectLibp2pPeer(host, TARGET, [privateRoute], {
      allowResolvedPrivateDirect: true,
      candidateTimeoutMs: 1,
    })).resolves.toBeUndefined();
    expect(host.dial.mock.calls.map(([target]) => targetString(target)))
      .toEqual([privateRoute, TARGET]);
  });

  it('does not retry identity for a targetless, wrong-peer, or nonterminal private route', async () => {
    const host = {
      getConnections: () => [],
      dial: vi.fn(async () => undefined),
      peerStore: { merge: vi.fn(async () => undefined) },
    };
    for (const route of [
      '/ip4/192.168.1.20/tcp/9091',
      `/ip4/192.168.1.20/tcp/9091/p2p/${WRONG_TARGET}`,
      `/ip4/192.168.1.20/tcp/9091/p2p/${TARGET}/ws`,
      `/ip4/0.0.0.0/tcp/9091/p2p/${TARGET}`,
      `/ip6/::/tcp/9091/p2p/${TARGET}`,
    ]) {
      await expect(connectLibp2pPeer(host, TARGET, [route], {
        skipIdentityFallback: true,
        allowResolvedPrivateDirect: true,
      })).rejects.toMatchObject({ code: 'PEER_CONNECTION_UNRESOLVED' });
    }
    expect(host.dial).not.toHaveBeenCalled();
  });
});

describe('tryConnectLibp2pRecoveryStage', () => {
  it('bounds a stalled cached-peer dial by the stage deadline', async () => {
    vi.useFakeTimers();
    try {
      const host = {
        getConnections: () => [],
        dial: vi.fn((_target: unknown, options?: { signal?: AbortSignal }) => new Promise<never>(
          (_resolve, reject) => {
            const abort = () => reject(options!.signal!.reason);
            if (options!.signal!.aborted) abort();
            else options!.signal!.addEventListener('abort', abort, { once: true });
          },
        )),
        peerStore: { merge: vi.fn(async () => undefined) },
      };
      const pending = tryConnectLibp2pRecoveryStage(host, TARGET, {
        kind: 'cached', timeoutMs: 5_000,
      });
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });
      const rejection = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(host.dial).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the caller abort link after cached dial success and failure', async () => {
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    let connected = false;
    const host = {
      getConnections: () => connected ? [{ remotePeer: { toString: () => TARGET } }] : [],
      dial: vi.fn(async () => { connected = true; }),
      peerStore: { merge: vi.fn(async () => undefined) },
    };
    await expect(tryConnectLibp2pRecoveryStage(host, TARGET, {
      kind: 'cached', timeoutMs: 5_000, signal: caller.signal,
    })).resolves.toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));

    connected = false;
    remove.mockClear();
    host.dial.mockImplementation(async () => { throw new Error('dial failed'); });
    await expect(tryConnectLibp2pRecoveryStage(host, TARGET, {
      kind: 'cached', timeoutMs: 5_000, signal: caller.signal,
    })).rejects.toThrow('dial failed');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('uses a peer-bound private hint without a cached fallback', async () => {
    const hint = `/ip4/127.0.0.1/tcp/9090/p2p/${TARGET}`;
    let connected = false;
    const host = {
      getConnections: () => connected ? [{ remotePeer: { toString: () => TARGET } }] : [],
      dial: vi.fn(async (target: unknown) => {
        expect(targetString(target)).toBe(hint);
        connected = true;
      }),
      peerStore: { merge: vi.fn(async () => undefined) },
    };

    await expect(tryConnectLibp2pRecoveryStage(host, TARGET, {
      kind: 'hint', address: hint, timeoutMs: 5_000,
    })).resolves.toBe(true);
    expect(host.dial).toHaveBeenCalledOnce();
  });

  it('preconnects a relay for a peer-bound circuit hint', async () => {
    let connected = false;
    const dialed: string[] = [];
    const host = {
      getConnections: () => connected ? [{ remotePeer: { toString: () => TARGET } }] : [],
      dial: vi.fn(async (target: unknown) => {
        dialed.push(targetString(target));
        if (targetString(target) === CIRCUIT_A) connected = true;
      }),
      peerStore: { merge: vi.fn(async () => undefined) },
    };
    await expect(tryConnectLibp2pRecoveryStage(host, TARGET, {
      kind: 'hint', address: CIRCUIT_A, timeoutMs: 5_000,
    })).resolves.toBe(true);
    expect(dialed).toEqual([RELAY_A, CIRCUIT_A]);
    expect(host.peerStore.merge).toHaveBeenCalledOnce();
  });

  it('rejects a wrong-target hint without dialing', async () => {
    const host = {
      getConnections: () => [],
      dial: vi.fn(async () => undefined),
      peerStore: { merge: vi.fn(async () => undefined) },
    };
    await expect(tryConnectLibp2pRecoveryStage(host, TARGET, {
      kind: 'hint', address: `/ip4/127.0.0.1/tcp/9090/p2p/${WRONG_TARGET}`,
      timeoutMs: 5_000,
    })).resolves.toBe(false);
    expect(host.dial).not.toHaveBeenCalled();
  });

  it('rejects a nonterminal hint before transport dialing', async () => {
    const host = {
      getConnections: () => [],
      dial: vi.fn(async () => undefined),
      peerStore: { merge: vi.fn(async () => undefined) },
    };
    await expect(tryConnectLibp2pRecoveryStage(host, TARGET, {
      kind: 'hint', address: `${CIRCUIT_A}/ws`, timeoutMs: 5_000,
    })).rejects.toThrow('must end with a target peer id');
    expect(host.dial).not.toHaveBeenCalled();
  });

  it('uses the cached peer ID and requires observing the expected connection', async () => {
    let connected = false;
    const host = {
      getConnections: () => connected ? [{ remotePeer: { toString: () => TARGET } }] : [],
      dial: vi.fn(async (target: unknown) => {
        expect(targetString(target)).toBe(TARGET);
        connected = true;
      }),
      peerStore: { merge: vi.fn(async () => undefined) },
    };
    await expect(tryConnectLibp2pRecoveryStage(host, TARGET, {
      kind: 'cached', timeoutMs: 5_000,
    })).resolves.toBe(true);
    expect(host.dial).toHaveBeenCalledOnce();
  });

  it('rejects an already-aborted caller even if the peer is connected', async () => {
    const controller = new AbortController();
    controller.abort();
    const host = {
      getConnections: () => [{ remotePeer: { toString: () => TARGET } }],
      dial: vi.fn(async () => undefined),
      peerStore: { merge: vi.fn(async () => undefined) },
    };
    await expect(tryConnectLibp2pRecoveryStage(host, TARGET, {
      kind: 'cached', timeoutMs: 5_000, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(host.dial).not.toHaveBeenCalled();
  });

  it('cancels an in-flight cached dial when its caller aborts', async () => {
    const controller = new AbortController();
    let started: () => void = () => undefined;
    const dialStarted = new Promise<void>((resolve) => { started = resolve; });
    const host = {
      getConnections: () => [],
      dial: vi.fn((_target: unknown, options?: { signal?: AbortSignal }) => {
        started();
        return new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new DOMException('Aborted', 'AbortError'));
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener('abort', abort, { once: true });
        });
      }),
      peerStore: { merge: vi.fn(async () => undefined) },
    };
    const pending = tryConnectLibp2pRecoveryStage(host, TARGET, {
      kind: 'cached', timeoutMs: 5_000, signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await dialStarted;
    controller.abort();
    await rejection;
  });

  it('does not accept a late cached-dial success after the caller aborts', async () => {
    const controller = new AbortController();
    let connected = false;
    const host = {
      getConnections: () => connected ? [{ remotePeer: { toString: () => TARGET } }] : [],
      dial: vi.fn(async () => {
        connected = true;
        controller.abort(new DOMException('Cancelled by caller', 'AbortError'));
      }),
      peerStore: { merge: vi.fn(async () => undefined) },
    };
    await expect(tryConnectLibp2pRecoveryStage(host, TARGET, {
      kind: 'cached', timeoutMs: 5_000, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
