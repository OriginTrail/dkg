import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKGQueryEngine } from '@origintrail-official/dkg-query';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DiscoveryClient } from '../src/discovery.js';
import { buildAgentProfile } from '../src/profile.js';
import { MAX_AGENT_PEER_PAGE_SIZE } from '../src/agent-peer-discovery.js';
import { MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS } from '../src/dkg-agent-constants.js';

describe('DiscoveryClient curator peer pagination', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });
  function fixture() {
    const store = new OxigraphStore();
    stores.push(store);
    const engine = new DKGQueryEngine(store);
    return { store, engine, discovery: new DiscoveryClient(engine) };
  }
  it('queries distinct peer IDs in deterministic exclusive-cursor order', async () => {
    const { engine, discovery } = fixture();
    const query = vi.spyOn(engine, 'query').mockResolvedValue({
      bindings: [
        { peerId: '"peer-011"' },
        { peerId: '"peer-012"' },
      ],
    });

    await expect(discovery.findAgentPeerIdsByAddress(
      '0xabc',
      { afterPeerId: 'peer-010', limit: 2 },
    )).resolves.toEqual({ peerIds: ['peer-011', 'peer-012'], nextAfterPeerId: null });

    const [sparql, options] = query.mock.calls[0]!;
    expect(sparql).toContain('SELECT DISTINCT (STR(?storedPeerId) AS ?peerId)');
    expect(sparql).toContain('FILTER(STR(?storedPeerId) > "peer-010")');
    expect(sparql).toContain('ORDER BY ASC(STR(?peerId))');
    expect(sparql).toContain('LIMIT 3');
    expect(options).toMatchObject({ contextGraphId: 'agents' });
  });

  it('pages real agent-registry data without duplicate profile rows', async () => {
    const store = new OxigraphStore();
    const curator = '0x00000000000000000000000000000000000000ab';
    try {
      const first = buildAgentProfile({
        peerId: 'peer-001', name: 'First', agentAddress: curator, skills: [],
      });
      const second = buildAgentProfile({
        peerId: 'peer-002', name: 'Second', agentAddress: curator, skills: [],
      });
      await store.insert([...first.quads, ...second.quads]);
      const discovery = new DiscoveryClient(new DKGQueryEngine(store));

      await expect(discovery.findAgentPeerIdsByAddress(curator, { limit: 1 }))
        .resolves.toEqual({ peerIds: ['peer-001'], nextAfterPeerId: 'peer-001' });
      await expect(discovery.findAgentPeerIdsByAddress(
        curator,
        { afterPeerId: 'peer-001', limit: 2 },
      )).resolves.toEqual({ peerIds: ['peer-002'], nextAfterPeerId: null });
    } finally {
      await store.close();
    }
  });

  it('matches legacy mixed-case EVM wallet rows case-insensitively', async () => {
    const store = new OxigraphStore();
    const lowerAddress = '0xabcdef00000000000000000000000000000000ab';
    const mixedAddress = '0xAbCdEf00000000000000000000000000000000aB';
    try {
      const profile = buildAgentProfile({
        peerId: 'peer-checksum', name: 'Checksum Curator', agentAddress: lowerAddress, skills: [],
      });
      const legacyQuads = profile.quads.map((quad) => (
        quad.predicate === 'https://dkg.network/ontology#agentAddress'
          ? { ...quad, object: `"${mixedAddress}"` }
          : quad
      ));
      await store.insert(legacyQuads);
      const discovery = new DiscoveryClient(new DKGQueryEngine(store));

      await expect(discovery.findAgentPeerIdsByAddress(lowerAddress, { limit: 1 }))
        .resolves.toEqual({ peerIds: ['peer-checksum'], nextAfterPeerId: null });
    } finally {
      await store.close();
    }
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_AGENT_PEER_PAGE_SIZE + 1])(
    'rejects invalid limit %s before a store query', async limit => {
      const { engine, discovery } = fixture();
      const query = vi.spyOn(engine, 'query');
      await expect(discovery.findAgentPeerIdsByAddress('curator', { limit })).rejects.toThrow(RangeError);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('bounds every page despite optional-profile multiplicity and RDF peer-ID aliases', async () => {
    const { store, engine, discovery } = fixture();
    const wallet = '0x00000000000000000000000000000000000000ab';
    const expected = Array.from({ length: MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS + 17 }, (_, i) => `peer-${String(i).padStart(4, '0')}`);
    for (const peerId of expected) {
      const profile = buildAgentProfile({ peerId, name: peerId, agentAddress: wallet, skills: [] });
      const identity = profile.quads.find(q => q.predicate.endsWith('#peerId'))!;
      await store.insert([
        ...profile.quads,
        { ...identity, object: `"${peerId}"@en` },
        { ...identity, object: `"${peerId}"^^<http://www.w3.org/2001/XMLSchema#string>` },
        ...Array.from({ length: 40 }, (_, n) => ({
          ...identity, predicate: 'https://dkg.origintrail.io/skill#framework', object: `"framework-${n}"`,
        })),
      ]);
    }
    const query = vi.spyOn(engine, 'query');
    const observed: string[] = [];
    let afterPeerId: string | undefined;
    do {
      const page = await discovery.findAgentPeerIdsByAddress(wallet, { limit: 7, afterPeerId });
      expect(page.peerIds.length).toBeLessThanOrEqual(7);
      observed.push(...page.peerIds);
      afterPeerId = page.nextAfterPeerId ?? undefined;
    } while (afterPeerId);
    expect(observed).toEqual(expected);
    expect(query).toHaveBeenCalledTimes(Math.ceil(expected.length / 7));
    for (const call of query.mock.results) {
      const result = await call.value;
      expect(result.bindings.length).toBeLessThanOrEqual(8);
    }
  });

  it('cancels before querying and rejects late query results after cancellation', async () => {
    const { engine, discovery } = fixture();
    const controller = new AbortController();
    const query = vi.spyOn(engine, 'query');
    controller.abort();
    await expect(discovery.findAgentPeerIdsByAddress('curator', { limit: 1, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(query).not.toHaveBeenCalled();

    const active = new AbortController();
    let settle!: (value: { bindings: Array<Record<string, string>> }) => void;
    query.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    const pending = discovery.findAgentPeerIdsByAddress('curator', { limit: 1, signal: active.signal });
    expect(query.mock.calls[0][1]?.signal).toBe(active.signal);
    active.abort();
    settle({ bindings: [{ peerId: 'peer-001' }] });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('snapshots a caller-owned page request before awaiting the query', async () => {
    const { engine, discovery } = fixture();
    let settle!: (value: { bindings: Array<Record<string, string>> }) => void;
    vi.spyOn(engine, 'query').mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    const request = { limit: 1 };
    const pending = discovery.findAgentPeerIdsByAddress('curator', request);
    request.limit = 100;
    settle({ bindings: [{ peerId: 'peer-001' }, { peerId: 'peer-002' }] });
    await expect(pending).resolves.toEqual({ peerIds: ['peer-001'], nextAfterPeerId: 'peer-001' });
  });

  it('rejects a query engine that returns more than the requested lookahead bound', async () => {
    const { engine, discovery } = fixture();
    vi.spyOn(engine, 'query').mockResolvedValue({ bindings: [
      { peerId: 'peer-001' }, { peerId: 'peer-002' }, { peerId: 'peer-003' },
    ] });
    await expect(discovery.findAgentPeerIdsByAddress('curator', { limit: 1 })).rejects.toThrow('row limit');
  });

});
