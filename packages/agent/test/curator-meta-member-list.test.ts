// SPDX-License-Identifier: Apache-2.0

/**
 * A node takes a graph's member list only from the graph's curator (#3421).
 *
 * A refresh from a peer the caller did not tie to the curator (the RFC-64
 * metadata bootstrap, a Core's hosted copy) installs the definition; the
 * member list it serves fills an empty one, and one the node holds stays as it
 * is, on both ways a store replaces the projection. A snapshot from a node tied
 * to the curator it names, and the curator refresh, replace the member list as
 * before. Each case checks the whole resulting projection.
 */
import {
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  DKG_ONTOLOGY,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  runCuratorMetaRefreshFromPeer,
  type CuratorMetaRefreshOptions,
} from '../src/curator-meta-refresh.js';
import {
  isMemberListQuad,
  memberListOf,
  readLocalMemberListRootRows,
  snapshotNamesCurator,
  withoutMemberList,
} from '../src/curator-meta-member-list.js';

const OWNER = new ethers.Wallet(`0x${'81'.repeat(32)}`).address.toLowerCase() as EvmAddressV1;
const HELD_MEMBER = new ethers.Wallet(`0x${'82'.repeat(32)}`).address.toLowerCase();
const SERVED_MEMBER = new ethers.Wallet(`0x${'83'.repeat(32)}`).address.toLowerCase();
const REVOKED = new ethers.Wallet(`0x${'84'.repeat(32)}`).address.toLowerCase();
const SERVING_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const HELD_PEER_ID = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const contextGraphId = `${OWNER}/member-list` as ContextGraphIdV1;
const metaGraph = contextGraphMetaGraphUri(contextGraphId);
const root = contextGraphDataGraphUri(contextGraphId);

const literal = (value: string) => JSON.stringify(value);
const rootRow = (predicate: string, object: string): Quad => ({ subject: root, predicate, object, graph: metaGraph });

function delegationRows(agent: string, peerId: string): Quad[] {
  const subject = `did:dkg:agent-delegation:${contextGraphId}:${agent}`;
  return [
    { subject, predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT, object: literal(agent), graph: metaGraph },
    { subject, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER, object: literal(peerId), graph: metaGraph },
  ];
}

function definition(curator?: string): Quad[] {
  return [
    rootRow(DKG_ONTOLOGY.RDF_TYPE, DKG_ONTOLOGY.DKG_CONTEXT_GRAPH),
    rootRow(DKG_ONTOLOGY.DKG_ACCESS_POLICY, literal('public')),
    ...(curator === undefined ? [] : [rootRow(DKG_ONTOLOGY.DKG_CURATOR, `did:dkg:agent:${curator}`)]),
  ];
}

/** The definition the node holds: told apart from the served one by its name. */
const HELD_DEFINITION: readonly Quad[] = Object.freeze([
  ...definition(OWNER),
  rootRow(DKG_ONTOLOGY.SCHEMA_NAME, literal('Held')),
]);

/** A member list the node took from the curator, with a revocation of its own. */
const HELD_MEMBER_LIST: readonly Quad[] = Object.freeze([
  rootRow(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, literal(HELD_MEMBER)),
  rootRow(DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT, literal(HELD_MEMBER)),
  rootRow(DKG_ONTOLOGY.DKG_ALLOWED_PEER, literal(HELD_PEER_ID)),
  rootRow(DKG_ONTOLOGY.DKG_REVOKED_AGENT, literal(REVOKED)),
  ...delegationRows(HELD_MEMBER, HELD_PEER_ID),
]);

/** The definition a peer serves, named apart from the held one. */
function servedDefinition(curator?: string): Quad[] {
  return [...definition(curator), rootRow(DKG_ONTOLOGY.SCHEMA_NAME, literal('Served'))];
}

/** What a peer serves: its definition with a member list of its own, which revokes the held member. */
function served(curator?: string): Quad[] {
  return [
    ...servedDefinition(curator),
    rootRow(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, literal(SERVED_MEMBER)),
    rootRow(DKG_ONTOLOGY.DKG_REVOKED_AGENT, literal(HELD_MEMBER)),
    ...delegationRows(SERVED_MEMBER, SERVING_PEER_ID),
  ];
}

/** The node's own revocation, which every replacement keeps. */
const LOCAL_REVOCATION = rootRow(DKG_ONTOLOGY.DKG_REVOKED_AGENT, literal(REVOKED));

const RELAYED: CuratorMetaRefreshOptions = Object.freeze({
  force: true,
  requirePublicDefinition: true,
  ignoreRegistrationBinding: true,
  expectedCuratorAddress: OWNER,
});

const stores: OxigraphStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

async function holding(rows: readonly Quad[]): Promise<OxigraphStore> {
  const store = new OxigraphStore();
  stores.push(store);
  await store.insert([...rows]);
  return store;
}

type ReplacementPath = 'subject replacement' | 'staged update';

