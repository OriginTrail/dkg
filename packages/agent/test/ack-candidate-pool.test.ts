// ack-candidate-pool.test.ts
//
// ACK candidate selection dials only peers confirmed to advertise the
// core-only StorageACK protocol. Unclassified connections may include edges.
import { describe, it, expect, vi } from 'vitest';
import { createOperationContext, PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2 } from '@origintrail-official/dkg-core';
import { DKGAgent, MockChainAdapter, OxigraphStore } from './agent.shared';
import { NetworkAdmissionService } from '../src/p2p/network-admission.js';
import { PeerSyncSession } from '../src/sync/peer-sync-session.js';

type AgentInternals = {
  node: {
    libp2p: {
      peerId: { toString(): string };
      getPeers: () => Array<{ toString(): string }>;
      getConnections: () => Array<{ remotePeer: { toString(): string } }>;
    };
  };
  peerId: string;
  config: { ackCandidatePeerIds?: string[]; preferredACKPeerIds?: string[]; nodeRole?: string };
  peerSyncSession: PeerSyncSession;
  knownCorePeerIds: Set<string>;
  knownCorePeerIdsV2: Set<string>;
  networkAdmission: NetworkAdmissionService;
  networkAdmissionCoordinator: {
    enabled: boolean;
    isAcceptedPeer(peerId: string): boolean;
    verifiedSameNetworkPeerIds(): ReadonlySet<string>;
    preflightPeerAdmission?(peerIds: Iterable<string>): Promise<{
      checked: number;
      admitted: number;
      unresolved: number;
    }>;
  };
  lastKnownRequiredACKs?: number;
  getPeerProtocols(peerId: string): Promise<string[]>;
  getACKCandidatePeersAfterAdmission(protocol: string | undefined, ctx: unknown): Promise<string[]>;
  router: { probeProtocol(peerId: string, protocol: string): Promise<boolean> } | null;
  storageAckEndpoint: {
    dispatch(protocol: string, data: Uint8Array, peerId: string): Promise<Uint8Array>;
  } | null;
  getACKCandidatePeers: (protocol?: string) => string[];
  handlePeerUpdateForSyncRetry: (peerId: string, protocols: readonly string[]) => void;
};

const CORE = ['core-1', 'core-2', 'core-3', 'core-4'];
const EDGE = ['edge-1', 'edge-2'];
const ADMISSION_FOREIGN = [
  '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh',
  '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb',
];
const ADMISSION_SAME_NETWORK = [
  '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6',
  '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M',
];

function peer(id: string): { toString(): string } {
  return { toString: () => id };
}

function connection(id: string): { remotePeer: { toString(): string } } {
  return { remotePeer: peer(id) };
}

async function buildAgent(opts: {
  confirmedCores: string[];
  connected: string[];
  lastKnownRequiredACKs?: number;
  ackCandidatePeerIds?: string[];
  preferredACKPeerIds?: string[];
}): Promise<AgentInternals> {
  const agent = await DKGAgent.create({
    name: 'AckPoolProbe',
    store: new OxigraphStore(),
    chainAdapter: new MockChainAdapter(),
    ackCandidatePeerIds: opts.ackCandidatePeerIds,
    preferredACKPeerIds: opts.preferredACKPeerIds,
  });
  const internals = agent as unknown as AgentInternals;
  // The fixture represents a running node whose identify events may update ACK capabilities.
  internals.peerSyncSession = new PeerSyncSession({
    createJob: () => { throw new Error('scheduler is outside this fixture'); },
    onInternalError: () => undefined,
  });
  internals.node = {
    libp2p: {
      peerId: { toString: () => internals.peerId },
      getPeers: () => opts.connected.map(peer),
      getConnections: () => opts.connected.map(connection),
    },
  };
  for (const id of opts.confirmedCores) internals.knownCorePeerIds.add(id);
  internals.lastKnownRequiredACKs = opts.lastKnownRequiredACKs;
  return internals;
}

