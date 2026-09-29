import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKGQueryEngine } from '@origintrail-official/dkg-query';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  DiscoveryClient,
  MAX_CORE_AGENT_PEER_HINTS,
} from '../src/discovery.js';
import { AGENT_REGISTRY_GRAPH, buildAgentProfile } from '../src/profile.js';

const DKG = 'https://dkg.network/ontology#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const WALLET_A = '0x00000000000000000000000000000000000000a1';
const WALLET_B = '0x00000000000000000000000000000000000000b2';
const WALLET_C = '0x00000000000000000000000000000000000000c3';
const WALLET_D = '0x00000000000000000000000000000000000000d4';

const stores: OxigraphStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

function fixture() {
  const store = new OxigraphStore();
  stores.push(store);
  const engine = new DKGQueryEngine(store);
  return { store, engine, discovery: new DiscoveryClient(engine) };
}

const profile = (options: {
  peerId: string;
  agentAddress?: string;
  nodeRole?: 'core' | 'edge';
  lastSeen?: string;
}) => buildAgentProfile({
  name: options.peerId,
  skills: [],
  nodeRole: options.nodeRole ?? 'core',
  ...options,
}).quads;

describe('DiscoveryClient.findCoreAgentPeerHints', () => {
  it('returns core-role bindings freshest first, with unbound profiles never reaching the consumer', async () => {
    const { store, discovery } = fixture();
    await store.insert([
      ...profile({ peerId: 'peer-old', agentAddress: WALLET_A, lastSeen: '2026-01-01T00:00:00.000Z' }),
      ...profile({ peerId: 'peer-fresh', agentAddress: WALLET_B, lastSeen: '2026-09-30T00:00:00.000Z' }),
      ...profile({ peerId: 'peer-mid', agentAddress: WALLET_C, lastSeen: '2026-06-01T00:00:00.000Z' }),
      // No operational wallet at all: cannot match the required pattern.
      ...profile({ peerId: 'peer-no-wallet', lastSeen: '2026-09-30T12:00:00.000Z' }),
      // An edge-role profile is outside the cost filter, however well bound.
      ...profile({ peerId: 'peer-edge', agentAddress: WALLET_D, nodeRole: 'edge', lastSeen: '2026-09-30T12:00:00.000Z' }),
    ]);

    const hints = await discovery.findCoreAgentPeerHints({ limit: 10 });

    expect(hints.map((hint) => hint.peerId)).toEqual(['peer-fresh', 'peer-mid', 'peer-old']);
    expect(hints[0]).toMatchObject({
      peerId: 'peer-fresh',
      agentAddress: expect.stringMatching(/^0x/i),
      lastSeen: '2026-09-30T00:00:00.000Z',
    });
    expect(hints.every((hint) => hint.agentAddress.length > 0)).toBe(true);
  });

  it('hands an empty or malformed wallet literal to the consumer, which must reject it', async () => {
    const { store, discovery } = fixture();
    await store.insert([
      { subject: 'did:dkg:agent:empty', predicate: RDF_TYPE, object: `${DKG}Agent`, graph: AGENT_REGISTRY_GRAPH },
      { subject: 'did:dkg:agent:empty', predicate: `${DKG}peerId`, object: '"peer-empty"', graph: AGENT_REGISTRY_GRAPH },
      { subject: 'did:dkg:agent:empty', predicate: `${DKG}nodeRole`, object: '"core"', graph: AGENT_REGISTRY_GRAPH },
      { subject: 'did:dkg:agent:empty', predicate: `${DKG}agentAddress`, object: '""', graph: AGENT_REGISTRY_GRAPH },
    ]);
    expect(await discovery.findCoreAgentPeerHints({ limit: 5 })).toEqual([
      { peerId: 'peer-empty', agentAddress: '' },
    ]);
  });

  it('collapses a profile carrying several lastSeen rows into one binding using the newest', async () => {
    const { store, discovery } = fixture();
    await store.insert([
      ...profile({ peerId: 'peer-heartbeat', agentAddress: WALLET_A, lastSeen: '2026-01-01T00:00:00.000Z' }),
      { subject: `did:dkg:agent:${WALLET_A}`, predicate: `${DKG}lastSeen`, object: '"2026-09-30T00:00:00.000Z"', graph: AGENT_REGISTRY_GRAPH },
    ]);
    expect(await discovery.findCoreAgentPeerHints({ limit: 5 })).toEqual([
      { peerId: 'peer-heartbeat', agentAddress: expect.any(String), lastSeen: '2026-09-30T00:00:00.000Z' },
    ]);
  });

  it('returns every peer that profiles bind to one wallet', async () => {
    const { store, discovery } = fixture();
    // Profiles are keyed by wallet, so two peers claiming it share one subject.
    await store.insert([
      ...profile({ peerId: 'peer-x', agentAddress: WALLET_A, lastSeen: '2026-01-01T00:00:00.000Z' }),
      ...profile({ peerId: 'peer-y', agentAddress: WALLET_A, lastSeen: '2026-09-30T00:00:00.000Z' }),
    ]);
    const hints = await discovery.findCoreAgentPeerHints({ limit: 10 });
    expect(hints.map((hint) => hint.peerId).sort()).toEqual(['peer-x', 'peer-y']);
  });

  it('ranks a profile without any lastSeen last and keeps the read within its limit', async () => {
    const { store, discovery } = fixture();
    const undated = profile({ peerId: 'peer-undated', agentAddress: WALLET_A }).filter(
      (quad) => quad.predicate !== `${DKG}lastSeen`,
    );
    await store.insert([
      ...undated,
      ...profile({ peerId: 'peer-dated', agentAddress: WALLET_B, lastSeen: '2026-01-01T00:00:00.000Z' }),
    ]);
    const all = await discovery.findCoreAgentPeerHints({ limit: 5 });
    expect(all.map((hint) => hint.peerId)).toEqual(['peer-dated', 'peer-undated']);
    expect(all[1]).not.toHaveProperty('lastSeen');
    expect((await discovery.findCoreAgentPeerHints({ limit: 1 })).map((hint) => hint.peerId))
      .toEqual(['peer-dated']);
  });

  it.each([0, -1, 1.5, Number.NaN, MAX_CORE_AGENT_PEER_HINTS + 1])(
    'refuses the unbounded or malformed limit %s',
    async (limit) => {
      const { discovery } = fixture();
      await expect(discovery.findCoreAgentPeerHints({ limit })).rejects.toThrow(RangeError);
    },
  );

  it('honours an already-aborted caller', async () => {
    const { discovery } = fixture();
    await expect(discovery.findCoreAgentPeerHints({ limit: 1, signal: AbortSignal.abort(new Error('gone')) }))
      .rejects.toThrow('gone');
  });

  it('refuses an engine that ignores the row limit', async () => {
    const { engine, discovery } = fixture();
    vi.spyOn(engine, 'query').mockResolvedValue({
      bindings: [
        { peerId: '"a"', agentAddress: '"0x1"' },
        { peerId: '"b"', agentAddress: '"0x2"' },
      ],
    } as never);
    await expect(discovery.findCoreAgentPeerHints({ limit: 1 })).rejects.toThrow('exceeded its row limit');
  });

  it('drops a row with no peer id and reads the stored literals', async () => {
    const { engine, discovery } = fixture();
    const query = vi.spyOn(engine, 'query').mockResolvedValue({
      bindings: [
        { peerId: '""', agentAddress: '"0x1"' },
        { agentAddress: '"0x2"' },
        { peerId: '"peer-ok"', agentAddress: '"0x3"', lastSeen: '"2026-09-30T00:00:00.000Z"' },
        { peerId: '"peer-no-address"' },
      ],
    } as never);
    expect(await discovery.findCoreAgentPeerHints({ limit: 10 })).toEqual([
      { peerId: 'peer-ok', agentAddress: '0x3', lastSeen: '2026-09-30T00:00:00.000Z' },
      { peerId: 'peer-no-address', agentAddress: '' },
    ]);
    const [sparql, options] = query.mock.calls[0]!;
    expect(sparql).toContain('GROUP BY ?peerId ?agentAddress');
    expect(sparql).toContain('LIMIT 10');
    expect(options).toMatchObject({ contextGraphId: 'agents' });
  });
});

