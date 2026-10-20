import { getEventListeners } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { PublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { AgentWorkLifetime } from '../src/agent-work-lifetime.js';
import { PublicSnapshotMethods } from '../src/dkg-agent-public-snapshot.js';
import { PUBLIC_GRAPH_SNAPSHOT_PROTOCOL } from '../src/public-snapshot-reader.js';
import { PUBLIC_SNAPSHOT_SOURCE_PROTOCOL } from '../src/public-snapshot-source-proof.js';
import { CORE_CHAIN_CACHE_SOURCE_PROTOCOL, CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL } from '../src/core-chain-cache-config.js';

const scope = { chainId: 'base:8453', deploymentId: 'base:8453:hub=test' };
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
type Handler = (bytes: Uint8Array, remote: { toString(): string }) => Promise<Uint8Array>;
const signature = { r: ethers.getBytes('0x' + '1'.repeat(64)), vs: ethers.getBytes('0x' + '2'.repeat(64)) };
afterEach(() => vi.useRealTimers());

function fixture(cacheEnabled = true) {
  const handlers = new Map<string, Handler>();
  const workLifetime = new AgentWorkLifetime();
  const read = vi.fn(async (_graph: string, _id: string, _options: { signal: AbortSignal }) =>
    ({ observedAt: Date.now(), expiresAt: Date.now() + 120_000 }) as PublicGraphSnapshot);
  const legacyRead = vi.fn((graph: string, id: string, options: { signal: AbortSignal }) => read(graph, id, options));
  const sign = vi.fn(async (_bytes: Uint8Array, _options: { signal: AbortSignal }) => signature);
  const agent = { chain: { ...scope, readPublicGraphSnapshot: legacyRead, getIdentityId: async () => 7n, signMessage: sign },
    config: { nodeRole: 'core', coreChainCacheNetworks: cacheEnabled ? [{
      registry: { ...scope, readPublicGraphSnapshot: read }, relays: [], identity: { chainId: scope.chainId },
    }] : [] }, peerId: 'core', workLifetime,
    subscribedContextGraphs: new Map(['one', 'two', 'three', 'four'].map(g => [g, { coreHosted: true, onChainId: '1' }])),
    contextGraphBindingState: { capture: () => 0, isGenerationCurrent: () => true }, isPrivateContextGraph: async () => false,
    router: { register: (p: string, h: Handler) => { handlers.set(p, h); } },
  };
  // Both real protocol families are registered by the production lifecycle.
  PublicSnapshotMethods.prototype.startPublicGraphSnapshots.call(agent as never);
  const send = async (protocol: string, value: unknown, peer: string) => JSON.parse(new TextDecoder().decode(
    await handlers.get(protocol)!(encode(value), { toString: () => peer })));
  const proof = (protocol: string, peer: string) => send(protocol, { version: 1, ...scope,
    contextGraphId: 'one', onChainId: '1', nonce: 'a'.repeat(64), requesterPeerId: peer, responderPeerId: 'core' }, peer);
  const snapshot = (protocol: string, graph: string, peer: string) => send(protocol, { version: 1,
    ...(protocol === CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL ? scope : {}), contextGraphId: graph, onChainId: '1', refresh: false }, peer);
  return { workLifetime, read, legacyRead, sign, proof, snapshot };
}

it.each([true, false])('preserves ordinary-handler backend selection with chain cache enabled=%s', async enabled => {
  const f = fixture(enabled);
  expect(await f.snapshot(PUBLIC_GRAPH_SNAPSHOT_PROTOCOL, 'one', 'legacy-edge')).toHaveProperty('observedAt');
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.legacyRead).toHaveBeenCalledTimes(enabled ? 0 : 1);
  await f.workLifetime.drain();
});

