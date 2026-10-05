import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PeerResolver,
  StubNetworkStateRegistry,
  type NetworkStateRegistry,
} from '../src/network/index.js';
import {
  makeNetwork,
  makeAgentDir,
  PEER_B,
  TARGET_PEER_ID,
  type MockNetwork,
} from './peer-resolver-fixtures.js';

describe('PeerResolver recovery', () => {
  let net: MockNetwork;
  let registry: NetworkStateRegistry;

  beforeEach(() => {
    net = makeNetwork();
    registry = new StubNetworkStateRegistry();
  });

  it('recovery tries hint, cached peer, then resolver without a second identity fallback', async () => {
    const stages: string[] = [];
    const forwardedHints: string[] = [];
    const hint = `/ip4/127.0.0.1/tcp/9090/p2p/${TARGET_PEER_ID}`;
    net.tryConnectRecoveryStage = async (_peerId, stage) => {
      stages.push(stage.kind);
      if (stage.kind === 'hint') forwardedHints.push(stage.address);
      return false;
    };
    net.__findPeerImpl = async () => {
      stages.push('resolve');
      return ['/ip4/178.104.54.178/tcp/9090'];
    };
    net.connectPeer = async (peerId, addresses, options) => {
      stages.push('connect');
      expect(options?.skipIdentityFallback).toBe(true);
      expect(options?.allowResolvedPrivateDirect).toBe(true);
      expect(addresses).toEqual(['/ip4/178.104.54.178/tcp/9090']);
      net.__conns.set(peerId, [{ remoteAddr: { toString: () => addresses[0]! } }]);
    };
    const resolver = new PeerResolver({ network: net, registry, agentDirectory: makeAgentDir() });

    await expect(resolver.connect(TARGET_PEER_ID, {
      recovery: { verifiedInitialAddress: hint },
    })).resolves.toMatchObject({ status: 'connected' });
    expect(forwardedHints).toEqual([hint]);
    expect(stages).toEqual(['hint', 'cached', 'resolve', 'connect']);
  });

  it('primes a newly discovered private listener after the cached stage failed', async () => {
    const privateRoute = `/ip4/192.168.1.20/tcp/9091/p2p/${TARGET_PEER_ID}`;
    const stages: string[] = [];
    net.tryConnectRecoveryStage = async (_peerId, stage) => {
      stages.push(stage.kind);
      return false;
    };
    net.__findPeerImpl = async () => {
      stages.push('resolve');
      return [privateRoute];
    };
    net.connectPeer = async (peerId, addresses, options) => {
      stages.push('connect');
      expect(options?.skipIdentityFallback).toBe(true);
      expect(options?.allowResolvedPrivateDirect).toBe(true);
      expect(addresses).toEqual([privateRoute]);
      expect(net.__addedAddresses).toContainEqual({ peerId, addrs: [privateRoute] });
      net.__conns.set(peerId, [{ remoteAddr: { toString: () => privateRoute } }]);
    };
    const resolver = new PeerResolver({ network: net, registry, agentDirectory: makeAgentDir() });

    await expect(resolver.connect(TARGET_PEER_ID, { recovery: {} }))
      .resolves.toEqual({ status: 'connected', resolvedAddresses: [privateRoute] });
    expect(stages).toEqual(['cached', 'resolve', 'connect']);
  });

  it('reuses an observed connection before any recovery stage', async () => {
    net.__conns.set(PEER_B, [{ remoteAddr: { toString: () => '/ip4/178.104.54.178/tcp/9090' } }]);
    const stages: string[] = [];
    net.tryConnectRecoveryStage = async () => { stages.push('stage'); return false; };
    const resolver = new PeerResolver({ network: net, registry, agentDirectory: makeAgentDir() });
    await expect(resolver.connect(PEER_B, { recovery: {} })).resolves.toEqual({
      status: 'connected', resolvedAddresses: [],
    });
    expect(stages).toEqual([]);
    expect(net.__connectCalls).toEqual([]);
  });

  it.each(['hint', 'cached'] as const)('finishes after an observed %s recovery stage', async (winner) => {
    const stages: string[] = [];
    net.tryConnectRecoveryStage = async (peerId, stage) => {
      stages.push(stage.kind);
      if (stage.kind !== winner) return false;
      net.__conns.set(peerId, [{ remoteAddr: { toString: () => '/ip4/178.104.54.178/tcp/9090' } }]);
      return true;
    };
    const resolver = new PeerResolver({ network: net, registry, agentDirectory: makeAgentDir() });
    await expect(resolver.connect(PEER_B, {
      recovery: { verifiedInitialAddress: '/ip4/178.104.54.178/tcp/9090' },
    })).resolves.toEqual({ status: 'connected', resolvedAddresses: [] });
    expect(stages).toEqual(winner === 'hint' ? ['hint'] : ['hint', 'cached']);
    expect(net.__connectCalls).toEqual([]);
  });

  it('continues to the cached stage after a stale hint throws', async () => {
    const stages: string[] = [];
    net.tryConnectRecoveryStage = async (peerId, stage) => {
      stages.push(stage.kind);
      if (stage.kind === 'hint') throw new Error('stale hint');
      net.__conns.set(peerId, [{ remoteAddr: { toString: () => '/ip4/178.104.54.178/tcp/9090' } }]);
      return true;
    };
    const resolver = new PeerResolver({ network: net, registry, agentDirectory: makeAgentDir() });
    await expect(resolver.connect(PEER_B, {
      recovery: { verifiedInitialAddress: '/ip4/178.104.54.178/tcp/9090' },
    })).resolves.toMatchObject({ status: 'connected' });
    expect(stages).toEqual(['hint', 'cached']);
  });

  it('does not accept a late recovery success after caller cancellation', async () => {
    const controller = new AbortController();
    net.tryConnectRecoveryStage = async (peerId) => {
      net.__conns.set(peerId, [{ remoteAddr: { toString: () => '/ip4/178.104.54.178/tcp/9090' } }]);
      controller.abort();
      return true;
    };
    const resolver = new PeerResolver({ network: net, registry, agentDirectory: makeAgentDir() });
    await expect(resolver.connect(PEER_B, {
      signal: controller.signal, recovery: { verifiedInitialAddress: '/ip4/178.104.54.178/tcp/9090' },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(net.__connectCalls).toEqual([]);
  });

  it('recovery returns only after the requested peer is observed', async () => {
    net.tryConnectRecoveryStage = async () => true;
    net.__findPeerImpl = async () => [];
    net.connectPeer = async () => undefined;
    const resolver = new PeerResolver({ network: net, registry, agentDirectory: makeAgentDir() });

    await expect(resolver.connect(PEER_B, { recovery: {} })).resolves.toEqual({
      status: 'unresolved', resolvedAddresses: [],
    });
  });

  it('rejects a transport success without an observed target after resolution', async () => {
    const route = `/ip4/192.168.1.20/tcp/9091/p2p/${TARGET_PEER_ID}`;
    net.tryConnectRecoveryStage = async () => false;
    net.__findPeerImpl = async () => [route];
    net.connectPeer = async () => undefined;
    const resolver = new PeerResolver({ network: net, registry, agentDirectory: makeAgentDir() });

    await expect(resolver.connect(TARGET_PEER_ID, { recovery: {} }))
      .rejects.toMatchObject({ code: 'PEER_CONNECTION_UNRESOLVED' });
  });

  it('falls back to the unchanged canonical path when recovery capability is absent', async () => {
    net.__findPeerImpl = async () => [];
    net.connectPeer = async (peerId, addrs, opts) => {
      expect(opts?.skipIdentityFallback).toBeUndefined();
      expect(opts?.allowResolvedPrivateDirect).toBeUndefined();
      expect(opts?.signal).toBeInstanceOf(AbortSignal);
      net.__connectCalls.push({ peerId, addrs });
      net.__conns.set(peerId, [{ remoteAddr: { toString: () => '/ip4/178.104.54.178/tcp/9090' } }]);
    };
    const resolver = new PeerResolver({ network: net, registry, agentDirectory: makeAgentDir() });

    await expect(resolver.connect(PEER_B, {
      recovery: { verifiedInitialAddress: '/ip4/127.0.0.1/tcp/9090' },
    })).resolves.toEqual({ status: 'connected', resolvedAddresses: [] });
    expect(net.__connectCalls).toEqual([{ peerId: PEER_B, addrs: [] }]);
  });

  it('bounds both resolution and the final dial with the recovery resolver deadline', async () => {
    vi.useFakeTimers();
    try {
      net.tryConnectRecoveryStage = async () => false;
      net.__findPeerImpl = async () => ['/ip4/178.104.54.178/tcp/9090'];
      let dialStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { dialStarted = resolve; });
      net.connectPeer = async (_peerId, _addresses, options) => {
        dialStarted();
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(options!.signal!.reason);
          if (options!.signal!.aborted) abort();
          else options!.signal!.addEventListener('abort', abort, { once: true });
        });
      };
      const resolver = new PeerResolver({ network: net, registry, agentDirectory: makeAgentDir() });
      const pending = resolver.connect(PEER_B, { recovery: { resolverTimeoutMs: 15_000 } });
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });
      const rejection = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
      await started;
      await vi.advanceTimersByTimeAsync(14_999);
      expect(net.__conns.get(PEER_B)).toBeUndefined();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses one recovery deadline across slow resolution and a stalled dial', async () => {
    vi.useFakeTimers();
    try {
      net.tryConnectRecoveryStage = async () => false;
      net.__findPeerImpl = async () => [];
      registry = {
        lookup: () => new Promise((resolve) => {
          setTimeout(() => resolve(['/ip4/178.104.54.178/tcp/9090']), 10_000);
        }),
      };
      let dialStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { dialStarted = resolve; });
      net.connectPeer = async (_peerId, _addresses, options) => {
        dialStarted();
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(options!.signal!.reason);
          if (options!.signal!.aborted) abort();
          else options!.signal!.addEventListener('abort', abort, { once: true });
        });
      };
      const resolver = new PeerResolver({ network: net, registry, agentDirectory: makeAgentDir() });
      const pending = resolver.connect(PEER_B, { recovery: { resolverTimeoutMs: 15_000 } });
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });
      const rejection = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(net.__connectCalls).toEqual([]);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await started;
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the recovery deadline when the transport has no fast-path capability', async () => {
    vi.useFakeTimers();
    try {
      net.__findPeerImpl = async (_peerId, options) => new Promise((_resolve, reject) => {
        const abort = () => reject(options!.signal!.reason);
        if (options!.signal!.aborted) abort();
        else options!.signal!.addEventListener('abort', abort, { once: true });
      });
      const resolver = new PeerResolver({ network: net, registry, agentDirectory: makeAgentDir() });
      const pending = resolver.connect(PEER_B, {
        recovery: { resolverTimeoutMs: 100 },
      });
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });
      const rejection = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(settled).toBe(true);
      expect(net.__connectCalls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the caller abort link after recovery success and failure', async () => {
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    net.tryConnectRecoveryStage = async () => false;
    net.__findPeerImpl = async () => [];
    net.connectPeer = async (peerId) => {
      net.__conns.set(peerId, [{ remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/9090' } }]);
    };
    const resolver = new PeerResolver({ network: net, registry, agentDirectory: makeAgentDir() });
    await expect(resolver.connect(PEER_B, { signal: caller.signal, recovery: {} }))
      .resolves.toMatchObject({ status: 'connected' });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));

    net.__conns.clear();
    remove.mockClear();
    net.connectPeer = async () => { throw new Error('dial failed'); };
    await expect(resolver.connect(PEER_B, { signal: caller.signal, recovery: {} }))
      .rejects.toThrow('dial failed');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

});
