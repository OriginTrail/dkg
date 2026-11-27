import { describe, expect, it } from 'vitest';
import { SYSTEM_CONTEXT_GRAPHS, contextGraphDataUri } from '@origintrail-official/dkg-core';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';
import {
  annotateContextGraphListRows,
  contextGraphListFilterCacheKey,
  normalizeContextGraphListFilter,
  partitionWireOnlyContextGraphListRows,
  UNFILTERED_CONTEXT_GRAPH_LIST,
  type ContextGraphListFilter,
} from '../src/context-graph-list-filter.js';
import {
  toContextGraphListOnChainFacts,
  type ListContextGraphsRow,
} from '../src/context-graph-list-authority-enrichment.js';
import type { OnChainContextGraphFacts } from '../src/context-graph-storage-discovery.js';
import { Rfc64AuthorityReadCoordinatorV1 } from
  '../src/rfc64/authority-rpc-circuit-breaker-v1.js';

const CALLER_ADDRESS = '0x1111111111111111111111111111111111111111';
/** A named graph whose id only looks like a name hash. */
const HASH_LIKE_NAMED_ID = `0x${'aa'.repeat(32)}`;
/** A graph the node knows only by the name hash the chain committed. */
const WIRE_ONLY_ID = `0x${'bb'.repeat(32)}`;
/** A graph the node joined, registered on chain as id 7. */
const NAMED_ID = 'named-public';
const SYSTEM_ID = SYSTEM_CONTEXT_GRAPHS.ONTOLOGY;
/** Sorted, so both listing paths list the local rows in this order. */
const IDS = [HASH_LIKE_NAMED_ID, WIRE_ONLY_ID, NAMED_ID, SYSTEM_ID];

const NAMED_FACTS: OnChainContextGraphFacts = {
  onChainId: '7',
  nameHash: `0x${'dd'.repeat(32)}`,
  owner: `0x${'55'.repeat(20)}`,
  accessPolicy: 0,
  publishPolicy: 1,
  publishAuthority: null,
  createdAt: 1_780_000_000,
  active: true,
  observedAtBlock: 600,
};
const WIRE_ONLY_FACTS: OnChainContextGraphFacts = {
  onChainId: '9',
  nameHash: WIRE_ONLY_ID,
  owner: `0x${'22'.repeat(20)}`,
  accessPolicy: 1,
  publishPolicy: 0,
  publishAuthority: `0x${'33'.repeat(20)}`,
  createdAt: 1_790_000_000,
  active: true,
  observedAtBlock: 700,
};

/** The facts index, recording every on-chain id it is asked for. */
class RecordingFacts extends Map<string, OnChainContextGraphFacts> {
  readonly reads: string[] = [];
  override get(onChainId: string): OnChainContextGraphFacts | undefined {
    this.reads.push(onChainId);
    return super.get(onChainId);
  }
}

function projectedMeta(id: string) {
  return {
    id,
    uri: contextGraphDataUri(id),
    declared: true,
    isSystem: id === SYSTEM_ID,
    name: `local name of ${id}`,
    description: `local description of ${id}`,
    curator: 'did:dkg:agent:0x4444444444444444444444444444444444444444',
    creators: [],
    curators: [],
    allowedPeers: [],
    allowedAgents: [],
    participantAgents: [],
    participantIdentityIds: [],
    revokedAgents: [],
    subGraphs: [],
    hasAgentGate: false,
    hasPeerGate: false,
    hasLegacyParticipantGate: false,
    accessPolicy: id === WIRE_ONLY_ID ? 'private' : 'public',
  };
}

