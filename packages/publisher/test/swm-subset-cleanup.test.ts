import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import { generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { DKGPublisher } from '../src/index.js';
import { ethers } from 'ethers';

const PARANET = 'test-swm-cleanup';
const WORKSPACE_GRAPH = `did:dkg:context-graph:${PARANET}/_shared_memory`;
const WORKSPACE_META_GRAPH = `did:dkg:context-graph:${PARANET}/_shared_memory_meta`;
const DATA_GRAPH = `did:dkg:context-graph:${PARANET}`;

function q(s: string, p: string, o: string, g = ''): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

async function countInGraph(store: OxigraphStore, graph: string): Promise<number> {
  const r = await store.query(`SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  if (r.type !== 'bindings' || !r.bindings[0]) return -1;
  const raw = String(r.bindings[0]['c']);
  // Oxigraph returns typed literals: "4"^^<http://www.w3.org/2001/XMLSchema#integer>
  const match = raw.match(/^"?(\d+)"?/);
  return match ? parseInt(match[1], 10) : -1;
}

async function subjectsInGraph(store: OxigraphStore, graph: string): Promise<Set<string>> {
  const r = await store.query(`SELECT DISTINCT ?s WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  if (r.type !== 'bindings') return new Set();
  return new Set(r.bindings.map((b) => String(b['s'])));
}

describe('SWM subset publish cleanup', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;
  const wallet = ethers.Wallet.createRandom();

  beforeEach(async () => {
    store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });
  });

  it('subset publish removes published entities from SWM even when clearWorkspaceAfter=false', async () => {
    const alice = 'urn:test:alice';
    const bob = 'urn:test:bob';
    await publisher.writeToWorkspace(PARANET, [
      q(alice, 'http://schema.org/name', '"Alice"'),
      q(alice, 'http://schema.org/age', '"30"'),
      q(bob, 'http://schema.org/name', '"Bob"'),
      q(bob, 'http://schema.org/knows', alice),
    ], { publisherPeerId: 'peer1' });

    expect(await countInGraph(store, WORKSPACE_GRAPH)).toBe(4);

    const result = await publisher.publishFromSharedMemory(PARANET, {
      rootEntities: [alice],
    }, { clearWorkspaceAfter: false });

    expect(result.status).toBe('confirmed');
    expect(result.kaManifest.length).toBe(1);
    expect(result.kaManifest[0].rootEntity).toBe(alice);

    // Alice's triples must be removed from SWM
    const remaining = await subjectsInGraph(store, WORKSPACE_GRAPH);
    expect(remaining.has(alice)).toBe(false);
    expect(remaining.has(bob)).toBe(true);
    expect(await countInGraph(store, WORKSPACE_GRAPH)).toBe(2);
  });

  it('after subset publish, remaining entities can be published without conflict', async () => {
    const alice = 'urn:test:alice';
    const bob = 'urn:test:bob';
    const carol = 'urn:test:carol';

    await publisher.writeToWorkspace(PARANET, [
      q(alice, 'http://schema.org/name', '"Alice"'),
      q(bob, 'http://schema.org/name', '"Bob"'),
      q(carol, 'http://schema.org/name', '"Carol"'),
    ], { publisherPeerId: 'peer1' });

    // Publish Alice only
    await publisher.publishFromSharedMemory(PARANET, { rootEntities: [alice] }, { clearWorkspaceAfter: false });

    // Publish remaining (Bob + Carol) — should not fail with "already exists"
    const result = await publisher.publishFromSharedMemory(PARANET, 'all', { clearWorkspaceAfter: true });

    expect(result.status).toBe('confirmed');
    const roots = result.kaManifest.map((ka) => ka.rootEntity);
    expect(roots).toContain(bob);
    expect(roots).toContain(carol);
    expect(roots).not.toContain(alice);

    // SWM should be empty
    expect(await countInGraph(store, WORKSPACE_GRAPH)).toBe(0);
  });

  it('clearWorkspaceAfter=true clears entire SWM including unpublished entities', async () => {
    const alice = 'urn:test:alice';
    const bob = 'urn:test:bob';

    await publisher.writeToWorkspace(PARANET, [
      q(alice, 'http://schema.org/name', '"Alice"'),
      q(bob, 'http://schema.org/name', '"Bob"'),
    ], { publisherPeerId: 'peer1' });

    // Publish Alice with clearAfter=true → Bob also gets cleared
    await publisher.publishFromSharedMemory(PARANET, { rootEntities: [alice] }, { clearWorkspaceAfter: true });

    expect(await countInGraph(store, WORKSPACE_GRAPH)).toBe(0);
  });

  it('published triples appear in data graph', async () => {
    const entity = 'urn:test:entity';
    await publisher.writeToWorkspace(PARANET, [
      q(entity, 'http://schema.org/name', '"Published"'),
    ], { publisherPeerId: 'peer1' });

    await publisher.publishFromSharedMemory(PARANET, 'all');

    const subjects = await subjectsInGraph(store, DATA_GRAPH);
    expect(subjects.has(entity)).toBe(true);
  });

  it('ownership metadata is cleaned for published entities', async () => {
    const alice = 'urn:test:alice';
    const bob = 'urn:test:bob';

    await publisher.writeToWorkspace(PARANET, [
      q(alice, 'http://schema.org/name', '"Alice"'),
      q(bob, 'http://schema.org/name', '"Bob"'),
    ], { publisherPeerId: 'peer1' });

    // Subset publish: alice only, clearAfter=false
    await publisher.publishFromSharedMemory(PARANET, { rootEntities: [alice] }, { clearWorkspaceAfter: false });

    // Alice ownership metadata should be removed
    const aliceOwner = await store.query(
      `ASK { GRAPH <${WORKSPACE_META_GRAPH}> { <${alice}> <http://dkg.io/ontology/workspaceOwner> ?o } }`,
    );
    expect(aliceOwner.type).toBe('boolean');
    if (aliceOwner.type === 'boolean') expect(aliceOwner.value).toBe(false);

    // Bob ownership metadata should still exist
    const bobOwner = await store.query(
      `ASK { GRAPH <${WORKSPACE_META_GRAPH}> { <${bob}> <http://dkg.io/ontology/workspaceOwner> ?o } }`,
    );
    expect(bobOwner.type).toBe('boolean');
    if (bobOwner.type === 'boolean') expect(bobOwner.value).toBe(true);
  });
});
