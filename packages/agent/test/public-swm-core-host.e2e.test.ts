import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { contextGraphSharedMemoryTopic } from '@origintrail-official/dkg-core';
import { decodeSwmHostCatchupResponse, encodeSwmHostCatchupRequest, SWM_HOST_CATCHUP_WIRE_VERSION } from '../src/swm/host-catchup-wire.js';
import { DKGAgent } from '../src/index.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { createEVMAdapter, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';

interface HostInternals {
  gossip: { getSubscribers(topic: string): string[] };
  swmHostModeSubscribed: Map<string, unknown>;
  gossipWireIdFor(id: string): string;
  reconcileSwmHostModeSubscription(id: string): Promise<void>;
  stageOnChainContextGraphBindingFromNameHash(hash: string, id: string): string | null;
  getSwmHostModeStats(): Promise<{ perCg: Record<string, { entries: number }> } | undefined>;
  handleSwmHostCatchup(bytes: Uint8Array, peer: string): Promise<Uint8Array>;
}

describe('public-only core hosting with the publisher offline', () => {
  const name = 'public-core-host-offline';
  const hash = ethers.keccak256(ethers.toUtf8Bytes(name)).toLowerCase();
  const subject = 'urn:public-core-host:offline-data';
  const agents: DKGAgent[] = [];
  const directories: string[] = [];
  let snapshot: string;
  let publisher: DKGAgent, core: DKGAgent, reader: DKGAgent;
  let onChainId: string;
  beforeAll(async () => {
    snapshot = await takeSnapshot();
    async function create(role: 'edge' | 'core', hostPublic = false) {
      const dataDir = await mkdtemp(join(tmpdir(), 'dkg-public-core-host-'));
      directories.push(dataDir);
      const agent = await DKGAgent.create({ name: `${role}-offline-host`, dataDir, nodeRole: role,
        listenHost: '127.0.0.1', listenPort: 0,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP), kaNumberAllocator: makeTestKaNumberAllocator(),
        rfc64CatalogActivation: { enabled: false }, syncOnConnectEnabled: false, syncReconcilerEnabled: false,
        swmHostMode: { enabled: true, hostPublic, stripCiphertext: true } });
      agents.push(agent); await agent.start(); return agent;
    }
    publisher = await create('edge'); core = await create('core', true);
    await publisher.createContextGraph({ id: name, name, accessPolicy: 0, publishPolicy: 1 });
    onChainId = (await publisher.registerContextGraph(name)).onChainId;
    const host = core as unknown as HostInternals;
    expect(host.stageOnChainContextGraphBindingFromNameHash(hash, onChainId)).toBe(hash);
    await host.reconcileSwmHostModeSubscription(hash);
    expect(host.swmHostModeSubscribed.has(hash)).toBe(true);
    await publisher.connectTo(core.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!);
    // The real mesh, rather than a handler stub, must be ready for the share.
    const topic = contextGraphSharedMemoryTopic(hash);
    await vi.waitFor(() => expect((publisher as unknown as HostInternals).gossip.getSubscribers(topic).length).toBeGreaterThan(0), { timeout: 20_000 });
  }, 60_000);
  afterAll(async () => {
    for (const agent of agents) await agent.stop().catch(() => undefined);
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
    await revertSnapshot(snapshot);
  });

  it('a new nonmember recovers public SWM from the core after the publisher stops', async () => {
    await publisher.assertion.create(name, 'offline-shared-asset');
    await publisher.assertion.write(name, 'offline-shared-asset', [{ subject, predicate: 'http://schema.org/name', object: '"Offline Publisher"', graph: '' }]);
    await publisher.assertion.promote(name, 'offline-shared-asset');
    const host = core as unknown as HostInternals;
    await vi.waitFor(async () => expect((await host.getSwmHostModeStats())?.perCg[name]?.entries ?? 0).toBeGreaterThan(0), { timeout: 20_000 });
    const publisherPeer = publisher.peerId;
    await publisher.stop();
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-public-core-reader-')); directories.push(dataDir);
    reader = await DKGAgent.create({ name: 'late-public-reader', dataDir, listenHost: '127.0.0.1', listenPort: 0,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP), kaNumberAllocator: makeTestKaNumberAllocator(),
      rfc64CatalogActivation: { enabled: false }, syncOnConnectEnabled: false, syncReconcilerEnabled: false });
    agents.push(reader); await reader.start();
    reader.setContextGraphSubscription(name, { subscribed: true, synced: false, syncMode: 'on-demand', onChainHash: hash, onChainId }, { persist: false });
    await reader.connectTo(core.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!);
    expect(reader.node.libp2p.getPeers().some(peer => peer.toString() === publisherPeer)).toBe(false);
    const recovered = await reader.catchupSwmFromHost(core.peerId, name);
    expect(recovered.denied).toBeUndefined();
    expect(recovered.fetched).toBeGreaterThan(0);
    expect(recovered.applied).toBeGreaterThan(0);
    expect((await reader.query(`SELECT ?name WHERE { <${subject}> <http://schema.org/name> ?name }`, { contextGraphId: name, includeSharedMemory: true })).bindings).toHaveLength(1);
  }, 60_000);

  it('the same opt-in core refuses a registered private graph while ciphertext stripping stays on', async () => {
    const id = 'private-core-host-refusal';
    const privateHash = ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
    // Use the late reader's real chain adapter; the offline publisher stays off.
    await reader.createContextGraph({ id, name: id, accessPolicy: 1, publishPolicy: 1 });
    const registration = await reader.registerContextGraph(id);
    const host = core as unknown as HostInternals;
    host.stageOnChainContextGraphBindingFromNameHash(privateHash, registration.onChainId);
    await host.reconcileSwmHostModeSubscription(privateHash);
    expect(host.swmHostModeSubscribed.has(privateHash)).toBe(false);
    const refusal = decodeSwmHostCatchupResponse(await host.handleSwmHostCatchup(encodeSwmHostCatchupRequest({
      version: SWM_HOST_CATCHUP_WIRE_VERSION, contextGraphId: privateHash, sinceSeqno: 0,
      maxEntries: 10, maxBytes: 1024, requesterEoa: ethers.ZeroAddress, issuedAtMs: Date.now(), nonce: `0x${'11'.repeat(16)}`, sig: `0x${'00'.repeat(65)}`,
    }), reader.peerId));
    expect(refusal.entries).toEqual([]);
    expect(refusal.denied).toMatch(/strip/i);
  }, 30_000);
});
