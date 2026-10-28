import { afterEach, expect, it } from 'vitest';
import { MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata,
  overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1, replaceLocallyTrustedKnowledgeAssetControlEnvelope,
} from '@origintrail-official/dkg-publisher';
import { createGraphScopedDurableManifestPlan } from '../src/sync/durable-integrity.js';
import { readHeldGraphScopedAssets } from '../src/sync/requester/stored-graph-assets.js';
import { partitionVerifiedGraphScopedAssets } from '../src/sync/requester/verified-asset-preparation.js';
import { materializeVerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';

const stores: OxigraphStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
const contextGraphId = 'held-controls', ns = 'http://dkg.io/ontology/';
async function fixture(trusted = false, subGraphName?: string) {
  const store = new OxigraphStore(); stores.push(store);
  const ual = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ef/7';
  const graph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(ual, '1'), subGraphName);
  const data = [{ subject: 'urn:subject', predicate: 'urn:value', object: '"content"', graph }];
  const root = computeFlatKCRootV10(data, []);
  const meta = generateGraphKnowledgeAssetMetadata({ ual, contextGraphId, merkleRoot: root,
    assertionVersion: '1', assertionGraph: graph, subGraphName, publicTripleCount: 1, privateTripleCount: 0,
    accessPolicy: 'public', publisherPeerId: 'untrusted-peer', timestamp: new Date(0),
  }, { status: 'tentative' });
  const asset = partitionVerifiedGraphScopedAssets(contextGraphId, data, meta, [graph]).assets[0]!;
  const metadataQuads = overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1(asset.metadataQuads,
    { ual, metaGraph: asset.metaGraph, subGraphName, receivedAt: new Date(1234) },
    { status: 'confirmed', materializedVersion: { blockNumber: 1, txIndex: 0 }, confirmation: { kind: 'finalized-materialization' } });
  if (trusted) await replaceLocallyTrustedKnowledgeAssetControlEnvelope(store, ual,
    { assertionVersion: '1', merkleRoot: root },
    { accessPolicy: 'ownerOnly', publisherPeerId: 'local-owner', allowedPeers: [] });
  const replay = () => materializeVerifiedGraphScopedAsset({ store, asset: { ...asset, metadataQuads } });
  await replay();
  const read = () => readHeldGraphScopedAssets(store, { contextGraphId,
    descriptors: createGraphScopedDurableManifestPlan(meta, contextGraphId)!.descriptors });
  return { store, ual, metaGraph: asset.metaGraph, replay, read };
}

it('skips DATA for matching replicated metadata despite peer ACLs and receiver timestamps', async () => {
  const f = await fixture(); expect(await f.read()).toEqual(new Set([f.ual]));
});

it.each([ns + 'accessPolicy', ns + 'publisherPeerId', 'http://www.w3.org/ns/prov#wasAttributedTo'])(
  'requires authenticated replay to repair divergent %s', async predicate => {
    const f = await fixture();
    await f.store.insert([{ subject: f.ual, graph: f.metaGraph, predicate, object: '"ownerOnly"' }]);
    expect(await f.read()).toEqual(new Set());
    await f.replay();
    expect(await f.read()).toEqual(new Set([f.ual]));
  },
);

it('preserves a matching trusted override and repairs its divergent materialized controls', async () => {
  const f = await fixture(true);
  expect(await f.read()).toEqual(new Set([f.ual]));
  await f.store.deleteByPattern({ subject: f.ual, graph: f.metaGraph, predicate: ns + 'accessPolicy' });
  await f.store.insert([{ subject: f.ual, graph: f.metaGraph, predicate: ns + 'accessPolicy', object: '"public"' }]);
  expect(await f.read()).toEqual(new Set());
  await f.replay();
  expect(await f.read()).toEqual(new Set([f.ual]));
  expect(await f.store.query(`ASK { GRAPH <${f.metaGraph}> { <${f.ual}> <${ns}accessPolicy> "ownerOnly" } }`))
    .toEqual({ type: 'boolean', value: true });
});

it.each(['missing', 'wrong'])('requires replay for a confirmed named asset with a %s routing attestation', async fault => {
  const f = await fixture(false, 'reports');
  expect(await f.read()).toEqual(new Set([f.ual]));
  await f.store.deleteByPattern({ graph: f.metaGraph, subject: f.ual, predicate: ns + 'authenticatedSubGraphName' });
  if (fault === 'wrong') await f.store.insert([{ graph: f.metaGraph, subject: f.ual,
    predicate: ns + 'authenticatedSubGraphName', object: '"other"' }]);
  expect(await f.read()).toEqual(new Set());
  await f.replay();
  expect(await f.read()).toEqual(new Set([f.ual]));
  expect(await f.store.query(`SELECT ?name WHERE { GRAPH <${f.metaGraph}> { <${f.ual}> <${ns}authenticatedSubGraphName> ?name } }`))
    .toMatchObject({ bindings: [{ name: '"reports"' }] });
});