function installAdmission(agent: AgentInternals, admission: NetworkAdmissionService, enabled = true): void {
  agent.networkAdmission = admission;
  agent.networkAdmissionCoordinator = {
    get enabled() {
      return enabled;
    },
    isAcceptedPeer: (peerId) => enabled ? admission.isAcceptedPeer(peerId) : true,
    verifiedSameNetworkPeerIds: () => enabled ? admission.verifiedSameNetworkPeerIds() : new Set(),
  };
}

describe('getACKCandidatePeers — core-only candidates', () => {
  it('excludes connected edges from a 3-core pool', async () => {
    const a = await buildAgent({
      confirmedCores: CORE.slice(0, 3),
      connected: [...CORE.slice(0, 3), ...EDGE],
    });
    expect(a.getACKCandidatePeers()).toEqual(CORE.slice(0, 3));
  });

  it('does not add edges even when confirmed cores are below runtime quorum', async () => {
    const a = await buildAgent({
      confirmedCores: CORE.slice(0, 3),
      connected: [...CORE.slice(0, 3), ...EDGE],
      lastKnownRequiredACKs: 5,
    });
    const out = a.getACKCandidatePeers();
    expect(out).toEqual(CORE.slice(0, 3));
  });

  it('waits for identify to classify additional connected cores', async () => {
    const below = await buildAgent({
      confirmedCores: CORE.slice(0, 3),
      connected: [...CORE, ...EDGE],
      lastKnownRequiredACKs: 4,
    });
    expect(below.getACKCandidatePeers()).toEqual(CORE.slice(0, 3));
    below.handlePeerUpdateForSyncRetry(CORE[3], [PROTOCOL_STORAGE_ACK]);
    expect(below.getACKCandidatePeers()).toEqual(CORE);

    const at = await buildAgent({
      confirmedCores: CORE,
      connected: [...CORE, ...EDGE],
      lastKnownRequiredACKs: 4,
    });
    expect(at.getACKCandidatePeers()).toEqual(CORE);
  });

  it('refreshes identify metadata before admission and never preflights edges', async () => {
    const a = await buildAgent({ confirmedCores: [EDGE[0]], connected: [CORE[0], EDGE[0]] });
    a.getPeerProtocols = async (peerId) => peerId === CORE[0]
      ? [PROTOCOL_STORAGE_ACK]
      : ['/dkg/10.0.0/sync'];
    let preflightPeers: string[] = [];
    a.networkAdmissionCoordinator = {
      enabled: false,
      isAcceptedPeer: () => true,
      verifiedSameNetworkPeerIds: () => new Set(),
      preflightPeerAdmission: async (peerIds) => {
        preflightPeers = [...peerIds];
        return { checked: preflightPeers.length, admitted: 0, unresolved: 0 };
      },
    };

    expect(await a.getACKCandidatePeersAfterAdmission(undefined, createOperationContext('publish'))).toEqual([CORE[0]]);
    expect(preflightPeers).toEqual([CORE[0]]);
    expect(a.knownCorePeerIds.has(EDGE[0])).toBe(false);
  });

  it('probes a core that registered StorageACK after its cached identify record', async () => {
    const a = await buildAgent({ confirmedCores: [], connected: [EDGE[0], CORE[0]] });
    a.getPeerProtocols = async () => ['/dkg/10.0.0/sync'];
    let ackHandlerRegistered = false;
    const probe = vi.fn(async (peerId: string) => ackHandlerRegistered && peerId === CORE[0]);
    a.router = { probeProtocol: probe };
    let preflightPeers: string[] = [];
    a.networkAdmissionCoordinator = {
      enabled: false,
      isAcceptedPeer: () => true,
      verifiedSameNetworkPeerIds: () => new Set(),
      preflightPeerAdmission: async (peerIds) => {
        preflightPeers = [...peerIds];
        return { checked: preflightPeers.length, admitted: 0, unresolved: 0 };
      },
    };

    expect(await a.getACKCandidatePeersAfterAdmission(undefined, createOperationContext('publish'))).toEqual([]);
    ackHandlerRegistered = true; // The cached identify record stays populated and unchanged.
    expect(await a.getACKCandidatePeersAfterAdmission(undefined, createOperationContext('publish'))).toEqual([CORE[0]]);
    expect(probe).toHaveBeenCalledWith(CORE[0], PROTOCOL_STORAGE_ACK);
    expect(preflightPeers).toEqual([CORE[0]]);
  });

  it('still probes unknown peers when identified cores fail active-network admission', async () => {
    const a = await buildAgent({
      confirmedCores: CORE.slice(0, 3),
      connected: CORE,
      lastKnownRequiredACKs: 3,
    });
    a.getPeerProtocols = async (peerId) => peerId === CORE[3]
      ? ['/dkg/10.0.0/sync']
      : [PROTOCOL_STORAGE_ACK];
    const probe = vi.fn(async (peerId: string) => peerId === CORE[3]);
    a.router = { probeProtocol: probe };
    a.networkAdmissionCoordinator = {
      enabled: true,
      isAcceptedPeer: (peerId) => peerId === CORE[3],
      verifiedSameNetworkPeerIds: () => new Set([CORE[3]]),
      preflightPeerAdmission: async (peerIds) => ({
        checked: [...peerIds].length,
        admitted: 0,
        unresolved: 0,
      }),
    };

    expect(await a.getACKCandidatePeersAfterAdmission(undefined, createOperationContext('publish'))).toEqual([CORE[3]]);
    expect(probe).toHaveBeenCalledWith(CORE[3], PROTOCOL_STORAGE_ACK);
  });

  it('limits live capability probes to four concurrent and 32 total', async () => {
    const unknown = Array.from({ length: 40 }, (_, i) => `unknown-${i}`);
    const a = await buildAgent({ confirmedCores: [], connected: unknown });
    a.getPeerProtocols = async () => ['/dkg/10.0.0/sync'];
    let active = 0;
    let peak = 0;
    const probe = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      active--;
      return false;
    });
    a.router = { probeProtocol: probe };
    a.networkAdmissionCoordinator = {
      enabled: false,
      isAcceptedPeer: () => true,
      verifiedSameNetworkPeerIds: () => new Set(),
      preflightPeerAdmission: async (peerIds) => ({ checked: [...peerIds].length, admitted: 0, unresolved: 0 }),
    };

    expect(await a.getACKCandidatePeersAfterAdmission(undefined, createOperationContext('publish'))).toEqual([]);
    expect(probe).toHaveBeenCalledTimes(32);
    expect(peak).toBe(4);
    expect(active).toBe(0);
  });

  it('ackCandidatePeerIds remains an allowlist for callers that intentionally restrict candidacy', async () => {
    const a = await buildAgent({
      confirmedCores: [CORE[0], 'untrusted-peer'],
      connected: [CORE[0], 'untrusted-peer'],
      ackCandidatePeerIds: [CORE[0]],
    });

    expect(a.getACKCandidatePeers()).toEqual([CORE[0]]);
  });

  it('a configured ACK preference list orders listed peers first and retains below-quorum fallback candidates (2026-07-07 incident)', async () => {
    const foreign = ['testnet-core-1', 'testnet-core-2', 'testnet-core-3'];
    const a = await buildAgent({
      confirmedCores: CORE,
      connected: [CORE[2], ...foreign, CORE[0], CORE[1], CORE[3]],
      preferredACKPeerIds: CORE,
    });

    // Every confirmed non-relay core remains dialable; unrelated peers do not.
    expect(a.getACKCandidatePeers()).toEqual([
      CORE[2],
      CORE[0], CORE[1], CORE[3],
    ]);
  });

  it('staked cores outside the preference list can still complete quorum when listed relays are degraded (2026-07-07 incident)', async () => {
    // Base mainnet shape: preference list = 4 bundled relays, of which only
    // 2 are connected/healthy; 3 upgraded non-relay staked cores are
    // connected. The old hard filter returned only [relay-1, relay-2] and
    // made the 3-ACK quorum arithmetically unreachable.
    const relays = ['relay-1', 'relay-2', 'relay-3', 'relay-4'];
    const stakedCores = ['staked-core-5', 'staked-core-6', 'staked-core-7'];
    const a = await buildAgent({
      confirmedCores: [relays[0], relays[1], ...stakedCores],
      connected: [relays[0], relays[1], ...stakedCores],
      preferredACKPeerIds: relays,
    });

    const out = a.getACKCandidatePeers();
    expect(out).toEqual([relays[0], relays[1], ...stakedCores]);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });

  it('filters ACK candidates to active-network admitted peers when admission is enabled', async () => {
    const foreign = ADMISSION_FOREIGN;
    const sameNetwork = ADMISSION_SAME_NETWORK;
    const a = await buildAgent({
      confirmedCores: [...foreign, ...sameNetwork],
      connected: [...foreign, ...sameNetwork],
      preferredACKPeerIds: [sameNetwork[1], foreign[0]],
    });
    const admission = new NetworkAdmissionService({ networkId: 'active-network' });
    installAdmission(a, admission);
    admission.markVerifiedSameNetwork(sameNetwork[0]);

    expect(a.getACKCandidatePeers()).toEqual([sameNetwork[0]]);

    admission.markVerifiedSameNetwork(sameNetwork[1]);
    expect(a.getACKCandidatePeers()).toEqual([sameNetwork[1], sameNetwork[0]]);
  });

  it('V2 folded-private rounds keep unlisted V2-advertising cores dialable, listed peers first within each tier', async () => {
    const relays = ['relay-1', 'relay-2'];
    const upgraded = ['staked-core-5', 'staked-core-6', 'staked-core-7'];
    const a = await buildAgent({
      confirmedCores: [...relays, ...upgraded],
      connected: [...upgraded, ...relays],
      preferredACKPeerIds: relays,
    });
    for (const id of upgraded) a.knownCorePeerIdsV2.add(id);

    expect(a.getACKCandidatePeers(PROTOCOL_STORAGE_ACK_V2)).toEqual([...upgraded, ...relays]);
  });

  it('runtime quorum below default still excludes edges', async () => {
    const a = await buildAgent({
      confirmedCores: CORE.slice(0, 2),
      connected: [...CORE.slice(0, 2), ...EDGE],
      lastKnownRequiredACKs: 2,
    });
    expect(a.getACKCandidatePeers()).toEqual(CORE.slice(0, 2));
  });

  it('excludes self from the candidate pool', async () => {
    const a = await buildAgent({
      confirmedCores: CORE.slice(0, 3),
      connected: [...CORE.slice(0, 3), ...EDGE],
    });
    const self = a.peerId;
    a.node = {
      libp2p: {
        peerId: { toString: () => self },
        getPeers: () => [self, ...CORE.slice(0, 3)].map(peer),
        getConnections: () => [self, ...CORE.slice(0, 3)].map(connection),
      },
    };
    expect(a.getACKCandidatePeers()).not.toContain(self);
  });

  it('includes the publishing core when its real StorageACK handler is registered', async () => {
    const a = await buildAgent({
      confirmedCores: CORE.slice(0, 2),
      connected: [...CORE.slice(0, 2), ...EDGE],
    });
    a.config.nodeRole = 'core';
    a.storageAckEndpoint = {
      dispatch: async () => new Uint8Array([1]),
    };

    expect(a.getACKCandidatePeers()).toEqual([a.peerId, ...CORE.slice(0, 2)]);
    expect(a.getACKCandidatePeers(PROTOCOL_STORAGE_ACK_V2)).toEqual([a.peerId, ...CORE.slice(0, 2)]);
    a.config.ackCandidatePeerIds = [CORE[0]];
    expect(a.getACKCandidatePeers()).toEqual([a.peerId, CORE[0]]);

    a.storageAckEndpoint = null;
    expect(a.getACKCandidatePeers()).toEqual([CORE[0]]);
  });

  it('uses active connections when the peer-store peer list is still empty after startup', async () => {
    const a = await buildAgent({
      confirmedCores: CORE.slice(0, 3),
      connected: [],
    });
    a.node = {
      libp2p: {
        peerId: { toString: () => a.peerId },
        getPeers: () => [],
        getConnections: () => CORE.slice(0, 3).map(connection),
      },
    };

    expect(a.getACKCandidatePeers()).toEqual(CORE.slice(0, 3));
  });

  it('V2 folded-private ACKs prefer advertised V2 peers, then keep enough candidates for wire negotiation', async () => {
    const a = await buildAgent({
      confirmedCores: CORE,
      connected: [...CORE, ...EDGE],
      lastKnownRequiredACKs: 4,
    });
    a.knownCorePeerIdsV2.add(CORE[0]);
    a.knownCorePeerIdsV2.add(CORE[2]);

    expect(a.getACKCandidatePeers(PROTOCOL_STORAGE_ACK_V2)).toEqual([
      CORE[0],
      CORE[2],
      CORE[1],
      CORE[3],
    ]);
  });

  it('V2 folded-private ACK fallback is retained, not capped, while advertised V2 peers are below quorum', async () => {
    const extraEdge = 'edge-3';
    const a = await buildAgent({
      confirmedCores: CORE,
      connected: [...CORE, ...EDGE, extraEdge],
      lastKnownRequiredACKs: 3,
    });
    a.knownCorePeerIdsV2.add(CORE[0]);

    expect(a.getACKCandidatePeers(PROTOCOL_STORAGE_ACK_V2)).toEqual([
      CORE[0],
      CORE[1],
      CORE[2],
      CORE[3],
    ]);
  });

  it('V2 folded-private ACKs retain fallback candidates even when cached V2 metadata reaches quorum', async () => {
    const a = await buildAgent({
      confirmedCores: CORE,
      connected: [...CORE, ...EDGE],
      lastKnownRequiredACKs: 2,
    });
    a.knownCorePeerIdsV2.add(CORE[0]);
    a.knownCorePeerIdsV2.add(CORE[2]);

    expect(a.getACKCandidatePeers(PROTOCOL_STORAGE_ACK_V2)).toEqual([
      CORE[0],
      CORE[2],
      CORE[1],
      CORE[3],
    ]);
  });

  it('V2 folded-private ACKs keep fallback candidates after the protocol-capable tier', async () => {
    const a = await buildAgent({
      confirmedCores: CORE,
      connected: CORE,
      lastKnownRequiredACKs: 3,
    });
    a.knownCorePeerIdsV2.add(CORE[0]);
    a.knownCorePeerIdsV2.add(CORE[1]);
    a.knownCorePeerIdsV2.add(CORE[2]);

    expect(a.getACKCandidatePeers(PROTOCOL_STORAGE_ACK_V2)).toEqual(CORE);
  });

  it('peer:update evicts stale V2 ACK capability only from populated protocol lists', async () => {
    const a = await buildAgent({
      confirmedCores: CORE,
      connected: CORE,
      lastKnownRequiredACKs: 4,
    });
    a.knownCorePeerIdsV2.add(CORE[0]);

    a.handlePeerUpdateForSyncRetry(CORE[0], []);
    expect(a.knownCorePeerIdsV2.has(CORE[0])).toBe(true);
    expect(a.getACKCandidatePeers(PROTOCOL_STORAGE_ACK_V2)).toEqual(CORE);

    a.handlePeerUpdateForSyncRetry(CORE[0], [PROTOCOL_STORAGE_ACK]);
    expect(a.knownCorePeerIdsV2.has(CORE[0])).toBe(false);
    expect(a.knownCorePeerIds.has(CORE[0])).toBe(true);
    expect(a.getACKCandidatePeers(PROTOCOL_STORAGE_ACK_V2)).toEqual(CORE);
  });

  it('revokes core candidacy when a populated protocol update no longer advertises StorageACK', async () => {
    const a = await buildAgent({ confirmedCores: CORE, connected: [...CORE, ...EDGE] });
    a.handlePeerUpdateForSyncRetry(CORE[0], []);
    expect(a.getACKCandidatePeers()).toEqual(CORE);

    a.handlePeerUpdateForSyncRetry(CORE[0], ['/dkg/10.0.0/sync']);
    expect(a.getACKCandidatePeers()).toEqual(CORE.slice(1));
  });
});
