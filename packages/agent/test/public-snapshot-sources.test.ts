import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import { PublicSnapshotMethods } from '../src/dkg-agent-public-snapshot.js';
import { MockChainAdapter, sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import { AgentWorkLifetime } from '../src/agent-work-lifetime.js';
import { registerSnapshotSourceHandler } from '../src/public-snapshot-source-handler.js';
import { selectSnapshotSources } from '../src/public-snapshot-sources.js';
import { normalizePublicSnapshotSyncOptions } from '../src/public-snapshot-options.js';
import {
  BASE_MAINNET_SOURCE_POLICY, PUBLIC_SNAPSHOT_SOURCE_PROTOCOL,
  decodeSourceChallenge, sourceProofPayload, verifySourceProof, type SnapshotSourceChallenge,
} from '../src/public-snapshot-source-proof.js';

const deploymentId = `base:8453:hub=0x${'1'.repeat(40)}`;
const scope = { contextGraphId: 'public-threat-graph', onChainId: '14' };
const challenge: SnapshotSourceChallenge = {
  version: 1, nonce: 'a'.repeat(64), requesterPeerId: 'requester', responderPeerId: 'core',
  chainId: 'base:8453', deploymentId, ...scope,
};
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const signal = () => new AbortController().signal;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function fixture() {
  const wallet = ethers.Wallet.createRandom();
  let hosted = true, privateGraph = false;
  let handler!: (data: Uint8Array, peer: { toString(): string }) => Promise<Uint8Array>;
  const lifetime = new AgentWorkLifetime();
  const chain = {
    chainId: 'base:8453', deploymentId, getIdentityId: async () => 7n,
    signMessage: vi.fn(async (bytes: Uint8Array) => {
      const signature = ethers.Signature.from(await wallet.signMessage(bytes));
      return { r: ethers.getBytes(signature.r), vs: ethers.getBytes(signature.yParityAndS) };
    }),
    verifyACKIdentity: vi.fn(async (address: string, id: bigint) => address === wallet.address && id === 7n),
  };
  const register = vi.fn((_protocol, fn) => { handler = fn; });
  registerSnapshotSourceHandler({
    nodeRole: 'core', chain, peerId: 'core', workLifetime: lifetime, router: { register },
    captureHosted: () => () => { if (!hosted) throw new Error('inactive'); },
    isPrivateContextGraph: async () => privateGraph,
  });
  return { wallet, chain, register, handler, lifetime,
    unhost: () => { hosted = false; }, makePrivate: () => { privateGraph = true; } };
}

describe('registered Base mainnet snapshot sources', () => {
  it('authenticates a real signed challenge then pins only registered reachable sources', async () => {
    const f = await fixture();
    const calls: string[] = [];
    const peers = await selectSnapshotSources({
      selfPeerId: 'requester', chain: f.chain, candidates: async () => ['requester', 'core', 'forged', 'core'],
      connect: async peer => { calls.push(peer); },
      send: async (peer, protocol, data) => {
        expect(protocol).toBe(PUBLIC_SNAPSHOT_SOURCE_PROTOCOL);
        return peer === 'core' ? f.handler(data, { toString: () => 'requester' }) : encode({ identityId: '7', signature: 'fake' });
      },
    }, scope, signal());
    expect(peers).toEqual(['core']);
    expect(Object.isFrozen(peers)).toBe(true);
    expect(calls.sort()).toEqual(['core', 'forged']);
    expect(f.chain.verifyACKIdentity).toHaveBeenCalledWith(f.wallet.address, 7n, { signal: expect.any(AbortSignal) });
  });

  it('rejects replay across nonce, graph, caller, responder and deployment', async () => {
    const f = await fixture();
    const proof = await f.handler(encode(challenge), { toString: () => 'requester' });
    expect(await verifySourceProof(proof, challenge, f.chain.verifyACKIdentity, signal())).toBe(true);
    for (const patch of [{ nonce: 'b'.repeat(64) }, { contextGraphId: 'different' }, { requesterPeerId: 'attacker' },
      { responderPeerId: 'attacker' }, { deploymentId: deploymentId + '2' }, { onChainId: '15' }]) {
      expect(await verifySourceProof(proof, { ...challenge, ...patch }, f.chain.verifyACKIdentity, signal())).toBe(false);
    }
  });

  it('fails closed for unregistered signers, absent verification and a different chain', async () => {
    const f = await fixture();
    const ports = { selfPeerId: 'requester', chain: f.chain, candidates: async () => ['core'],
      connect: vi.fn(async () => {}), send: async (_p: string, _protocol: string, data: Uint8Array) =>
        f.handler(data, { toString: () => 'requester' }) };
    f.chain.verifyACKIdentity.mockResolvedValue(false);
    await expect(selectSnapshotSources(ports, scope, signal())).rejects.toThrow('No registered');
    for (const chain of [{ ...f.chain, chainId: 'base:84532' }, { ...f.chain, verifyACKIdentity: undefined }]) {
      await expect(selectSnapshotSources({ ...ports, chain }, scope, signal())).rejects.toThrow('verification unavailable');
    }
    expect(ports.connect).toHaveBeenCalledTimes(1);
  });

  it.each(['unhost', 'makePrivate'] as const)('refuses %s without signing, and rejects relayed challenges', async mode => {
    const f = await fixture();
    expect(JSON.parse(new TextDecoder().decode(await f.handler(encode(challenge), { toString: () => 'attacker' }))))
      .toEqual({ unavailable: true });
    f[mode]();
    expect(JSON.parse(new TextDecoder().decode(await f.handler(encode(challenge), { toString: () => 'requester' }))))
      .toEqual({ unavailable: true });
    expect(f.chain.signMessage).not.toHaveBeenCalled();
  });

  it('bounds probes, concurrent work and selected sources while preserving cancellation', async () => {
    const wallet = ethers.Wallet.createRandom();
    let active = 0, peak = 0, calls = 0;
    const ports = {
      selfPeerId: 'requester', chain: { chainId: 'base:8453', deploymentId, verifyACKIdentity: async () => true },
      candidates: async () => Array.from({ length: 128 }, (_, i) => `peer-${i}`),
      connect: async () => {},
      send: async (_peer: string, _protocol: string, bytes: Uint8Array) => {
        calls++; active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 1));
        active--;
        const c = decodeSourceChallenge(bytes);
        return encode({ identityId: '7', signature: await wallet.signMessage(sourceProofPayload(c, '7')) });
      },
    };
    expect(await selectSnapshotSources(ports, scope, signal())).toHaveLength(4);
    expect(calls).toBe(4); expect(peak).toBeLessThanOrEqual(4);
    calls = 0;
    await expect(selectSnapshotSources({ ...ports, send: async () => { calls++; throw new Error('offline'); } },
      scope, signal())).rejects.toThrow('No registered');
    expect(calls).toBe(16);
    const abort = new AbortController(); abort.abort(new Error('stop'));
    await expect(selectSnapshotSources(ports, scope, abort.signal)).rejects.toThrow('stop');
    expect(calls).toBe(16);
  });

  it('requires either explicit peers or the policy and rejects mixed/unknown trust', () => {
    const input = { ...scope, trustedCorePeerIds: [], sourcePolicy: BASE_MAINNET_SOURCE_POLICY };
    expect(normalizePublicSnapshotSyncOptions(input)).toMatchObject(input);
    expect(() => normalizePublicSnapshotSyncOptions({ ...input, trustedCorePeerIds: ['core'] })).toThrow();
    expect(() => normalizePublicSnapshotSyncOptions({ ...input, sourcePolicy: 'advertised-cores' })).toThrow();
    expect(() => normalizePublicSnapshotSyncOptions({ ...scope, trustedCorePeerIds: [] })).toThrow();
  });
});

