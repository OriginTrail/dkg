import { randomUUID } from 'node:crypto';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair, contextGraphMetaUri, contextGraphSubGraphUri } from '@origintrail-official/dkg-core';
import { BlazegraphNamespaceManager, BlazegraphStore, OxigraphStore, PrivateContentStore, GraphManager, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher, assertionScopedGraphUri, computePrivateRootV10, computeFlatKCRootV10 } from '../../src/index.js';
import { finalizeRootlessAssertionForTest } from './rootless-lifecycle.js';

export const CG = 'pull-from-test';
export const AGENT = '0x00000000000000000000000000000000000000a1';
export const NAME = 'meeting-notes';
export const SCHEMA = 'http://schema.org/name';
export const DKG = 'http://dkg.io/ontology/';
export const ENTITY_1 = 'urn:e:alice';
export const ENTITY_2 = 'urn:e:bob';
export const ENTITY_3 = 'urn:e:carol';
const namespaceCleanups: Array<() => Promise<void>> = [];
export async function cleanupPullFixtures(): Promise<void> {
  for (const cleanup of namespaceCleanups.splice(0)) await cleanup();
}

export async function makePublisher() {
  let store: OxigraphStore | BlazegraphStore = new OxigraphStore();
  const blazegraph = process.env.DKG_PULL_RECOVERY_BLAZEGRAPH_URL;
  if (blazegraph) {
    const manager = new BlazegraphNamespaceManager({ namespaceApiUrl: `${blazegraph}/namespace`, requestTimeoutMs: 10_000 });
    const handles = await manager.acquireMany([`pull-recovery-${randomUUID()}`]);
    namespaceCleanups.push(() => manager.disposeAll(handles));
    store = new BlazegraphStore(handles[0]!.sparqlUrl);
  }
  const publisher = new DKGPublisher({
    store,
    chain: new NoChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
  return { publisher, store };
}

export function q(subject: string, predicate: string, object: string, graph = ''): Quad {
  return { subject, predicate, object, graph };
}

export function key(quad: Quad): string {
  return JSON.stringify([quad.subject, quad.predicate, quad.object]);
}

// Seed residue left by older create retries directly. Public writes now reject
// active seals, but pull-from must still recover drafts persisted by 10.0.16.
export async function seedDirtyDraft(
  publisher: DKGPublisher,
  store: TripleStore,
  publicQuads: Quad[],
  privateQuads: Quad[] = [],
): Promise<void> {
  const wmGraph = await publisher.wmGraphUri(CG, AGENT, NAME);
  for (const quad of publicQuads) {
    const graph = assertionScopedGraphUri(wmGraph, quad.graph);
    await store.createGraph(graph);
    await store.insert([{ ...quad, graph }]);
  }
  if (privateQuads.length > 0) {
    await new PrivateContentStore(store, new GraphManager(store))
      .storeKnowledgeAssetPrivateDraftTriples(CG, AGENT, NAME, privateQuads);
  }
}

export async function seedShared(
  publisher: DKGPublisher,
  store: TripleStore,
  options: {
    publicQuads?: Quad[];
    privateQuads?: Quad[];
    name?: string;
    agentAddress?: string;
    subGraphName?: string;
  } = {},
) {
  const name = options.name ?? NAME;
  const agentAddress = options.agentAddress ?? AGENT;
  const subGraphName = options.subGraphName;
  const publicQuads = options.publicQuads ?? [
    q(ENTITY_1, SCHEMA, '"Alice"'),
    q(ENTITY_2, SCHEMA, '"Bob"'),
  ];
  const privateQuads = options.privateQuads ?? [];
  await publisher.assertionCreate(CG, name, agentAddress, subGraphName);
  if (publicQuads.length > 0) {
    await publisher.assertionWrite(CG, name, agentAddress, publicQuads, subGraphName);
  }
  if (privateQuads.length > 0) {
    await publisher.assertionWritePrivate(CG, name, agentAddress, privateQuads, subGraphName);
  }
  const finalized = await finalizeRootlessAssertionForTest({
    publisher,
    store,
    contextGraphId: CG,
    name,
    agentAddress,
    subGraphName,
  });
  await publisher.assertionPromote(CG, name, agentAddress, { subGraphName });
  const privateRoot = computePrivateRootV10(finalized.privateQuads);
  return { ...finalized, merkleRoot: `0x${Buffer.from(computeFlatKCRootV10(finalized.publicQuads, privateRoot ? [privateRoot] : [])).toString('hex')}` };
}

export async function registerSubGraph(store: TripleStore, subGraphName: string): Promise<void> {
  const metaGraph = contextGraphMetaUri(CG);
  const subGraphUri = contextGraphSubGraphUri(CG, subGraphName);
  await store.createGraph(metaGraph);
  await store.insert([
    q(
      subGraphUri,
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      'http://dkg.io/ontology/SubGraph',
      metaGraph,
    ),
    q(subGraphUri, 'http://schema.org/name', `"${subGraphName}"`, metaGraph),
    q(subGraphUri, `${DKG}createdBy`, 'did:dkg:agent:test-agent', metaGraph),
  ]);
}

