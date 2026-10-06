import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKGQueryEngine } from '@origintrail-official/dkg-query';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  DiscoveryClient,
  MAX_CORE_AGENT_PEER_HINT_PAGE_SIZE,
  type CoreAgentPeerHint,
  type CoreAgentPeerHintCursor,
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

/** A core-role profile written straight into the registry, however malformed its wallet. */
const rawProfile = (subject: string, peerId: string, agentAddress: string) => [
  { subject, predicate: RDF_TYPE, object: `${DKG}Agent`, graph: AGENT_REGISTRY_GRAPH },
  { subject, predicate: `${DKG}peerId`, object: JSON.stringify(peerId), graph: AGENT_REGISTRY_GRAPH },
  { subject, predicate: `${DKG}nodeRole`, object: '"core"', graph: AGENT_REGISTRY_GRAPH },
  { subject, predicate: `${DKG}agentAddress`, object: JSON.stringify(agentAddress), graph: AGENT_REGISTRY_GRAPH },
];

const wallet = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

describe('DiscoveryClient.findCoreAgentPeerHintPage', () => {
  it('returns core-role bindings in wallet then peer order, whatever their lastSeen claims', async () => {
    const { store, discovery } = fixture();
    await store.insert([
      ...profile({ peerId: 'peerOld', agentAddress: WALLET_A, lastSeen: '2026-01-01T00:00:00.000Z' }),
      ...profile({ peerId: 'peerFresh', agentAddress: WALLET_B, lastSeen: '2026-09-30T00:00:00.000Z' }),
      ...profile({ peerId: 'peerMid', agentAddress: WALLET_C, lastSeen: '2026-06-01T00:00:00.000Z' }),
      // No operational wallet at all: cannot match the required pattern.
      ...profile({ peerId: 'peerNoWallet', lastSeen: '2026-09-30T12:00:00.000Z' }),
      // An edge-role profile is outside the cost filter, however well bound.
      ...profile({ peerId: 'peerEdge', agentAddress: WALLET_D, nodeRole: 'edge', lastSeen: '2026-09-30T12:00:00.000Z' }),
    ]);

    const page = await discovery.findCoreAgentPeerHintPage({ limit: 10 });

    // The freshest claim does not lead: nothing a profile says about itself picks its place.
    expect(page.hints.map((hint) => hint.peerId)).toEqual(['peerOld', 'peerFresh', 'peerMid']);
    expect(page.next).toBeNull();
    expect(page.hints[1]).toMatchObject({
      peerId: 'peerFresh',
      agentAddress: expect.stringMatching(/^0x/i),
      lastSeen: '2026-09-30T00:00:00.000Z',
    });
    expect(page.hints.every((hint) => hint.agentAddress.length > 0)).toBe(true);
  });

  it('never lets a row that binds no well-formed wallet occupy a slot', async () => {
    const { store, discovery } = fixture();
    await store.insert([
      ...rawProfile('did:dkg:agent:empty', 'peerEmptyWallet', ''),
      ...rawProfile('did:dkg:agent:blank', 'peerBlankWallet', '   '),
      ...rawProfile('did:dkg:agent:short', 'peerShortWallet', '0x1234'),
      ...rawProfile('did:dkg:agent:nothex', 'peerNotHexWallet', `0x${'z'.repeat(40)}`),
      ...rawProfile('did:dkg:agent:long', 'peerLongWallet', `${WALLET_A}00`),
      ...profile({ peerId: 'peerGood', agentAddress: WALLET_A }),
    ]);
    const page = await discovery.findCoreAgentPeerHintPage({ limit: 2 });
    expect(page.hints.map((hint) => hint.peerId)).toEqual(['peerGood']);
    expect(page.next).toBeNull();
  });

  it('never lets a row with an unusable peer id occupy a slot or break the cursor', async () => {
    const { store, discovery } = fixture();
    await store.insert([
      ...rawProfile('did:dkg:agent:quote', 'peer"quote', WALLET_A),
      ...rawProfile('did:dkg:agent:slash', 'peer\\slash', WALLET_A),
      ...rawProfile('did:dkg:agent:space', 'peer space', WALLET_A),
      ...rawProfile('did:dkg:agent:long', 'p'.repeat(129), WALLET_A),
      ...rawProfile('did:dkg:agent:empty', '', WALLET_A),
      ...profile({ peerId: 'peerAlpha', agentAddress: WALLET_A }),
      ...profile({ peerId: 'peerBeta', agentAddress: WALLET_B }),
    ]);
    const first = await discovery.findCoreAgentPeerHintPage({ limit: 1 });
    expect(first.hints.map((hint) => hint.peerId)).toEqual(['peerAlpha']);
    const second = await discovery.findCoreAgentPeerHintPage({ limit: 1, after: first.next! });
    expect(second.hints.map((hint) => hint.peerId)).toEqual(['peerBeta']);
    expect(second.next).toBeNull();
  });

  it('collapses a profile carrying several lastSeen rows into one binding using the newest', async () => {
    const { store, discovery } = fixture();
    await store.insert([
      ...profile({ peerId: 'peerHeartbeat', agentAddress: WALLET_A, lastSeen: '2026-01-01T00:00:00.000Z' }),
      { subject: `did:dkg:agent:${WALLET_A}`, predicate: `${DKG}lastSeen`, object: '"2026-09-30T00:00:00.000Z"', graph: AGENT_REGISTRY_GRAPH },
    ]);
    expect((await discovery.findCoreAgentPeerHintPage({ limit: 5 })).hints).toEqual([
      { peerId: 'peerHeartbeat', agentAddress: expect.any(String), lastSeen: '2026-09-30T00:00:00.000Z' },
    ]);
  });

  it('returns every peer that profiles bind to one wallet', async () => {
    const { store, discovery } = fixture();
    // Profiles are keyed by wallet, so two peers claiming it share one subject.
    await store.insert([
      ...profile({ peerId: 'peerX', agentAddress: WALLET_A, lastSeen: '2026-01-01T00:00:00.000Z' }),
      ...profile({ peerId: 'peerY', agentAddress: WALLET_A, lastSeen: '2026-09-30T00:00:00.000Z' }),
    ]);
    const { hints } = await discovery.findCoreAgentPeerHintPage({ limit: 10 });
    expect(hints.map((hint) => hint.peerId)).toEqual(['peerX', 'peerY']);
  });

  it('carries a profile without any lastSeen and keeps the read within its limit', async () => {
    const { store, discovery } = fixture();
    const undated = profile({ peerId: 'peerUndated', agentAddress: WALLET_A }).filter(
      (quad) => quad.predicate !== `${DKG}lastSeen`,
    );
    await store.insert([
      ...undated,
      ...profile({ peerId: 'peerDated', agentAddress: WALLET_B, lastSeen: '2026-01-01T00:00:00.000Z' }),
    ]);
    const all = await discovery.findCoreAgentPeerHintPage({ limit: 5 });
    expect(all.hints.map((hint) => hint.peerId)).toEqual(['peerUndated', 'peerDated']);
    expect(all.hints[0]).not.toHaveProperty('lastSeen');
    expect((await discovery.findCoreAgentPeerHintPage({ limit: 1 })).hints.map((hint) => hint.peerId))
      .toEqual(['peerUndated']);
  });

  describe('keyset paging', () => {
    async function seeded(count: number) {
      const f = fixture();
      const quads = [];
      for (let i = 0; i < count; i += 1) {
        quads.push(...profile({
          peerId: `peer${String(i).padStart(4, '0')}`,
          agentAddress: wallet(0x100 + (i % 7)),
          // Deliberately anti-correlated with the order: the newest claims sort last.
          lastSeen: new Date(Date.UTC(2020, 0, 1 + i)).toISOString(),
        }));
      }
      await f.store.insert(quads);
      return f;
    }

    async function walk(discovery: DiscoveryClient, limit: number): Promise<CoreAgentPeerHint[]> {
      const all: CoreAgentPeerHint[] = [];
      let after: CoreAgentPeerHintCursor | undefined;
      for (let pages = 0; pages < 100; pages += 1) {
        const page = await discovery.findCoreAgentPeerHintPage({ limit, ...(after === undefined ? {} : { after }) });
        expect(page.hints.length).toBeLessThanOrEqual(limit);
        all.push(...page.hints);
        if (page.next === null) return all;
        after = page.next;
      }
      throw new Error('the walk did not end');
    }

    it('walks every row exactly once, in a fixed order', async () => {
      const { discovery } = await seeded(23);
      const paged = await walk(discovery, 5);
      const whole = (await discovery.findCoreAgentPeerHintPage({ limit: 100 })).hints;
      expect(paged).toEqual(whole);
      expect(paged).toHaveLength(23);
      expect(new Set(paged.map((hint) => `${hint.agentAddress}|${hint.peerId}`)).size).toBe(23);
      const keys = paged.map((hint) => `${hint.agentAddress}|${hint.peerId}`);
      expect(keys).toEqual([...keys].sort());
    });

    it('orders by code point and resumes by the same order, however wallets and peer ids mix case', async () => {
      // The resume filter and the ORDER BY must agree on ONE string order, and the resolver's own
      // cursor arithmetic assumes it is code point order: upper case before lower case, digits
      // before both. A locale collation (a < A < b) would skip or repeat rows at a page boundary.
      const { store, discovery } = fixture();
      const alphabet = 'ABCDEFabcdef0123456789';
      let seed = 2928;
      const next = (bound: number): number => {
        seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
        return Math.floor((seed / 4_294_967_296) * bound);
      };
      const mixedCase = (length: number, letters: string): string => (
        Array.from({ length }, () => letters[next(letters.length)]!).join('')
      );
      const expected = new Set<string>();
      const quads = [];
      for (let index = 0; index < 50; index += 1) {
        // One wallet spelled twice (two profiles) plus a case twin: same bytes, sorted apart by code point.
        const spelled = `0x${mixedCase(40, alphabet)}`;
        const twin = `0x${spelled.slice(2).replace(/[a-fA-F]/, (letter) => (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()))}`;
        for (const [copy, address] of [spelled, twin].entries()) {
          for (let peer = 0; peer < 1 + next(4); peer += 1) {
            const peerId = mixedCase(40 + next(20), 'ABCabc0123');
            expected.add(`${address}\0${peerId}`);
            quads.push(...rawProfile(`did:dkg:agent:mix${index}-${copy}-${peer}`, peerId, address));
          }
        }
      }
      await store.insert(quads);
      const order = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
      const wanted = [...expected].sort((left, right) => order(left, right));
      // Boundaries fall between rows that share a wallet for every page size here.
      for (const limit of [2, 3, 5, 8, 50]) {
        const rows: string[] = [];
        let after: CoreAgentPeerHintCursor | undefined;
        for (let pages = 0; pages < 500; pages += 1) {
          const page = await discovery.findCoreAgentPeerHintPage({ limit, ...(after === undefined ? {} : { after }) });
          rows.push(...page.hints.map((hint) => `${hint.agentAddress}\0${hint.peerId}`));
          if (page.next === null) break;
          after = page.next;
        }
        expect(rows, `page size ${limit}`).toEqual(wanted);
      }
      expect(wanted.some((row, index) => index > 0 && row.split('\0')[0] === wanted[index - 1]!.split('\0')[0])).toBe(true);
    });

    it('names the last row of a full page as the cursor, and none when the page ends the phonebook', async () => {
      const { discovery } = await seeded(6);
      const first = await discovery.findCoreAgentPeerHintPage({ limit: 3 });
      expect(first.hints).toHaveLength(3);
      expect(first.next).toEqual({ agentAddress: first.hints[2]!.agentAddress, peerId: first.hints[2]!.peerId });
      const exact = await discovery.findCoreAgentPeerHintPage({ limit: 6 });
      expect(exact.hints).toHaveLength(6);
      expect(exact.next).toBeNull();
    });

    it('is not disturbed by rows that arrive between pages: nothing seen is repeated or skipped', async () => {
      const { store, discovery } = await seeded(12);
      const before = (await discovery.findCoreAgentPeerHintPage({ limit: 100 })).hints;
      const first = await discovery.findCoreAgentPeerHintPage({ limit: 4 });
      // Rows that sort before, inside and after the cursor arrive mid-walk.
      await store.insert([
        ...profile({ peerId: 'peerEarly', agentAddress: wallet(1) }),
        ...profile({ peerId: 'peerInside', agentAddress: first.hints[3]!.agentAddress }),
        ...profile({ peerId: 'peerLate', agentAddress: wallet(0xfff) }),
      ]);
      const rest: CoreAgentPeerHint[] = [];
      let after = first.next;
      while (after !== null) {
        const page = await discovery.findCoreAgentPeerHintPage({ limit: 4, after });
        rest.push(...page.hints);
        after = page.next;
      }
      const seen = [...first.hints, ...rest];
      // Every row that existed before the walk is seen exactly once, in order.
      const key = (hint: CoreAgentPeerHint) => `${hint.agentAddress}|${hint.peerId}`;
      expect(seen.filter((hint) => before.some((old) => key(old) === key(hint))).map(key)).toEqual(before.map(key));
      expect(new Set(seen.map(key)).size).toBe(seen.length);
    });

    it('reads a page in one bounded keyset query: no OFFSET, one lookahead row, the cursor as a filter', async () => {
      const { engine, discovery } = fixture();
      const query = vi.spyOn(engine, 'query').mockResolvedValue({ bindings: [] } as never);
      await discovery.findCoreAgentPeerHintPage({
        limit: 7,
        after: { agentAddress: WALLET_B, peerId: 'peerBeta' },
      });
      const [sparql, options] = query.mock.calls[0]!;
      expect(sparql).not.toMatch(/OFFSET/i);
      expect(sparql).toContain('LIMIT 8');
      expect(sparql).toContain('GROUP BY ?peerId ?agentAddress');
      expect(sparql).toContain('ORDER BY ASC(STR(?agentAddress)) ASC(STR(?peerId))');
      expect(sparql).toContain(`STR(?agentAddress) > "${WALLET_B}"`);
      expect(sparql).toContain('STR(?peerId) > "peerBeta"');
      expect(options).toMatchObject({ contextGraphId: 'agents' });
    });
  });

  it.each([0, -1, 1.5, Number.NaN, MAX_CORE_AGENT_PEER_HINT_PAGE_SIZE + 1])(
    'refuses the unbounded or malformed page size %s',
    async (limit) => {
      const { discovery } = fixture();
      await expect(discovery.findCoreAgentPeerHintPage({ limit })).rejects.toThrow(RangeError);
    },
  );

  it.each([
    { agentAddress: '', peerId: 'peerA' },
    { agentAddress: WALLET_A, peerId: '' },
  ])('refuses the malformed cursor %j', async (after) => {
    const { discovery } = fixture();
    await expect(discovery.findCoreAgentPeerHintPage({ limit: 1, after })).rejects.toThrow(TypeError);
  });

  it('honours an already-aborted caller', async () => {
    const { discovery } = fixture();
    await expect(discovery.findCoreAgentPeerHintPage({ limit: 1, signal: AbortSignal.abort(new Error('gone')) }))
      .rejects.toThrow('gone');
  });

  it('refuses an engine that ignores the row limit', async () => {
    const { engine, discovery } = fixture();
    vi.spyOn(engine, 'query').mockResolvedValue({
      bindings: [
        { peerId: '"a"', agentAddress: '"0x1"' },
        { peerId: '"b"', agentAddress: '"0x2"' },
        { peerId: '"c"', agentAddress: '"0x3"' },
      ],
    } as never);
    await expect(discovery.findCoreAgentPeerHintPage({ limit: 1 })).rejects.toThrow('exceeded its row limit');
  });

  it('drops a binding row with no peer id or wallet and reads the stored literals', async () => {
    const { engine, discovery } = fixture();
    vi.spyOn(engine, 'query').mockResolvedValue({
      bindings: [
        { peerId: '""', agentAddress: '"0x1"' },
        { agentAddress: '"0x2"' },
        { peerId: '"peerOk"', agentAddress: '"0x3"', lastSeen: '"2026-09-30T00:00:00.000Z"' },
        { peerId: '"peerNoAddress"' },
      ],
    } as never);
    const page = await discovery.findCoreAgentPeerHintPage({ limit: 10 });
    expect(page.hints).toEqual([
      { peerId: 'peerOk', agentAddress: '0x3', lastSeen: '2026-09-30T00:00:00.000Z' },
    ]);
    expect(page.next).toBeNull();
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