describe('a curator wallet never resolves to a profile that binds no wallet', () => {
  it('matches only profiles whose stored agentAddress is that wallet', async () => {
    const { store, discovery } = fixture();
    await store.insert([
      ...profile({ peerId: 'peer-bound', agentAddress: WALLET_A }),
      // Same peer, no wallet: the registry query cannot reach it by address.
      ...profile({ peerId: 'peer-unbound' }),
      { subject: 'did:dkg:agent:empty', predicate: RDF_TYPE, object: `${DKG}Agent`, graph: AGENT_REGISTRY_GRAPH },
      { subject: 'did:dkg:agent:empty', predicate: `${DKG}peerId`, object: '"peer-empty"', graph: AGENT_REGISTRY_GRAPH },
      { subject: 'did:dkg:agent:empty', predicate: `${DKG}agentAddress`, object: '""', graph: AGENT_REGISTRY_GRAPH },
    ]);

    await expect(discovery.findAgentPeerPageByAddress(WALLET_A, { limit: 10 }))
      .resolves.toEqual({ peerIds: ['peer-bound'], nextAfterPeerId: null });
    // A profile whose wallet is the empty literal is matched by no lookup, not even an empty one.
    for (const empty of ['', '   ']) {
      await expect(discovery.findAgentPeerPageByAddress(empty, { limit: 10 }))
        .resolves.toEqual({ peerIds: [], nextAfterPeerId: null });
    }
    const rich = await discovery.findAgents({ agentAddress: WALLET_A });
    expect(rich.map((agent) => agent.peerId)).toEqual(['peer-bound']);
    // Every profile the unfiltered read returns says which wallet it binds, or none.
    const every = await discovery.findAgents();
    expect(every.find((agent) => agent.peerId === 'peer-unbound')?.agentAddress).toBeUndefined();
  });
});