it('shares the four proof slots across registered legacy/cache handlers until physical signing settles', async () => {
  vi.useFakeTimers();
  const f = fixture(), releases: Array<() => void> = [], signals: AbortSignal[] = [];
  f.sign.mockImplementation((_bytes, { signal }) => { signals.push(signal); return new Promise(resolve => releases.push(() => resolve(signature))); });
  const calls = [PUBLIC_SNAPSHOT_SOURCE_PROTOCOL, CORE_CHAIN_CACHE_SOURCE_PROTOCOL,
    PUBLIC_SNAPSHOT_SOURCE_PROTOCOL, CORE_CHAIN_CACHE_SOURCE_PROTOCOL].map((p, i) => f.proof(p, `p${i}`));
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(releases).toHaveLength(4);
    for (const protocol of [PUBLIC_SNAPSHOT_SOURCE_PROTOCOL, CORE_CHAIN_CACHE_SOURCE_PROTOCOL]) {
      const overflow = f.proof(protocol, 'overflow'); calls.push(overflow);
      await vi.advanceTimersByTimeAsync(0);
      expect(releases).toHaveLength(4);
      expect(await overflow).toEqual({ unavailable: true });
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signals.every(s => s.aborted)).toBe(true);
    expect(f.workLifetime.physicalRuns.size).toBe(4);
    expect(await f.proof(CORE_CHAIN_CACHE_SOURCE_PROTOCOL, 'after-deadline')).toEqual({ unavailable: true });
    releases.forEach(release => release());
    expect(await Promise.all(calls)).toEqual(Array(calls.length).fill({ unavailable: true }));
    await f.workLifetime.drain();
    f.sign.mockResolvedValue(signature);
    expect(await f.proof(PUBLIC_SNAPSHOT_SOURCE_PROTOCOL, 'new-legacy')).toHaveProperty('signature');
    expect(await f.proof(CORE_CHAIN_CACHE_SOURCE_PROTOCOL, 'new-cache')).toHaveProperty('signature');
    expect(f.workLifetime.physicalRuns.size).toBe(0);
    expect(getEventListeners(f.workLifetime.signal, 'abort')).toHaveLength(0);
    // The shared request lifecycle intentionally retains the original deadline after release.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
  } finally { releases.forEach(release => release()); await Promise.all(calls); await f.workLifetime.drain(); }
});

it('shares the two builders across registered legacy/cache handlers through timeout and shutdown drain', async () => {
  vi.useFakeTimers();
  const f = fixture(), releases: Array<() => void> = [], signals: AbortSignal[] = [];
  f.read.mockImplementation((_graph, _id, { signal }) => { signals.push(signal); return new Promise(resolve => releases.push(() => resolve({
    observedAt: Date.now(), expiresAt: Date.now() + 120_000,
  } as PublicGraphSnapshot))); });
  const calls = [f.snapshot(PUBLIC_GRAPH_SNAPSHOT_PROTOCOL, 'one', 'a'), f.snapshot(CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL, 'two', 'b')];
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(releases).toHaveLength(2);
    for (const protocol of [PUBLIC_GRAPH_SNAPSHOT_PROTOCOL, CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL]) {
      const overflow = f.snapshot(protocol, 'three', 'overflow'); calls.push(overflow);
      await vi.advanceTimersByTimeAsync(0);
      expect(releases).toHaveLength(2);
      expect(await overflow).toEqual({ unavailable: true });
    }
    await vi.advanceTimersByTimeAsync(110_000);
    expect(signals.every(s => s.aborted)).toBe(true);
    expect(await f.snapshot(CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL, 'four', 'after-deadline')).toEqual({ unavailable: true });
    f.workLifetime.close();
    let drained = false;
    const drain = f.workLifetime.drain().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(0); expect(drained).toBe(false);
    releases.forEach(release => release());
    expect(await Promise.all(calls)).toEqual(Array(calls.length).fill({ unavailable: true }));
    await drain; expect(drained).toBe(true); expect(vi.getTimerCount()).toBe(0);
  } finally { releases.forEach(release => release()); await Promise.all(calls); await f.workLifetime.drain(); }
});