it.each(['connect', 'send', 'verify'] as const)('cancels active %s probes before another batch starts', async stage => {
  const f = await fixture(), parent = new AbortController();
  const probes: AbortSignal[] = [];
  const held = (probe: AbortSignal) => new Promise<void>((_resolve, reject) => {
    probes.push(probe);
    probe.addEventListener('abort', () => reject(probe.reason), { once: true });
  });
  const connect = vi.fn(async (_peer: string, probe: AbortSignal) => { if (stage === 'connect') await held(probe); });
  const send = vi.fn(async (_peer: string, _protocol: string, bytes: Uint8Array, options?: { signal?: AbortSignal }) => {
    if (stage === 'send') await held(options!.signal!);
    return encode({ identityId: '7', signature: await f.wallet.signMessage(sourceProofPayload(decodeSourceChallenge(bytes), '7')) });
  });
  const verify = vi.fn(async (_address: string, _id: bigint, options?: { signal?: AbortSignal }) => {
    if (stage === 'verify') await held(options!.signal!);
    return true;
  });
  const job = selectSnapshotSources({ selfPeerId: 'requester', chain: { ...f.chain, verifyACKIdentity: verify },
    candidates: async () => Array.from({ length: 12 }, (_, i) => `peer-${i}`), connect, send }, scope, parent.signal);
  let settled = false;
  const outcome = job.catch(error => error).finally(() => { settled = true; });
  try {
    await vi.waitFor(() => expect(probes).toHaveLength(4));
    parent.abort(new Error('stop probes'));
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(await outcome).toMatchObject({ message: 'stop probes' });
    expect(connect).toHaveBeenCalledTimes(4);
    expect(probes.every(probe => probe.aborted)).toBe(true);
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
  } finally { parent.abort(); await outcome; }
});

