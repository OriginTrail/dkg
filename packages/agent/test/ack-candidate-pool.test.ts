// ack-candidate-pool.test.ts
//
// #1093 follow-up (Codex review on PR #1107): `getACKCandidatePeers()` must
// gate its confirmed-core shortcut on the CHAIN's runtime ACK quorum
// (`lastKnownRequiredACKs`, refreshed by the V10 ACK provider before each
// collect), not the hard-coded DEFAULT_REQUIRED_ACKS. On networks configured
// above 3 signatures, a 3-strong confirmed-core subset is still below quorum —
// returning only it re-introduces `pool_below_quorum`.
import { describe, it, expect } from 'vitest';
import { PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2 } from '@origintrail-official/dkg-core';
import { DKGAgent, MockChainAdapter, OxigraphStore } from './agent.shared';

type AgentInternals = {
  node: {
    libp2p: {
      peerId: { toString(): string };
      getPeers: () => Array<{ toString(): string }>;
    };
  };
  peerId: string;
  config: { ackCandidatePeerIds?: string[] };
  knownCorePeerIds: Set<string>;
  knownCorePeerIdsV2: Set<string>;
  lastKnownRequiredACKs?: number;
  getACKCandidatePeers: (protocol?: string) => string[];
  handlePeerUpdateForSyncRetry: (peerId: string, protocols: readonly string[]) => void;
};

const CORE = ['core-1', 'core-2', 'core-3', 'core-4'];
const EDGE = ['edge-1', 'edge-2'];

async function buildAgent(opts: {
  confirmedCores: string[];
  connected: string[];
  lastKnownRequiredACKs?: number;
  ackCandidatePeerIds?: string[];
}): Promise<AgentInternals> {
  const agent = await DKGAgent.create({
    name: 'AckPoolProbe',
    store: new OxigraphStore(),
    chainAdapter: new MockChainAdapter(),
    ackCandidatePeerIds: opts.ackCandidatePeerIds,
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

describe('getACKCandidatePeers — quorum-aware confirmed-core shortcut (#1093 / Codex PR #1107)', () => {
  it('default quorum (3): a 3-strong confirmed-core set is returned alone', async () => {
    const a = await buildAgent({
      confirmedCores: CORE.slice(0, 3),
      connected: [...CORE.slice(0, 3), ...EDGE],
    });
    expect(a.getACKCandidatePeers()).toEqual(CORE.slice(0, 3));
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
    // 4 confirmed ≥ quorum 4 → trust the confirmed-core subset.
    expect(at.getACKCandidatePeers()).toEqual(CORE);
  });

  it('a configured ACK preference list orders listed peers first but never excludes connected peers (2026-07-07 incident)', async () => {
    const foreign = ['testnet-core-1', 'testnet-core-2', 'testnet-core-3'];
    const a = await buildAgent({
      confirmedCores: [CORE[2]],
      connected: [CORE[2], ...foreign, CORE[0], CORE[1], CORE[3]],
      ackCandidatePeerIds: CORE,
    });

    // Listed peers are preferred within each tier (confirmed cores, then
    // rest), but foreign/unlisted peers stay dialable: signer validity is
    // chain truth (sharding-table membership per collected ACK), and a
    // hard gate here capped the mainnet pool at the bundled relay list.
    expect(a.getACKCandidatePeers()).toEqual([
      CORE[2],
      CORE[0], CORE[1], CORE[3],
      ...foreign,
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
      ackCandidatePeerIds: relays,
    });

    const out = a.getACKCandidatePeers();
    expect(out).toEqual([relays[0], relays[1], ...stakedCores]);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });

  it('V2 folded-private rounds keep unlisted V2-advertising cores dialable, listed peers first within each tier', async () => {
    const relays = ['relay-1', 'relay-2'];
    const upgraded = ['staked-core-5', 'staked-core-6', 'staked-core-7'];
    const a = await buildAgent({
      confirmedCores: [...relays, ...upgraded],
      connected: [...upgraded, ...relays],
      ackCandidatePeerIds: relays,
    });
    for (const id of upgraded) a.knownCorePeerIdsV2.add(id);

    // v2Advertised tier first (none listed → connection order), then the
    // remaining confirmed cores (both listed).
    expect(a.getACKCandidatePeers(PROTOCOL_STORAGE_ACK_V2)).toEqual([
      ...upgraded,
      ...relays,
    ]);
  });

  it('runtime quorum below default (2): 2 confirmed cores already satisfy it', async () => {
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

  it('V2 folded-private ACKs keep fallback candidates even when cached V2 metadata appears quorum-sized', async () => {
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

  it('V2 folded-private ACKs do not let stale identify metadata hide a connected upgraded core', async () => {
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
