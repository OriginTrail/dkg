import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { MemoryLayer, TypedEventBus, assertionLifecycleUri, contextGraphAssertionUri,
  contextGraphLayerUri, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { BlazegraphNamespaceManager, BlazegraphStore, OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { generateAssertionCreatedMetadata } from '../src/metadata.js';
import { assertionScopedGraphUri } from '../src/assertion-scoped-graphs.js';

const CG = '0xowner/Case-Sensitive';
const NAME = 'Draft';
const CHECKSUM = '0x52908400098527886E0F7030069857D2E4169EE7';
const LOWER = CHECKSUM.toLowerCase();
const MIXED = '0x52908400098527886e0F7030069857D2E4169EE7';
const OTHER = '0x00000000000000000000000000000000000000b2';
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  let store: TripleStore = new OxigraphStore();
  const url = process.env.DKG_WM_AUTHOR_BLAZEGRAPH_URL;
  if (url) {
    const manager = new BlazegraphNamespaceManager({ namespaceApiUrl: `${url}/namespace` });
    const handles = await manager.acquireMany([`wm-author-${randomUUID()}`]);
    cleanups.push(() => manager.disposeAll(handles));
    store = new BlazegraphStore(handles[0]!.sparqlUrl);
  }
  cleanups.push(() => store.close());
  const publisher = new DKGPublisher({ store, chain: new NoChainAdapter(),
    eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
  return { store, publisher };
}

async function seed(store: TripleStore, author: string, number?: bigint, subGraphName?: string, name = NAME) {
  await store.insert(generateAssertionCreatedMetadata({ contextGraphId: CG, agentAddress: author,
    assertionName: name, subGraphName, timestamp: new Date(), kaNumber: number,
    reservedUal: number === undefined ? undefined : `did:dkg:evm:31337/${author}/${number}`,
  }, { provenanceEvents: false }));
  const graph = number === undefined ? contextGraphAssertionUri(CG, author, name, subGraphName)
    : contextGraphLayerUri(CG, MemoryLayer.WorkingMemory, author, number, subGraphName);
  const payload = [
    { subject: 'urn:author:root', predicate: 'urn:value', object: `"${author}:${number ?? 'legacy'}"`, graph: '' },
    { subject: 'urn:author:named', predicate: 'urn:value', object: '"Named payload"', graph: 'urn:original:graph' },
  ];
  await store.insert(payload.map(q => ({ ...q, graph: assertionScopedGraphUri(graph, q.graph) })));
  return payload;
}

async function snapshot(store: TripleStore) {
  const result = await store.query('SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } }');
  if (result.type !== 'bindings') throw new Error('Expected bindings');
  return result.bindings.map(q => JSON.stringify(q)).sort();
}

describe('named WM read author spelling (#3356)', () => {
  it.each([CHECKSUM, LOWER, MIXED].flatMap(author => [undefined, 42n].map(number => ({ author, number }))))(
    'reads stored $author with number $number through every equivalent casing without writes', async ({ author, number }) => {
      const { store, publisher } = await fixture();
      const payload = await seed(store, author, number);
      const before = await snapshot(store);
      for (const spelling of [CHECKSUM, LOWER, MIXED]) {
        expect(await publisher.assertionQuery(CG, NAME, spelling)).toEqual(expect.arrayContaining(payload));
        expect(await publisher.assertionQuery(CG, NAME, spelling)).toHaveLength(payload.length);
      }
      expect(await snapshot(store)).toEqual(before);
    },
  );

  it('keeps same-name authors and case-sensitive names/subgraphs isolated', async () => {
    const { store, publisher } = await fixture();
    const root = await seed(store, MIXED, 42n);
    const other = await seed(store, OTHER, 43n);
    const sub = await seed(store, MIXED, 44n, 'Science');
    await seed(store, MIXED, 45n, 'science');
    await seed(store, MIXED, 46n, undefined, 'draft');
    expect(await publisher.assertionQuery(CG, NAME, LOWER)).toEqual(expect.arrayContaining(root));
    expect(await publisher.assertionQuery(CG, NAME, OTHER)).toEqual(expect.arrayContaining(other));
    expect(await publisher.assertionQuery(CG, NAME, LOWER, 'Science')).toEqual(expect.arrayContaining(sub));
    expect(await publisher.assertionQuery(CG, 'Absent', LOWER)).toEqual([]);
    expect(await publisher.assertionQuery(CG, NAME, '0x00000000000000000000000000000000000000c3')).toEqual([]);
  });

  it('rejects competing historical subjects even when one exactly matches the request', async () => {
    const { store, publisher } = await fixture();
    await seed(store, CHECKSUM, 42n);
    await seed(store, LOWER, 43n);
    const before = await snapshot(store);
    for (const spelling of [CHECKSUM, LOWER, MIXED]) {
      await expect(publisher.assertionQuery(CG, NAME, spelling)).rejects.toMatchObject({ code: 'KA_WM_LIFECYCLE_CORRUPT' });
    }
    expect(await snapshot(store)).toEqual(before);
  });

  it('preserves case-sensitive peer-ID legacy authors', async () => {
    const { store, publisher } = await fixture();
    const payload = await seed(store, 'PeerOwner');
    expect(await publisher.assertionQuery(CG, NAME, 'PeerOwner')).toEqual(expect.arrayContaining(payload));
    expect(await publisher.assertionQuery(CG, NAME, 'peerowner')).toEqual([]);
  });

  it('propagates unavailable identity evidence instead of reporting an empty draft', async () => {
    const { store, publisher } = await fixture();
    vi.spyOn(store, 'query').mockResolvedValue({ type: 'boolean', value: false });
    await expect(publisher.assertionQuery(CG, NAME, LOWER)).rejects.toMatchObject({ code: 'KA_WM_LIFECYCLE_CORRUPT' });
  });

  it.each([
    {},
    { subject: 42 },
    { subject: assertionLifecycleUri(CG, OTHER, NAME) },
    { subject: assertionLifecycleUri(CG, CHECKSUM, NAME.toLowerCase()) },
    { subject: assertionLifecycleUri(CG, CHECKSUM, NAME, 'Science') },
  ])('rejects malformed or out-of-scope lifecycle evidence (%#)', async row => {
    const { store, publisher } = await fixture();
    vi.spyOn(store, 'query').mockResolvedValue({ type: 'bindings', bindings: [row] } as Awaited<ReturnType<TripleStore['query']>>);
    await expect(publisher.assertionQuery(CG, NAME, LOWER)).rejects.toMatchObject({ code: 'KA_WM_LIFECYCLE_CORRUPT' });
  });
});