/** The store as the refresh sees it: without subject replacement it stages and swaps in one update. */
function asSeenThrough(store: OxigraphStore, path: ReplacementPath): TripleStore {
  if (path === 'subject replacement') return store;
  return new Proxy(store, {
    get(target, property) {
      if (property === 'replaceSubject') return undefined;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A node that asks one peer, `SERVING_PEER_ID`, for the graph's metadata and gets `snapshot`. */
function refreshAgent(store: TripleStore, snapshot: readonly Quad[]) {
  return {
    metaRefreshTimestamps: new Map<string, number>(),
    runContextGraphSyncWithBackpressure: async <T>(
      _ctx: OperationContext,
      _contextGraphId: string,
      _lane: 'durable',
      _label: string,
      work: () => Promise<T>,
    ): Promise<T> => work(),
    peerId: 'local-peer',
    node: { libp2p: { getConnections: () => [{ remotePeer: { toString: () => SERVING_PEER_ID } }] } },
    discovery: {},
    fetchSyncPages: async () => ({
      quads: [...snapshot],
      checkpointKey: 'member-list-checkpoint',
      resumedFromOffset: 0,
      completed: true,
    }),
    store,
    oversizeTombstoneLog: { record: () => undefined },
    invalidateListContextGraphsCache: () => undefined,
    contextGraphMetaProjection: { markDirty: () => undefined },
    subscribedContextGraphs: new Map([[contextGraphId, {}]]),
    syncCheckpoints: new Map<string, number>(),
    log: { warn: vi.fn(), info: vi.fn() },
  };
}

async function metaRows(store: TripleStore): Promise<Quad[]> {
  const result = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`);
  if (result.type !== 'bindings') throw new Error('expected _meta bindings');
  return result.bindings.map((row) => ({ subject: row['s']!, predicate: row['p']!, object: row['o']!, graph: metaGraph }));
}

const key = (quad: Quad) => `${quad.subject} ${quad.predicate} ${quad.object}`;
const keysOf = (rows: readonly Quad[]) => [...new Set(rows.map(key))].sort();
const projectionOf = async (store: TripleStore) => keysOf(await metaRows(store));

describe.each(['subject replacement', 'staged update'] as const)('a node\'s member list through the %s', (path) => {
  it('stays as it is when a peer the caller did not tie to the curator serves the definition', async () => {
    const store = await holding([...HELD_DEFINITION, ...HELD_MEMBER_LIST]);
    const agent = refreshAgent(asSeenThrough(store, path), served(OWNER));

    await expect(runCuratorMetaRefreshFromPeer(agent, contextGraphId, SERVING_PEER_ID, RELAYED)).resolves.toBe(true);

    expect(await projectionOf(store)).toEqual(keysOf([...servedDefinition(OWNER), ...HELD_MEMBER_LIST]));
  });

  it('is filled from the served snapshot while the node holds none', async () => {
    const store = await holding([]);
    const agent = refreshAgent(asSeenThrough(store, path), served(OWNER));

    await expect(runCuratorMetaRefreshFromPeer(agent, contextGraphId, SERVING_PEER_ID, RELAYED)).resolves.toBe(true);

    expect(await projectionOf(store)).toEqual(keysOf(served(OWNER)));
  });

  it('is replaced by the member list of a node tied to the curator its snapshot names', async () => {
    const store = await holding(HELD_MEMBER_LIST);
    const agent = refreshAgent(asSeenThrough(store, path), served(OWNER));

    await expect(runCuratorMetaRefreshFromPeer(
      agent,
      contextGraphId,
      SERVING_PEER_ID,
      { ...RELAYED, acceptMemberList: true },
    )).resolves.toBe(true);

    expect(await projectionOf(store)).toEqual(keysOf([...served(OWNER), LOCAL_REVOCATION]));
  });

  it('stays as it is when the tied node\'s snapshot names no curator', async () => {
    const store = await holding([...HELD_DEFINITION, ...HELD_MEMBER_LIST]);
    const agent = refreshAgent(asSeenThrough(store, path), served());

    await expect(runCuratorMetaRefreshFromPeer(
      agent,
      contextGraphId,
      SERVING_PEER_ID,
      { ...RELAYED, acceptMemberList: true },
    )).resolves.toBe(true);

    expect(await projectionOf(store)).toEqual(keysOf([...servedDefinition(), ...HELD_MEMBER_LIST]));
  });

  it('is replaced by the curator refresh, as before', async () => {
    const store = await holding(HELD_MEMBER_LIST);
    const agent = refreshAgent(asSeenThrough(store, path), served(OWNER));

    await expect(runCuratorMetaRefreshFromPeer(agent, contextGraphId, SERVING_PEER_ID, { force: true }))
      .resolves.toBe(true);

    expect(await projectionOf(store)).toEqual(keysOf([...served(OWNER), LOCAL_REVOCATION]));
  });
});

describe('the member list rows of a graph', () => {
  it('are the allowlist, participants, allowed peers, revocations and delegations', () => {
    expect(withoutMemberList(contextGraphId, served(OWNER))).toEqual(servedDefinition(OWNER));
    expect(memberListOf(contextGraphId, served(OWNER))).toHaveLength(4);
    expect(HELD_MEMBER_LIST.every((quad) => isMemberListQuad(contextGraphId, quad))).toBe(true);
    expect(HELD_DEFINITION.some((quad) => isMemberListQuad(contextGraphId, quad))).toBe(false);
    // Another graph's delegations are not this graph's member list.
    const other = delegationRows(SERVED_MEMBER, SERVING_PEER_ID)
      .map((quad) => ({ ...quad, subject: quad.subject.replace('/member-list:', '/other:') }));
    expect(other.some((quad) => isMemberListQuad(contextGraphId, quad))).toBe(false);
  });

  it('count from a snapshot only when it names the curator', () => {
    expect(snapshotNamesCurator(contextGraphId, served(OWNER), ethers.getAddress(OWNER))).toBe(true);
    expect(snapshotNamesCurator(contextGraphId, served(SERVED_MEMBER), OWNER)).toBe(false);
    expect(snapshotNamesCurator(contextGraphId, served(), OWNER)).toBe(false);
  });

  it('are not read from a store that answers without bindings', async () => {
    const store = { query: async () => ({ type: 'boolean', value: true }) } as unknown as TripleStore;
    await expect(readLocalMemberListRootRows(store, metaGraph, root)).rejects.toThrow('control-plane bindings');
  });
});
