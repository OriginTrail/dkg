import { expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import type { ChainAdapter, PublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { AgentWorkLifetime } from '../src/agent-work-lifetime.js';
import { registerCoreChainCacheHandlers } from '../src/core-chain-cache-handler.js';
import { CORE_CHAIN_CACHE_SOURCE_PROTOCOL as source, CORE_CHAIN_CACHE_SNAPSHOT_PROTOCOL as snapshot,
  snapshotCoreChainCacheNetworks, type CoreChainCacheNetwork } from '../src/core-chain-cache-config.js';

const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const decode = (v: Uint8Array) => JSON.parse(new TextDecoder().decode(v));
const scope = { chainId: 'base:1', deploymentId: 'base:1:hub=test' };
const identity = { chainId: scope.chainId, networkId: 'mainnet-a', genesisId: 'a' };
const request = { version: 1, ...scope, contextGraphId: 'public', onChainId: '1', refresh: false };
type Handler = (bytes: Uint8Array, remote: { toString(): string }) => Promise<Uint8Array>;
function fixture(read: (...args: any[]) => Promise<PublicGraphSnapshot>) {
  const workLifetime = new AgentWorkLifetime();
  const handlers = new Map<string, Handler>();
  const limits = new Map<string, number>();
  const networks: CoreChainCacheNetwork[] = [{ identity, relays: [], registry: { ...scope,
    readPublicGraphSnapshot: read, verifyACKIdentity: async () => true, rpcUsage: () => ({}), destroy() {} } }];
  const chain = { ...scope, getIdentityId: async () => 7n, signMessage: vi.fn() } as unknown as ChainAdapter;
  const agent = { nodeRole: 'core', chain, peerId: 'core', workLifetime, networks,
    router: { register: (p: string, h: Handler, o: { maxReadBytes: number }) => { handlers.set(p, h); limits.set(p, o.maxReadBytes); } } };
  const serving = registerCoreChainCacheHandlers(agent as never)!;
  const send = async (protocol: string, value: unknown, peer = 'edge') => decode(await handlers.get(protocol)!(encode(value), { toString: () => peer }));
  return { agent, handlers, limits, send, workLifetime, networks, serving };
}

it('refuses unconfigured scopes and private inventory without leaking chain errors', async () => {
  const read = vi.fn(async () => { throw new Error('private graph details'); });
  const f = fixture(read);
  for (const patch of [{ deploymentId: 'unknown' }, { chainId: 'other' }, { version: 2 }, { extra: true }])
    expect(await f.send(snapshot, { ...request, ...patch })).toEqual({ unavailable: true });
  expect(read).not.toHaveBeenCalled();
  expect(await f.send(snapshot, request)).toEqual({ unavailable: true });
  expect(read).toHaveBeenCalledWith('public', '1', { signal: expect.any(AbortSignal) });
  expect(f.limits.get(snapshot)).toBe(1024);
  expect(f.limits.get(source)).toBe(2048);
  f.agent.nodeRole = 'edge'; f.handlers.clear(); registerCoreChainCacheHandlers(f.agent as never);
  expect(f.handlers.size).toBe(0);
});

it('retains the shared two-build limit and physical ownership after cancellation across graph scopes', async () => {
  const release: Array<() => void> = [];
  const signals: AbortSignal[] = [];
  const f = fixture((_graph, _id, options) => {
    signals.push(options.signal);
    return new Promise(resolve => release.push(() => resolve({ observedAt: Date.now(), expiresAt: Date.now() + 1000 } as PublicGraphSnapshot)));
  });
  const a = f.send(snapshot, request, 'a');
  const b = f.send(snapshot, { ...request, contextGraphId: 'second' }, 'b');
  expect(await f.send(snapshot, { ...request, contextGraphId: 'third' }, 'c')).toEqual({ unavailable: true });
  // Legacy requests use this same runtime; neither protocol gets extra builder slots.
  await expect(f.serving.runtime.get('legacy', { deploymentId: scope.deploymentId, contextGraphId: 'legacy', onChainId: '1' })).rejects.toThrow('busy');
  expect(signals).toHaveLength(2);
  f.workLifetime.close();
  expect(signals.every(s => s.aborted)).toBe(true);
  expect(f.workLifetime.physicalRuns.size).toBe(2);
  release.forEach(r => r());
  expect(await Promise.all([a, b])).toEqual([{ unavailable: true }, { unavailable: true }]);
  await f.workLifetime.drain();
  expect(f.workLifetime.physicalRuns.size).toBe(0);
});

it('shares proof admission between legacy and cache protocols', () => {
  const f = fixture(async () => { throw new Error('unused'); });
  const releases = ['one', 'two', 'three', 'four'].map(p => f.serving.sourceAdmission.acquire(p));
  expect(() => f.serving.sourceAdmission.acquire('fifth')).toThrow('busy');
  releases[0](); releases[0]();
  const fifth = f.serving.sourceAdmission.acquire('one');
  releases[0](); // A stale release cannot retire this peer's newer lease.
  expect(() => f.serving.sourceAdmission.acquire('sixth')).toThrow('busy');
  fifth(); releases.slice(1).forEach(r => r());
});

it('keeps proof signing owned through the unchanged ten-second deadline', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(async () => { throw new Error('unused'); });
    let finish!: () => void;
    const sign = vi.spyOn(f.agent.chain, 'signMessage').mockImplementation(async () => new Promise(resolve => {
      finish = () => resolve({ r: ethers.getBytes('0x' + '1'.repeat(64)), vs: ethers.getBytes('0x' + '2'.repeat(64)) });
    }));
    const pending = f.send(source, { version: 1, ...scope, contextGraphId: 'public', onChainId: '1',
      nonce: 'a'.repeat(64), requesterPeerId: 'edge', responderPeerId: 'core' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sign).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.workLifetime.physicalRuns.size).toBe(1);
    finish();
    expect(await pending).toEqual({ unavailable: true });
    await f.workLifetime.drain();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('captures trust configuration so later input mutations cannot widen a running node', () => {
  const f = fixture(async () => { throw new Error('unused'); });
  const captured = snapshotCoreChainCacheNetworks(true, f.networks, identity, scope.deploymentId);
  f.networks.push({ ...f.networks[0], registry: { ...f.networks[0].registry, deploymentId: 'attacker' } });
  expect(captured).toHaveLength(1);
  expect(Object.isFrozen(captured[0].registry)).toBe(true);
  expect(Object.isFrozen(captured[0].identity)).toBe(true);
  expect(() => snapshotCoreChainCacheNetworks(true, f.networks, { ...identity, networkId: 'testnet' }, scope.deploymentId)).toThrow();
});
