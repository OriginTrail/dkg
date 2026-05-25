/**
 * OT-RFC-38 LU-6 Phase B — discovery beacon agent-level integration.
 *
 * Validates the wiring `createContextGraph → broadcast beacon →
 * core verify → core handleIncomingBeacon → reconcileSwmHostModeSubscription`.
 *
 * Drops in a fake gossip transport so the curator's beacon flows
 * directly into the core's beacon handler without libp2p — keeps
 * the test under 1s and avoids real network ports.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGAgent } from '../../src/index.js';
import {
  BEACON_ACCESS_POLICY_CURATED,
  computeBeaconDigest,
  decodeCgDiscoveryBeacon,
  DKG_CG_DISCOVERY_TOPIC,
  type CgDiscoveryBeacon,
} from '../../src/swm/cg-discovery-beacon.js';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';

/**
 * Minimal in-memory gossip that mirrors GossipSubManager's surface
 * the agent uses for the beacon path: subscribe / onMessage / publish.
 * No mesh — every publish dispatches synchronously to every handler
 * registered on the same topic.
 */
class InMemoryGossipBus {
  private handlers = new Map<string, Array<(topic: string, data: Uint8Array, from: string) => void | Promise<void>>>();
  private subscribed = new Set<string>();

  subscribe(topic: string): void {
    this.subscribed.add(topic);
  }

  unsubscribe(topic: string): void {
    this.subscribed.delete(topic);
    this.handlers.delete(topic);
  }

  onMessage(topic: string, handler: (topic: string, data: Uint8Array, from: string) => void | Promise<void>): void {
    let list = this.handlers.get(topic);
    if (!list) {
      list = [];
      this.handlers.set(topic, list);
    }
    list.push(handler);
  }

  offMessage(topic: string, handler: (topic: string, data: Uint8Array, from: string) => void | Promise<void>): void {
    const list = this.handlers.get(topic);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }

  async publish(topic: string, data: Uint8Array, from = '12D3KooWLocalPublisher'): Promise<void> {
    const list = this.handlers.get(topic) ?? [];
    for (const handler of list) {
      await handler(topic, data, from);
    }
  }

  getSubscribers(_topic: string): string[] { return []; }
}

