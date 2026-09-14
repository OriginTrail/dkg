import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGAgent, KaNumberAllocator } from '@origintrail-official/dkg-agent';
import { handleCaptureAsync, type EPCISDocument } from '@origintrail-official/dkg-epcis';
import { DashboardDB, SqliteKaNumberStore } from '@origintrail-official/dkg-node-ui';
import { GraphManager, OxigraphStore, PrivateContentStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '@origintrail-official/dkg-publisher';
import { createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { createEVMAdapter, takeSnapshot, revertSnapshot } from '../../chain/test/evm-test-context.js';
import { TEST_SNAPSHOT_STORAGE } from '../../../scripts/testing/snapshot-storage.js';

const CG = 'epcis-capture-conversion';
// Representative publication cases cover every visibility and both spellings;
// the exhaustive normalization matrix lives in the lightweight package tests.
const cases = [
  { visibility: 'bare', type: 'ObjectEvent' },
  { visibility: 'public', type: 'https://gs1.github.io/EPCIS/ObjectEvent' },
  { visibility: 'private', type: 'ObjectEvent' },
  { visibility: 'both', type: 'https://gs1.github.io/EPCIS/ObjectEvent' },
];
let agent: DKGAgent | undefined;
let store: OxigraphStore;
let dashboard: DashboardDB | undefined;
let dataDir: string | undefined;
let snapshot: string | undefined;

beforeAll(async () => {
  snapshot = await takeSnapshot();
  dataDir = await mkdtemp(join(tmpdir(), 'dkg-epcis-publication-'));
  dashboard = new DashboardDB({ dataDir });
  store = new OxigraphStore();
  agent = await DKGAgent.create({
    name: 'EPCIS Capture Fixture', dataDir, listenPort: 0, listenHost: '127.0.0.1', skills: [],
    store, chainAdapter: createEVMAdapter(), nodeRole: 'edge',
    kaNumberAllocator: new KaNumberAllocator(new SqliteKaNumberStore(dashboard)),
    rfc64CatalogActivation: { enabled: false },
    sharedMemoryPublicSnapshotStorage: TEST_SNAPSHOT_STORAGE,
  });
  await agent.start();
  await agent.createContextGraph({ id: CG, name: CG, description: '' });
  await agent.registerContextGraph(CG);
}, 120_000);

afterAll(async () => {
  try {
    await agent?.stop();
  } finally {
    await store?.close();
    dashboard?.close();
    if (snapshot) await revertSnapshot(snapshot);
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
}, 120_000);

function document(type: string, eventID: string): EPCISDocument {
  return {
    '@context': { '@vocab': 'https://gs1.github.io/EPCIS/', eventID: '@id', type: 'https://example.org/type' },
    type: 'EPCISDocument', schemaVersion: '2.0', creationDate: '2024-03-01T08:00:00Z',
    epcisBody: { eventList: [{ type, eventID, eventTime: '2024-03-01T08:00:00Z',
      eventTimeZoneOffset: '+00:00', action: 'OBSERVE', epcList: [],
    }] },
  };
}

// The CLI composes EPCIS with the agent. Use its real async publication path,
// allocator, publisher and store; localOnly keeps network ACKs out of this test.
describe('EPCIS capture through agent publication', () => {
  it.each(cases)('stores the standard RDF class for $type ($visibility)', async ({ visibility, type }) => {
    const publicId = `urn:epcis:${visibility}:${type.endsWith('/ObjectEvent') ? 'canonical' : 'compact'}:public`;
    const privateId = publicId.replace(/:public$/, ':private');
    const publicDoc = document(type, publicId);
    const privateDoc = document(type, privateId);
    const input = visibility === 'bare' ? privateDoc : visibility === 'both'
      ? { public: publicDoc, private: privateDoc }
      : visibility === 'public' ? { public: publicDoc } : { private: privateDoc };
    const before = structuredClone(input);
    const result = await handleCaptureAsync({ epcisDocument: input }, {
      contextGraphId: CG,
      publisher: { publishAsync: (cg, content, opts) => agent!.publishAsync(
        cg, content as Parameters<DKGAgent['publishAsync']>[1], { ...opts, localOnly: true },
      ) },
    });
    expect(result).toMatchObject({ status: 'accepted', eventCount: 1 });
    expect(input).toEqual(before);
    const job = await new TripleStoreAsyncLiftPublisher(store).getStatus(result.captureID);
    if (job?.request.jobType !== 'knowledge-asset-vm-publish') throw new Error('Expected a queued KA publication');
    const request = job.request.knowledgeAssetVmPublish;
    const scope = createGraphKnowledgeAssetScope(request.kaUal!, request.assertionVersion!);
    const graph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope);
    const privateQuads = await new PrivateContentStore(store, new GraphManager(store))
      .getKnowledgeAssetPrivateTriples(CG, scope);
    // Check both submitted subjects in both layers. In particular, a private
    // subject must never appear publicly, even in a private-only capture.
    for (const [subject, expectedPublic, expectedPrivate] of [
      [publicId, visibility === 'public' || visibility === 'both', false],
      [privateId, false, visibility !== 'public'],
    ] as const) {
      const publicClass = await store.query(`ASK { GRAPH <${graph}> {
        <${subject}> a <https://gs1.github.io/EPCIS/ObjectEvent>
      } }`);
      expect(publicClass).toEqual({ type: 'boolean', value: expectedPublic });
      const privateTypes = privateQuads.filter((quad) => quad.subject === subject
        && quad.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
      expect(privateTypes).toEqual(expectedPrivate ? [expect.objectContaining({
        object: 'https://gs1.github.io/EPCIS/ObjectEvent',
      })] : []);
    }
  }, 120_000);
});