/** An agent whose every per-graph read is recorded as `<read>:<graph id or query>`. */
function fakeAgent() {
  const reads: string[] = [];
  const facts = new RecordingFacts([['7', NAMED_FACTS], ['9', WIRE_ONLY_FACTS]]);
  const record = <T>(read: string, value: T): T => {
    reads.push(read);
    return value;
  };
  const agent = {
    rfc64AuthorityReadCoordinatorV1: new Rfc64AuthorityReadCoordinatorV1(),
    subscribedContextGraphs: new Map<string, { onChainHash: string; onChainId: string; subscribed: boolean; synced: boolean }>([
      [NAMED_ID, { onChainHash: NAMED_FACTS.nameHash, onChainId: '7', subscribed: true, synced: true }],
      // The canonical setter's placeholder: it claims its own hash, and the
      // reverse index points back at it.
      [WIRE_ONLY_ID, { onChainHash: WIRE_ONLY_ID, onChainId: '9', subscribed: false, synced: false }],
    ]),
    wireIdToLocalCgId: new Map([
      [NAMED_FACTS.nameHash!, NAMED_ID],
      [WIRE_ONLY_ID, WIRE_ONLY_ID],
    ]),
    onChainContextGraphFacts: facts,
    contextGraphMetaProjection: {
      listDeclaredContextGraphIds: async () => IDS,
    },
    store: {
      query: async (sparql: string) => record(`query:${sparql}`, {
        type: 'bindings' as const,
        // Every graph is declared in the ontology; no `_meta` lookup finds more.
        bindings: sparql.includes('/_meta>') ? [] : IDS.map((id) => ({
          ctxGraph: contextGraphDataUri(id),
          name: `"local name of ${id}"`,
          access: id === WIRE_ONLY_ID ? '"private"' : '"public"',
          ...(id === SYSTEM_ID ? { isSystem: 'true' } : {}),
        })),
      }),
      // The wire-only graph also has local storage.
      listGraphsByPrefix: async () => [contextGraphDataUri(WIRE_ONLY_ID)],
    },
    getCgMeta: async (id: string) => record(`meta:${id}`, projectedMeta(id)),
    contextGraphHasLocalContent: async (id: string) => record(`content:${id}`, true),
    getExplicitAccessPolicy: async (id: string) => record(`policy:${id}`, undefined),
    resolveFinalizedContextGraphAuthorityTargetsV1: async (ids: readonly string[]) => record(
      `finalized:${ids.join(',')}`,
      { kind: 'legacy-current' as const },
    ),
    readLocalContextGraphRegistrationStatus: async (id: string) => record(`registration:${id}`, null),
    getContextGraphOnChainId: async (id: string) => record(`onChainId:${id}`, undefined),
    getContextGraphCurator: async (id: string) => record(`curator:${id}`, undefined),
    isPrivateContextGraph: async (id: string) => record(`private:${id}`, id === WIRE_ONLY_ID),
    curatorDidMatchesChecksumAgent: () => false,
    callerIsAllowlistedAgentParticipant: async (id: string) => record(`allowlist:${id}`, false),
  };
  return { agent, reads, facts };
}

type ListingPath = 'default' | 'projection';

async function list(path: ListingPath, caller: string | null, filter?: ContextGraphListFilter) {
  const { agent, reads, facts } = fakeAgent();
  const rows: ListContextGraphsRow[] = path === 'default'
    ? (await (ContextGraphResolveMethods.prototype as any).listContextGraphsUncached.call(
      agent,
      caller,
      true,
      ...(filter === undefined ? [] : [normalizeContextGraphListFilter(filter)]),
    )).rows
    : await (ContextGraphResolveMethods.prototype.listContextGraphsFromProjection as any).call(
      agent,
      { callerAgentAddress: caller, ...(filter === undefined ? {} : { filter }) },
    );
  return { rows, reads, factReads: facts.reads };
}

const ids = (rows: readonly ListContextGraphsRow[]) => rows.map((row) => row.id);
const readsOf = (reads: readonly string[], id: string) => reads.filter((read) => read.includes(id));
const withoutOnChain = (rows: readonly ListContextGraphsRow[]) =>
  rows.map(({ onChain: _onChain, ...row }) => row);

describe('context graph list filter values', () => {
  it('lets only an exact boolean narrow the answer', () => {
    expect(normalizeContextGraphListFilter(undefined)).toEqual(UNFILTERED_CONTEXT_GRAPH_LIST);
    expect(normalizeContextGraphListFilter({})).toEqual(UNFILTERED_CONTEXT_GRAPH_LIST);
    expect(normalizeContextGraphListFilter({ namedOnly: true, includeSystem: false, includeOnChain: false }))
      .toEqual({ namedOnly: true, includeSystem: false, includeOnChain: false });
    expect(normalizeContextGraphListFilter({ namedOnly: 'true', includeSystem: 'false', includeOnChain: 0 } as any))
      .toEqual(UNFILTERED_CONTEXT_GRAPH_LIST);
  });

  it('keeps the unfiltered cache key and gives every other filter its own', () => {
    const keys = new Set<string>();
    for (const namedOnly of [false, true]) {
      for (const includeSystem of [false, true]) {
        for (const includeOnChain of [false, true]) {
          keys.add(contextGraphListFilterCacheKey({ namedOnly, includeSystem, includeOnChain }));
        }
      }
    }
    expect(keys.size).toBe(8);
    expect(contextGraphListFilterCacheKey(UNFILTERED_CONTEXT_GRAPH_LIST)).toBe('');
  });

  it('keeps a wire-only row, listed as not a system graph, when system graphs are left out', () => {
    const state = fakeAgent().agent;
    const row = (id: string): ListContextGraphsRow => ({
      id, uri: contextGraphDataUri(id), name: id, isSystem: true, subscribed: false, synced: false,
    });
    const filter = normalizeContextGraphListFilter({ includeSystem: false });
    const { local, wireOnly } = partitionWireOnlyContextGraphListRows([row(SYSTEM_ID), row(WIRE_ONLY_ID)], state, filter);
    expect(local).toEqual([]);
    expect(annotateContextGraphListRows(local, wireOnly, state, filter)).toEqual([
      { ...row(WIRE_ONLY_ID), isSystem: false, nameKnown: false },
    ]);
  });
});