interface AgentInternals {
  chain: { signMessage(digest: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> };
  swmHostModeStore?: SwmHostModeStore;
  gossip: InMemoryGossipBus;
  beaconRegistry: Map<string, { wireId: string; curatorEoa: string; accessPolicy: number }>;
  beaconCuratorByWireId: Map<string, string>;
  registerCgForBeaconAnnouncement(localCgId: string, accessPolicy: number): Promise<void>;
  handleIncomingCgDiscoveryBeacon(data: Uint8Array, fromPeer: string): Promise<void>;
  subscribeCgDiscoveryTopic(): void;
  getRegistrationTxSignerAddress(): Promise<string | undefined>;
  reconcileSwmHostModeSubscription(contextGraphId: string): Promise<void>;
}

async function installHostModeStore(core: DKGAgent, dataDir: string): Promise<SwmHostModeStore> {
  const defaults = SwmHostModeStore.defaultLimits();
  const store = new SwmHostModeStore({
    dataDir: join(dataDir, 'swm-host'),
    unregisteredLimits: defaults.unregistered,
    registeredLimits: defaults.registered,
  });
  await store.init();
  (core as unknown as AgentInternals).swmHostModeStore = store;
  return store;
}

describe('CG discovery beacon — agent-level integration', () => {
  const tempDirs: string[] = [];
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((a) => a.stop().catch(() => {}).then(() => a.store.close().catch(() => {}))));
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('curator broadcasts a beacon that the core verifies and uses to engage host-mode reconcile', async () => {
    const curatorWallet = ethers.Wallet.createRandom();
    const sharedBus = new InMemoryGossipBus();

    const curator = await DKGAgent.create({ name: 'BeaconCurator', listenHost: '127.0.0.1' });
    agents.push(curator);
    // Override the curator's chain signer with a real wallet so the
    // beacon signature actually verifies on the receiving side. The
    // default MockChainAdapter returns zero-byte signatures.
    (curator as unknown as AgentInternals).chain.signMessage = async (digest: Uint8Array) => {
      const sig = ethers.Signature.from(await curatorWallet.signMessage(digest));
      return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
    };
    // Override the curator's address resolver so the beacon's claimed
    // EOA matches the wallet we just wired into signMessage.
    (curator as unknown as AgentInternals).getRegistrationTxSignerAddress = async () => curatorWallet.address;
    // Wire the in-memory gossip bus shared with the core.
    (curator as unknown as AgentInternals).gossip = sharedBus;

    const coreDataDir = await mkdtemp(join(tmpdir(), 'dkg-beacon-core-'));
    tempDirs.push(coreDataDir);
    const core = await DKGAgent.create({
      name: 'BeaconCore',
      listenHost: '127.0.0.1',
      dataDir: coreDataDir,
      nodeRole: 'core',
      swmHostMode: { enabled: true },
    });
    agents.push(core);
    (core as unknown as AgentInternals).gossip = sharedBus;
    await installHostModeStore(core, coreDataDir);
    (core as unknown as AgentInternals).subscribeCgDiscoveryTopic();

    const cgId = 'beacon-int-cg';
    const wireId = ethers.keccak256(ethers.toUtf8Bytes(cgId)).toLowerCase();

    await (curator as unknown as AgentInternals).registerCgForBeaconAnnouncement(cgId, BEACON_ACCESS_POLICY_CURATED);

    expect((curator as unknown as AgentInternals).beaconRegistry.get(cgId)).toEqual({
      wireId,
      curatorEoa: curatorWallet.address.toLowerCase(),
      accessPolicy: BEACON_ACCESS_POLICY_CURATED,
    });

    // The publish above dispatches synchronously through InMemoryGossipBus
    // into the core's beacon handler — the core should have recorded the
    // curator EOA against the wire id.
    expect((core as unknown as AgentInternals).beaconCuratorByWireId.get(wireId))
      .toBe(curatorWallet.address.toLowerCase());
  });

  it('rejects beacons whose signature does not recover to the claimed curator EOA', async () => {
    const realCurator = ethers.Wallet.createRandom();
    const impostor = ethers.Wallet.createRandom();
    const sharedBus = new InMemoryGossipBus();

    const coreDataDir = await mkdtemp(join(tmpdir(), 'dkg-beacon-bad-'));
    tempDirs.push(coreDataDir);
    const core = await DKGAgent.create({
      name: 'BeaconCoreBad',
      listenHost: '127.0.0.1',
      dataDir: coreDataDir,
      nodeRole: 'core',
      swmHostMode: { enabled: true },
    });
    agents.push(core);
    (core as unknown as AgentInternals).gossip = sharedBus;
    await installHostModeStore(core, coreDataDir);
    (core as unknown as AgentInternals).subscribeCgDiscoveryTopic();

    const wireId = ethers.keccak256(ethers.toUtf8Bytes('beacon-bad-cg')).toLowerCase();
    const ts = Math.floor(Date.now() / 1000);
    const beacon: CgDiscoveryBeacon = {
      v: 1,
      nameHash: wireId,
      accessPolicy: BEACON_ACCESS_POLICY_CURATED,
      curatorEoa: realCurator.address.toLowerCase(),
      ts,
      sig: await impostor.signMessage(computeBeaconDigest({
        v: 1,
        nameHash: wireId,
        accessPolicy: BEACON_ACCESS_POLICY_CURATED,
        curatorEoa: realCurator.address.toLowerCase(),
        ts,
      })),
    };
    await sharedBus.publish(DKG_CG_DISCOVERY_TOPIC, new TextEncoder().encode(JSON.stringify(beacon)));

    expect((core as unknown as AgentInternals).beaconCuratorByWireId.has(wireId)).toBe(false);
  });

  it('first-claim-wins: subsequent beacons from a different EOA for the same wireId are rejected', async () => {
    const sharedBus = new InMemoryGossipBus();
    const coreDataDir = await mkdtemp(join(tmpdir(), 'dkg-beacon-claim-'));
    tempDirs.push(coreDataDir);
    const core = await DKGAgent.create({
      name: 'BeaconCoreClaim',
      listenHost: '127.0.0.1',
      dataDir: coreDataDir,
      nodeRole: 'core',
      swmHostMode: { enabled: true },
    });
    agents.push(core);
    (core as unknown as AgentInternals).gossip = sharedBus;
    await installHostModeStore(core, coreDataDir);
    (core as unknown as AgentInternals).subscribeCgDiscoveryTopic();

    const wireId = ethers.keccak256(ethers.toUtf8Bytes('beacon-collision-cg')).toLowerCase();
    const ts = Math.floor(Date.now() / 1000);

    async function signedBeacon(wallet: ethers.HDNodeWallet): Promise<Uint8Array> {
      const digest = computeBeaconDigest({
        v: 1,
        nameHash: wireId,
        accessPolicy: BEACON_ACCESS_POLICY_CURATED,
        curatorEoa: wallet.address.toLowerCase(),
        ts,
      });
      const beacon: CgDiscoveryBeacon = {
        v: 1,
        nameHash: wireId,
        accessPolicy: BEACON_ACCESS_POLICY_CURATED,
        curatorEoa: wallet.address.toLowerCase(),
        ts,
        sig: await wallet.signMessage(digest),
      };
      return new TextEncoder().encode(JSON.stringify(beacon));
    }

    const firstCurator = ethers.Wallet.createRandom();
    const secondCurator = ethers.Wallet.createRandom();

    await sharedBus.publish(DKG_CG_DISCOVERY_TOPIC, await signedBeacon(firstCurator));
    expect((core as unknown as AgentInternals).beaconCuratorByWireId.get(wireId))
      .toBe(firstCurator.address.toLowerCase());

    await sharedBus.publish(DKG_CG_DISCOVERY_TOPIC, await signedBeacon(secondCurator));
    expect((core as unknown as AgentInternals).beaconCuratorByWireId.get(wireId))
      .toBe(firstCurator.address.toLowerCase());
  });

  it('decodeCgDiscoveryBeacon round-trips through the JSON gossip wire format', async () => {
    const wallet = ethers.Wallet.createRandom();
    const wireId = ethers.keccak256(ethers.toUtf8Bytes('beacon-codec-cg')).toLowerCase();
    const ts = Math.floor(Date.now() / 1000);
    const digest = computeBeaconDigest({
      v: 1,
      nameHash: wireId,
      accessPolicy: BEACON_ACCESS_POLICY_CURATED,
      curatorEoa: wallet.address.toLowerCase(),
      ts,
    });
    const beacon: CgDiscoveryBeacon = {
      v: 1,
      nameHash: wireId,
      accessPolicy: BEACON_ACCESS_POLICY_CURATED,
      curatorEoa: wallet.address.toLowerCase(),
      ts,
      sig: await wallet.signMessage(digest),
    };
    const decoded = decodeCgDiscoveryBeacon(new TextEncoder().encode(JSON.stringify(beacon)));
    expect(decoded).toEqual(beacon);
  });
});
