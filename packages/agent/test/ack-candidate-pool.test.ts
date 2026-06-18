// ack-candidate-pool.test.ts
//
// #1093 follow-up (Codex review on PR #1107): `getACKCandidatePeers()` must
// gate its confirmed-core shortcut on the CHAIN's runtime ACK quorum
// (`lastKnownRequiredACKs`, refreshed by the V10 ACK provider before each
// collect), not the hard-coded DEFAULT_REQUIRED_ACKS. On networks configured
// above 3 signatures, a 3-strong confirmed-core subset is still below quorum —
// returning only it re-introduces `pool_below_quorum`.
import { describe, it, expect } from 'vitest';
import { DKGAgent, MockChainAdapter, OxigraphStore } from './agent.shared';

type AgentInternals = {
  node: { libp2p: { getPeers: () => Array<{ toString(): string }> } };
  peerId: string;
  knownCorePeerIds: Set<string>;
  lastKnownRequiredACKs?: number;
  getACKCandidatePeers: () => string[];
};

const CORE = ['core-1', 'core-2', 'core-3', 'core-4'];
const EDGE = ['edge-1', 'edge-2'];

async function buildAgent(opts: {
  confirmedCores: string[];
  connected: string[];
  lastKnownRequiredACKs?: number;
}): Promise<AgentInternals> {
  const agent = await DKGAgent.create({
    name: 'AckPoolProbe',
    store: new OxigraphStore(),
    chainAdapter: new MockChainAdapter(),
  });
  const internals = agent as unknown as AgentInternals;
  internals.node = {
    libp2p: { getPeers: () => opts.connected.map((id) => ({ toString: () => id })) },
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
      libp2p: { getPeers: () => [self, ...CORE.slice(0, 3)].map((id) => ({ toString: () => id })) },
    };
    expect(a.getACKCandidatePeers()).not.toContain(self);
  });
});
