// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { resolveKnowledgeAssetWorkspaceHead } from '@origintrail-official/dkg-publisher';
import { swmFixtures } from './swm-descriptor-fixtures.js';
import { parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import { createSharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import { applyVerifiedSwmRecoveryGraphAsset } from '../src/sync/requester/swm-recovery-apply.js';

const CG = 'corrupt-private-recovery';
const KA = 'did:dkg:31337/0x1111111111111111111111111111111111111111/7';
const DKG = 'http://dkg.io/ontology/';
const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map(store => store.close())); });
const share = (version: number, id: string, marker: string, privateByte = 0xbb) => swmFixtures(CG).share({ version, operationId: id, marker, ual: KA, privateTripleCount: 1, privateMerkleRoot: new Uint8Array(32).fill(privateByte) });

describe('real corrupt-head recovery admission', () => {
  it.each(['ambiguous-graph', 'malformed-version'] as const)('keeps a newer private commitment behind %s metadata when public bytes match an older descriptor', async corruption => {
    const store = new OxigraphStore(); stores.push(store);
    const local = share(2, 'newer-local', 'public-same', 0xbb);
    const old = share(1, 'older-provider', 'public-same', 0xaa);
    await store.insert([...local.meta, ...local.payload.map(row => ({ ...row, graph: local.assertionGraph }))]);
    if (corruption === 'ambiguous-graph') await store.insert([{ subject: local.headSubject, predicate: `${DKG}assertionGraph`, object: 'urn:wrong:assertion', graph: local.meta[0]!.graph }]);
    else { await store.deleteByPattern({ graph: local.meta[0]!.graph, subject: local.headSubject, predicate: `${DKG}assertionVersion` }); await store.insert([{ subject: local.headSubject, predicate: `${DKG}assertionVersion`, object: '"malformed"', graph: local.meta[0]!.graph }]); }
    const descriptor = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: old.meta })[0]!;
    const materializer = createSharedMemorySnapshotMaterializer({ store, writeLocks: new Map(), invalidateListContextGraphsCache: () => {}, readConfirmedKnowledgeAssetVersion: async () => 0n });
    expect(await materializer.isGraphAssetMaterialized(descriptor)).toBe(true);
    expect(await materializer.readStoredHead(descriptor)).toMatchObject({ status: 'corrupt' });
    const before = await store.query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }');
    expect(await applyVerifiedSwmRecoveryGraphAsset({ contextGraphId: CG, asset: { kind: 'preserve-equivalent', descriptor }, ports: { store, snapshotMaterializer: materializer, replaceMetaForGraphAssets: assets => materializer.replaceMetaForGraphAssets(assets) } })).toMatchObject({ insertedGraphQuads: 0, insertedMetaQuads: 0 });
    expect(await store.query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }')).toEqual(before);
  });

  it.each(['agent.swmRecovery.storedHead', 'agent.swmRecovery.draftOrder.equivalence', 'publisher.workspace.authenticatedOperationEvidence'])('propagates unavailable store evidence at %s without rewriting metadata', async source => {
    const store = new OxigraphStore(); stores.push(store);
    const local = share(2, 'same-evidence-id', 'current');
    await store.insert([...local.meta, ...local.payload.map(row => ({ ...row, graph: local.assertionGraph }))]);
    await store.deleteByPattern({ graph: local.meta[0]!.graph, subject: local.headSubject, predicate: `${DKG}assertionVersion` });
    await store.insert([{ subject: local.headSubject, predicate: `${DKG}assertionVersion`, object: '"malformed"', graph: local.meta[0]!.graph }]);
    const descriptor = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: local.meta })[0]!;
    const materializer = createSharedMemorySnapshotMaterializer({ store, writeLocks: new Map(), invalidateListContextGraphsCache: () => {} });
    await materializer.isGraphAssetMaterialized(descriptor);
    const before = await store.query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }');
    const error = new Error('backend query unavailable'); const original = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementation((text, options) => options?.source === source ? Promise.reject(error) : original(text, options));
    await expect(applyVerifiedSwmRecoveryGraphAsset({ contextGraphId: CG, asset: { kind: 'preserve-equivalent', descriptor }, ports: { store, snapshotMaterializer: materializer, replaceMetaForGraphAssets: assets => materializer.replaceMetaForGraphAssets(assets) } })).rejects.toBe(error);
    expect(await store.query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }')).toEqual(before);
  });

  it.each([true, false])('malformed version repairs complete-equivalent=%s through the real materializer', async equivalent => {
    const store = new OxigraphStore(); stores.push(store);
    const local = share(2, 'local', 'current');
    const remote = share(2, 'provider', equivalent ? 'current' : 'different');
    await store.insert([...local.meta, ...local.payload.map(row => ({ ...row, graph: local.assertionGraph }))]);
    await store.deleteByPattern({ graph: local.meta[0]!.graph, subject: local.headSubject, predicate: `${DKG}assertionVersion` });
    await store.insert([{ subject: local.headSubject, predicate: `${DKG}assertionVersion`, object: '"malformed"', graph: local.meta[0]!.graph }]);
    const descriptor = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: remote.meta })[0]!;
    const materializer = createSharedMemorySnapshotMaterializer({ store, writeLocks: new Map(), invalidateListContextGraphsCache: () => {} });
    const replace = vi.spyOn(store, 'replaceGraph');
    const before = await store.query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }');
    const result = await applyVerifiedSwmRecoveryGraphAsset({ contextGraphId: CG, asset: { kind: 'replace', descriptor, replacementQuads: remote.payload }, ports: { store, snapshotMaterializer: materializer, replaceMetaForGraphAssets: assets => materializer.replaceMetaForGraphAssets(assets) } });
    if (equivalent) {
      expect(result.insertedMetaQuads).toBeGreaterThan(0);
      expect((await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store), contextGraphId: CG, kaUal: KA }))?.operationAliases.some(alias => alias.shareOperationId === local.operationId)).toBe(true);
    } else {
      expect(result).toMatchObject({ insertedGraphQuads: 0, insertedMetaQuads: 0 });
      expect(await store.query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }')).toEqual(before);
    }
    expect(replace).not.toHaveBeenCalled();
  });
});
