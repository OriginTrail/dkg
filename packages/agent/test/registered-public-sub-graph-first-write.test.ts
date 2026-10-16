// SPDX-License-Identifier: Apache-2.0

/**
 * #3293: a member's first write into a named sub-graph of a public graph
 * registered on chain.
 *
 * The graph's owner registers the sub-graph (`createSubGraph`, what POST
 * /api/sub-graph/create does), a member subscribes and pulls the graph's
 * definition from a connected peer (the RFC-64 metadata bootstrap, #3264),
 * and the member's first write names the sub-graph. The write was refused
 * ("Sub-graph ... has not been registered", HTTP 500 at the routes) until
 * shared memory of that sub-graph reached the member by sync: the definition
 * the member installed left out the owner's sub-graph registrations, although
 * the peer served them in the same `_meta` pages.
 *
 * The member here runs the real bootstrap and curator-refresh chain over a
 * fake agent surface (as in rfc64-meta-bootstrap-registered-public.test.ts)
 * and writes through a real publisher over its own store. The peer's `_meta`
 * is served as the owner's store holds it.
 */
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  DKG_ONTOLOGY,
  generateEd25519Keypair,
  TypedEventBus,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  DKGPublisher,
  generateSubGraphRegistration,
  hasSubGraphRegistration,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DKGAgent } from '../src/index.js';
import { Rfc64MetaBootstrapMethods } from '../src/dkg-agent-rfc64-meta-bootstrap.js';

const OWNER = new ethers.Wallet(`0x${'93'.repeat(32)}`).address.toLowerCase() as EvmAddressV1;
const MEMBER = new ethers.Wallet(`0x${'94'.repeat(32)}`).address;
const OWNER_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const ON_CHAIN_ID = '11';
const contextGraphId = `${OWNER}/one-graph` as ContextGraphIdV1;
const SUB_GRAPH = 'reports';
const metaGraph = contextGraphMetaGraphUri(contextGraphId);
const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
const registeredProof = Object.freeze({ contextGraphId, onChainId: ON_CHAIN_ID });
const NAME = 'http://schema.org/name';

function rootQuad(predicate: string, object: string): Quad {
  return { subject: contextGraphUri, predicate, object, graph: metaGraph };
}

/** The owner's root declaration of the registered public graph, chain claims included. */
const OWNER_DECLARATION: readonly Quad[] = Object.freeze([
  rootQuad(DKG_ONTOLOGY.RDF_TYPE, DKG_ONTOLOGY.DKG_CONTEXT_GRAPH),
  rootQuad(DKG_ONTOLOGY.DKG_ACCESS_POLICY, '"public"'),
  rootQuad(DKG_ONTOLOGY.DKG_CURATOR, `did:dkg:agent:${OWNER}`),
  rootQuad(DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, '"registered"'),
  rootQuad(`${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, `"${ON_CHAIN_ID}"`),
]);

/** The rows the owner's `createSubGraph` writes into the graph's `_meta`. */
function ownerSubGraphRegistration(subGraphName: string): Quad[] {
  return generateSubGraphRegistration({
    contextGraphId,
    subGraphName,
    createdBy: OWNER_PEER_ID,
    description: 'Reports of the graph',
    timestamp: new Date('2026-10-16T08:00:00.000Z'),
  });
}

const stores: OxigraphStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

function openStore(): OxigraphStore {
  const store = new OxigraphStore();
  stores.push(store);
  return store;
}

/**
 * The owner's node: its `_meta` as a connected peer serves it. `served()`
 * reads the store each time, so a sub-graph the owner registers later is in
 * the next answer.
 */
async function ownerNode(subGraphs: readonly string[]) {
  const store = openStore();
  await store.insert([...OWNER_DECLARATION, ...subGraphs.flatMap(ownerSubGraphRegistration)]);
  const served = async (): Promise<Quad[]> => {
    const result = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`);
    if (result.type !== 'bindings') throw new Error('expected the owner\'s _meta rows');
    return result.bindings.map((row) => ({ subject: row['s']!, predicate: row['p']!, object: row['o']!, graph: metaGraph }));
  };
  return { store, served };
}