it.each(['connect', 'send', 'verify'] as const)('enforces the ten-second %s probe deadline', async stage => {
  const f = await fixture();
  vi.useFakeTimers();
  let probe!: AbortSignal;
  const hold = async (signal: AbortSignal) => {
    probe = signal;
    await new Promise<void>((_resolve, reject) => probe.addEventListener('abort', () => reject(probe.reason), { once: true }));
  };
  const verify = vi.fn(async (_address: string, _id: bigint, options?: { signal?: AbortSignal }) => {
    if (stage === 'verify') await hold(options!.signal!);
    return true;
  });
  let settled = false;
  const outcome = selectSnapshotSources({ selfPeerId: 'requester', chain: { ...f.chain, verifyACKIdentity: verify },
    candidates: async () => ['core'], connect: async (_peer, signal) => { if (stage === 'connect') await hold(signal); },
    send: async (_peer, _protocol, bytes, options) => {
      if (stage === 'send') await hold(options!.signal!);
      return f.handler(bytes, { toString: () => 'requester' });
    },
  }, scope, signal()).catch(error => error).finally(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(probe).toBeInstanceOf(AbortSignal);
  await vi.advanceTimersByTimeAsync(9_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(probe.aborted).toBe(true);
  expect(await outcome).toMatchObject({ message: 'No registered Base mainnet core proved snapshot availability' });
  expect(vi.getTimerCount()).toBe(0);
});

it('retains the snapshot slot and physical ownership until all cancelled probes retire', async () => {
  const f = await fixture(), parent = new AbortController(), lifetime = new AgentWorkLifetime();
  const releases: Array<() => void> = [], probes: AbortSignal[] = [];
  const peers = Array.from({ length: 8 }, (_, i) => `peer-${i}`);
  const send = vi.fn(async (_peer, _protocol, _bytes, options) => {
    probes.push(options.signal);
    await new Promise<void>(resolve => { releases.push(resolve); });
    throw new Error('transport retired');
  });
  const agent = { started: true, peerId: 'requester', workLifetime: lifetime, chain: f.chain,
    subscribedContextGraphs: new Map(), contextGraphBindingState: { capture: () => 0, isGenerationCurrent: () => true },
    node: { libp2p: { getConnections: () => peers.map(peer => ({ remotePeer: { toString: () => peer } })) } },
    discovery: { findSnapshotCorePeerIds: async () => [] }, ensurePeerConnected: async () => {}, router: { send } };
  const run = () => PublicSnapshotMethods.prototype.syncPublicGraphSnapshot.call(agent as never,
    { ...scope, trustedCorePeerIds: [], sourcePolicy: BASE_MAINNET_SOURCE_POLICY, signal: parent.signal });
  let settled = false, drained = false;
  const outcome = run().catch(error => error).finally(() => { settled = true; });
  try {
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    parent.abort(new Error('cancel snapshot'));
    const drain = lifetime.drain().then(() => { drained = true; });
    for (const release of releases.slice(0, 3)) release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false); expect(drained).toBe(false);
    expect(lifetime.physicalRuns.size).toBe(1);
    await expect(run()).rejects.toThrow('already running');
    releases[3]!(); await outcome; await drain;
    expect(lifetime.physicalRuns.size).toBe(0);
    expect(send).toHaveBeenCalledTimes(4);
    expect(probes.every(probe => probe.aborted)).toBe(true);
    await expect(run()).rejects.toThrow('cancel snapshot');
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
  } finally { parent.abort(); releases.forEach(release => release()); await outcome; await lifetime.drain(); }
});

it('commits a verified asset through an automatically selected loopback core and never fetches from a rejected core', async () => {
  const wallet = ethers.Wallet.createRandom();
  const chain = new MockChainAdapter('base:8453', wallet.address, { initialContextGraphId: 14n });
  Object.defineProperty(chain, 'deploymentId', { get: () => deploymentId });
  await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: ethers.id(scope.contextGraphId) });
  const signing = await fixture();
  const kaId = (BigInt(wallet.address) << 96n) | 1n;
  const ual = `did:dkg:base:8453/${wallet.address.toLowerCase()}/1`;
  const assertionGraph = knowledgeAssetLayerGraphUri(scope.contextGraphId, MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(ual, 1));
  const data: Quad[] = [{ subject: 'urn:verified-asset', predicate: 'urn:value', object: '"selected core payload"', graph: assertionGraph }];
  const root = computeFlatKCRootV10(data, []);
  const metadata = generateGraphKnowledgeAssetMetadata({ contextGraphId: scope.contextGraphId, ual, assertionGraph,
    merkleRoot: root, publisherPeerId: 'fixture', accessPolicy: 'public', timestamp: new Date(0),
    assertionVersion: '1', publicTripleCount: 1, privateTripleCount: 0,
  }, { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: {
    batchId: kaId, materializedVersion: { blockNumber: 1, txIndex: 0 },
  } } });
  Object.assign(chain, { getIdentityId: signing.chain.getIdentityId,
    signMessage: signing.chain.signMessage, verifyACKIdentity: signing.chain.verifyACKIdentity,
    readPublicGraphSnapshot: async () => sealPublicGraphSnapshot({
      version: 1, chainId: chain.chainId, deploymentId, ...scope,
      nameHash: ethers.id(scope.contextGraphId), contextGraphStorage: `0x${'2'.repeat(40)}`,
      assetStorage: `0x${'3'.repeat(40)}`, blockNumber: '1', blockHash: `0x${'4'.repeat(64)}`,
      finalityConfirmations: 1, observedAt: Date.now(), expiresAt: Date.now() + 120000,
      accessPolicy: 0, assets: [{ id: kaId.toString(), root: ethers.hexlify(root), version: '1' }],
    }),
  });
  const agents: DKGAgent[] = [];
  try {
    for (const nodeRole of ['core', 'edge', 'core'] as const) {
      const agent = await DKGAgent.create({ name: `SnapshotSource-${nodeRole}`, nodeRole,
        chainAdapter: chain, listenHost: '127.0.0.1', listenPort: 0,
        randomSamplingUseWorkerThread: false, syncOnConnectEnabled: false,
        syncReconcilerEnabled: false, vmReconcilerEnabled: false });
      agents.push(agent); await agent.start(); await agent.awaitInitialChainPoll();
    }
    const [core, edge, rejected] = agents;
    await core.store.insert([...data, ...metadata]);
    core.subscribeToContextGraph(scope.contextGraphId, { onChainId: scope.onChainId,
      syncMode: 'on-demand', trackSyncScope: false });
    await edge.connectTo(core.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!);
    await edge.connectTo(rejected.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!);
    const sends = vi.spyOn(edge.router, 'send');
    const streams = vi.spyOn(edge.router, 'withDuplexStream');
    const result = await edge.syncPublicGraphSnapshot({ ...scope, trustedCorePeerIds: [],
      sourcePolicy: BASE_MAINNET_SOURCE_POLICY });
    expect(result).toMatchObject({ sourcePolicy: BASE_MAINNET_SOURCE_POLICY,
      selectedCorePeerIds: [core.peerId], sourceCore: core.peerId, coverageSourceCore: core.peerId,
      completeAsOfSnapshot: true, current: true, assets: 1, committed: 1 });
    expect(await edge.store.query(`SELECT ?value WHERE { GRAPH <${assertionGraph}> { <urn:verified-asset> <urn:value> ?value } }`))
      .toMatchObject({ type: 'bindings', bindings: [{ value: '"selected core payload"' }] });
    expect(sends.mock.calls.filter(([peer]) => peer === rejected.peerId).map(([, protocol]) => protocol))
      .toEqual([PUBLIC_SNAPSHOT_SOURCE_PROTOCOL]);
    expect(streams.mock.calls.some(([peer]) => peer === rejected.peerId)).toBe(false);
    expect(signing.chain.verifyACKIdentity).toHaveBeenCalledWith(signing.wallet.address, 7n, { signal: expect.any(AbortSignal) });
  } finally { for (const agent of agents.reverse()) await agent.stop(); }
});