describe('context graph listing with opt-in filters (#3919)', () => {
  for (const path of ['default', 'projection'] as const) {
    for (const caller of [null, CALLER_ADDRESS]) {
      const label = `${path} listing, ${caller ? 'wallet' : 'no wallet'}`;

      it(`lists the same rows with no filter, an empty one or every default spelled out (${label})`, async () => {
        const unfiltered = await list(path, caller);
        expect(ids(unfiltered.rows)).toEqual([HASH_LIKE_NAMED_ID, NAMED_ID, SYSTEM_ID, WIRE_ONLY_ID]);
        expect(unfiltered.rows.find((row) => row.id === NAMED_ID)).toMatchObject({
          name: `local name of ${NAMED_ID}`,
          nameKnown: true,
          onChainId: '7',
          onChain: toContextGraphListOnChainFacts(NAMED_FACTS),
        });
        expect(unfiltered.rows.find((row) => row.id === SYSTEM_ID)).toMatchObject({ isSystem: true, nameKnown: true });
        expect(unfiltered.rows.find((row) => row.id === WIRE_ONLY_ID)).toEqual({
          id: WIRE_ONLY_ID,
          uri: contextGraphDataUri(WIRE_ONLY_ID),
          name: WIRE_ONLY_ID,
          isSystem: false,
          subscribed: false,
          synced: false,
          onChainId: '9',
          nameKnown: false,
          onChain: toContextGraphListOnChainFacts(WIRE_ONLY_FACTS),
        });
        for (const filter of [{}, { namedOnly: false, includeSystem: true, includeOnChain: true }]) {
          expect((await list(path, caller, filter)).rows).toStrictEqual(unfiltered.rows);
        }
      });

      it(`lists only named graphs and reads nothing more about the others (${label})`, async () => {
        const unfiltered = await list(path, caller);
        // The control: an unfiltered listing reads the wire-only graph's metadata and facts.
        expect(readsOf(unfiltered.reads, WIRE_ONLY_ID)).toContain(`meta:${WIRE_ONLY_ID}`);
        expect(unfiltered.factReads).toContain('9');

        const named = await list(path, caller, { namedOnly: true });
        expect(named.rows).toStrictEqual(unfiltered.rows.filter((row) => row.nameKnown));
        expect(ids(named.rows)).toEqual([HASH_LIKE_NAMED_ID, NAMED_ID, SYSTEM_ID]);
        expect(readsOf(named.reads, WIRE_ONLY_ID)).toEqual([]);
        expect(named.factReads).not.toContain('9');
      });

      it(`leaves out system graphs before any caller lookup (${label})`, async () => {
        const unfiltered = await list(path, caller);
        const withoutSystem = await list(path, caller, { includeSystem: false });
        expect(withoutSystem.rows).toStrictEqual(unfiltered.rows.filter((row) => !row.isSystem));
        expect(ids(withoutSystem.rows)).toEqual([HASH_LIKE_NAMED_ID, NAMED_ID, WIRE_ONLY_ID]);
        expect(withoutSystem.reads).not.toContain(`allowlist:${SYSTEM_ID}`);
        // The control: with a wallet, an unfiltered listing looks the caller up on the system graph.
        expect(unfiltered.reads.includes(`allowlist:${SYSTEM_ID}`)).toBe(caller !== null);
      });

      it(`leaves the chain facts out without reading them (${label})`, async () => {
        const unfiltered = await list(path, caller);
        const noFacts = await list(path, caller, { includeOnChain: false });
        expect(noFacts.rows).toStrictEqual(withoutOnChain(unfiltered.rows));
        expect(noFacts.rows.some((row) => 'onChain' in row)).toBe(false);
        expect(noFacts.factReads).toEqual([]);
        // `onChainId` is not a chain fact; it stays.
        expect(noFacts.rows.find((row) => row.id === NAMED_ID)?.onChainId).toBe('7');
      });

      it(`combines the filters (${label})`, async () => {
        const unfiltered = await list(path, caller);
        const all = await list(path, caller, { namedOnly: true, includeSystem: false, includeOnChain: false });
        expect(all.rows).toStrictEqual(withoutOnChain(unfiltered.rows.filter((row) => row.nameKnown && !row.isSystem)));
        expect(ids(all.rows)).toEqual([HASH_LIKE_NAMED_ID, NAMED_ID]);
        expect(readsOf(all.reads, WIRE_ONLY_ID)).toEqual([]);
        expect(all.factReads).toEqual([]);

        const unnamedWithoutFacts = await list(path, caller, { includeSystem: false, includeOnChain: false });
        expect(ids(unnamedWithoutFacts.rows)).toEqual([HASH_LIKE_NAMED_ID, NAMED_ID, WIRE_ONLY_ID]);
        expect(unnamedWithoutFacts.rows.find((row) => row.id === WIRE_ONLY_ID)).toEqual({
          id: WIRE_ONLY_ID,
          uri: contextGraphDataUri(WIRE_ONLY_ID),
          name: WIRE_ONLY_ID,
          isSystem: false,
          subscribed: false,
          synced: false,
          onChainId: '9',
          nameKnown: false,
        });
      });
    }
  }
});