/** A member subscribed to the graph whose one connected peer is the owner. */
function memberNode(owner: { served: () => Promise<Quad[]> }) {
  const store = openStore();
  const writeLocks = new Map<string, Promise<void>>();
  const fetchSyncPages = vi.fn(async () => ({
    quads: await owner.served(),
    checkpointKey: 'owner-meta-checkpoint',
    resumedFromOffset: 0,
    completed: true,
  }));
  const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const surface = {
    store,
    log,
    peerId: '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb',
    writeLocks,
    localContextGraphProvenance: { hasLocalCreate: () => false },
    subscribedContextGraphs: new Map([[contextGraphId, { subscribed: true }]]),
    readAcceptedRfc64CatalogAccessSnapshotV1: () => null,
    hasConfirmedMetaState: vi.fn(async () => true),
    resolveRfc64UnregisteredAuthoritySeedPeersV1: () => [OWNER_PEER_ID],
    resolveCuratorPeerId: vi.fn(async () => OWNER_PEER_ID),
    refreshMetaSyncedFlags: vi.fn(async () => undefined),
    metaRefreshTimestamps: new Map<string, number>(),
    runContextGraphSyncWithBackpressure: async <T>(
      _ctx: OperationContext,
      _contextGraphId: string,
      _lane: 'durable',
      _label: string,
      work: () => Promise<T>,
    ): Promise<T> => work(),
    node: { libp2p: { getConnections: () => [{ remotePeer: { toString: () => OWNER_PEER_ID } }] } },
    discovery: {},
    fetchSyncPages,
    oversizeTombstoneLog: { record: () => undefined },
    invalidateListContextGraphsCache: () => undefined,
    contextGraphMetaProjection: { markDirty: vi.fn() },
    bindSubscriptionOnChainId: vi.fn(),
    recordCgWireId: vi.fn(),
    persistContextGraphSubscription: vi.fn(),
    syncCheckpoints: new Map<string, number>(),
  };
  // The real method chain over this surface; own data properties shadow the
  // base class accessors.
  const agent = Object.defineProperties(
    Object.create(Rfc64MetaBootstrapMethods.prototype) as object,
    Object.getOwnPropertyDescriptors(surface),
  ) as unknown as DKGAgent;
  return { agent, store, writeLocks, fetchSyncPages, log, markDirty: surface.contextGraphMetaProjection.markDirty };
}

/** The member's own publisher: what its knowledge-asset and assertion routes write through. */
async function memberPublisher(member: { store: OxigraphStore; writeLocks: Map<string, Promise<void>> }) {
  return new DKGPublisher({
    store: member.store,
    chain: new MockChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    writeLocks: member.writeLocks,
  });
}

/** POST /api/knowledge-assets with `subGraphName`: create the draft, then write its triple. */
async function firstWrite(publisher: DKGPublisher, name: string, subGraphName: string): Promise<void> {
  await publisher.assertionCreate(contextGraphId, name, MEMBER, subGraphName);
  await publisher.assertionWrite(
    contextGraphId,
    name,
    MEMBER,
    [{ subject: `urn:dkg:test-3293:${name}`, predicate: NAME, object: `"${name}"`, graph: '' }],
    subGraphName,
  );
}

describe('a member\'s first write into a sub-graph of a registered public graph (#3293)', () => {
  it('learns the owner\'s sub-graph with the graph\'s definition, and its first write goes into it', async () => {
    const owner = await ownerNode([SUB_GRAPH]);
    const member = memberNode(owner);

    await expect(
      member.agent.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1(contextGraphId, undefined, registeredProof),
    ).resolves.toBe('fetched');

    const publisher = await memberPublisher(member);
    await expect(firstWrite(publisher, 'report-1', SUB_GRAPH)).resolves.toBeUndefined();
    await expect(hasSubGraphRegistration(member.store, contextGraphId, SUB_GRAPH)).resolves.toBe(true);
    expect(member.fetchSyncPages).toHaveBeenCalledOnce();
  });
});
