// ack-candidate-pool.test.ts
//
// ACK candidate selection ranks identify-derived core metadata first but keeps
// connected fallbacks dialable. `knownCorePeerIds` is add-only/partial and can
// contain stale or saturated peers; narrowing to a quorum-sized metadata tier
// reintroduces ACK quorum failures when healthy unclassified cores are present.
import { describe, it, expect } from 'vitest';
import { PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2 } from '@origintrail-official/dkg-core';
import { DKGAgent, MockChainAdapter, OxigraphStore } from './agent.shared';
import { NetworkAdmissionService } from '../src/p2p/network-admission.js';

type AgentInternals = {
  node: {
    libp2p: {
      peerId: { toString(): string };
      getPeers: () => Array<{ toString(): string }>;
    };
  };
  peerId: string;
  config: { ackCandidatePeerIds?: string[]; preferredACKPeerIds?: string[] };
  knownCorePeerIds: Set<string>;
  knownCorePeerIdsV2: Set<string>;
  networkAdmission: NetworkAdmissionService;
  networkAdmissionCoordinator: {
    enabled: boolean;
    isAcceptedPeer(peerId: string): boolean;
    verifiedSameNetworkPeerIds(): ReadonlySet<string>;
  };
  lastKnownRequiredACKs?: number;
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
  internals.node = {
    libp2p: {
      peerId: { toString: () => internals.peerId },
      getPeers: () => opts.connected.map((id) => ({ toString: () => id })),
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

describe('getACKCandidatePeers — confirmed peers first with stale-metadata fallback (#1093 / #1482)', () => {
  it('default quorum (3): a 3-strong confirmed-core set keeps connected fallbacks dialable', async () => {
    const a = await buildAgent({
      confirmedCores: CORE.slice(0, 3),
      connected: [...CORE.slice(0, 3), ...EDGE],
    });
    expect(a.getACKCandidatePeers()).toEqual([...CORE.slice(0, 3), ...EDGE]);
  });

  it('runtime quorum 5: the SAME 3-strong confirmed-core set is NOT trusted alone — all connected peers are returned, cores first', async () => {
    const a = await buildAgent({
      confirmedCores: CORE.slice(0, 3),
      connected: [...CORE.slice(0, 3), ...EDGE],
      lastKnownRequiredACKs: 5,
    });
    const out = a.getACKCandidatePeers();
    // confirmed cores first, then the rest — nothing dropped below quorum.
    expect(out).toEqual([...CORE.slice(0, 3), ...EDGE]);
  });

  it('runtime quorum 4: returns confirmed cores alone only once 4 are classified', async () => {
    const below = await buildAgent({
      confirmedCores: CORE.slice(0, 3),
      connected: [...CORE, ...EDGE],
      lastKnownRequiredACKs: 4,
    });
    // 3 confirmed < quorum 4 → over-ask everyone (cores first).
    expect(below.getACKCandidatePeers()).toEqual([...CORE.slice(0, 3), CORE[3], ...EDGE]);

    const at = await buildAgent({
      confirmedCores: CORE,
      connected: [...CORE, ...EDGE],
      lastKnownRequiredACKs: 4,
    });
    // 4 confirmed ≥ quorum 4, but identify-derived metadata can be stale.
    // Keep connected fallbacks dialable after the confirmed tier.
    expect(at.getACKCandidatePeers()).toEqual([...CORE, ...EDGE]);
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
      confirmedCores: [CORE[2]],
      connected: [CORE[2], ...foreign, CORE[0], CORE[1], CORE[3]],
      preferredACKPeerIds: CORE,
    });

    // Listed peers are preferred within each tier (confirmed cores, then
    // rest). Because the confirmed tier is below quorum, every connected
    // fallback candidate remains dialable; this intentionally avoids the old
    // 2x-quorum cap making quorum unreachable under correlated failures.
    expect(a.getACKCandidatePeers()).toEqual([
      CORE[2],
      CORE[0], CORE[1], CORE[3],
      foreign[0], foreign[1], foreign[2],
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

    expect(a.getACKCandidatePeers(PROTOCOL_STORAGE_ACK_V2)).toEqual([
      ...upgraded,
      ...relays,
    ]);
  });

  it('runtime quorum below default (2): 2 confirmed cores stay first but do not suppress fallbacks', async () => {
    const a = await buildAgent({
      confirmedCores: CORE.slice(0, 2),
      connected: [...CORE.slice(0, 2), ...EDGE],
      lastKnownRequiredACKs: 2,
    });
    expect(a.getACKCandidatePeers()).toEqual([...CORE.slice(0, 2), ...EDGE]);
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
        getPeers: () => [self, ...CORE.slice(0, 3)].map((id) => ({ toString: () => id })),
      },
    };
    expect(a.getACKCandidatePeers()).not.toContain(self);
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
      ...EDGE,
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
      ...EDGE,
      extraEdge,
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
      ...EDGE,
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
});