/** A host for the cached listing whose uncached listing names the filter it was given. */
function cachingAgent() {
  const calls: unknown[] = [];
  let release: (() => void) | undefined;
  const gate = { held: false };
  const agent = {
    listContextGraphsCacheAllowed: () => true,
    listContextGraphsCacheNow: () => 1_000,
    listContextGraphsCacheGeneration: 0,
    listContextGraphsCache: new Map<string, unknown>(),
    listContextGraphsInFlight: new Map<string, unknown>(),
    listContextGraphsUncached: async (checksum: string | null, scoped: boolean, filter: unknown) => {
      calls.push(filter);
      if (gate.held) await new Promise<void>((resolve) => { release = resolve; });
      const row: ListContextGraphsRow = {
        id: `listed with ${JSON.stringify(filter)} for ${checksum ?? 'no wallet'}`,
        uri: 'did:dkg:context-graph:x',
        name: String(scoped),
        isSystem: false,
        subscribed: false,
        synced: false,
      };
      return { rows: [row], cacheable: true };
    },
  };
  const listContextGraphs = (opts: Record<string, unknown>) =>
    ContextGraphResolveMethods.prototype.listContextGraphs.call(agent as any, opts as any);
  return { agent, calls, gate, listContextGraphs, release: () => release?.() };
}

describe('context graph list cache with opt-in filters', () => {
  it('keeps filtered and unfiltered answers apart for each caller', async () => {
    const { agent, calls, listContextGraphs } = cachingAgent();
    const unfiltered = await listContextGraphs({ callerAgentAddress: null });
    const named = await listContextGraphs({ callerAgentAddress: null, filter: { namedOnly: true } });
    const wallet = await listContextGraphs({ callerAgentAddress: CALLER_ADDRESS, filter: { includeOnChain: false } });
    expect(calls).toEqual([
      UNFILTERED_CONTEXT_GRAPH_LIST,
      { namedOnly: true, includeSystem: true, includeOnChain: true },
      { namedOnly: false, includeSystem: true, includeOnChain: false },
    ]);
    expect(named).not.toEqual(unfiltered);

    // Each answer comes back from its own entry; spelled-out defaults share the unfiltered one.
    expect(await listContextGraphs({ callerAgentAddress: null, filter: { namedOnly: true } })).toEqual(named);
    expect(await listContextGraphs({ callerAgentAddress: null })).toEqual(unfiltered);
    expect(await listContextGraphs({ callerAgentAddress: null, filter: {} })).toEqual(unfiltered);
    expect(await listContextGraphs({
      callerAgentAddress: null,
      filter: { namedOnly: false, includeSystem: true, includeOnChain: true },
    })).toEqual(unfiltered);
    expect(await listContextGraphs({ callerAgentAddress: CALLER_ADDRESS, filter: { includeOnChain: false } }))
      .toEqual(wallet);
    expect(calls).toHaveLength(3);
    expect([...agent.listContextGraphsCache.keys()].sort()).toEqual([
      'no-wallet',
      'no-wallet|named=true|system=true|onChain=true',
      'wallet:0x1111111111111111111111111111111111111111|named=false|system=true|onChain=false',
    ]);
  });

  it('never hands one filter an in-flight listing for another', async () => {
    const { calls, gate, listContextGraphs, release } = cachingAgent();
    gate.held = true;
    const unfiltered = listContextGraphs({ callerAgentAddress: null });
    await new Promise((resolve) => setImmediate(resolve));
    gate.held = false;
    const named = listContextGraphs({ callerAgentAddress: null, filter: { namedOnly: true } });
    const unfilteredAgain = listContextGraphs({ callerAgentAddress: null });
    release();
    const [first, second, third] = await Promise.all([unfiltered, named, unfilteredAgain]);
    expect(calls).toEqual([UNFILTERED_CONTEXT_GRAPH_LIST, { namedOnly: true, includeSystem: true, includeOnChain: true }]);
    expect(first[0]!.id).toContain('"namedOnly":false');
    expect(second[0]!.id).toContain('"namedOnly":true');
    expect(third).toEqual(first);
  });
});
