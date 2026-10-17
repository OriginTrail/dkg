import { ethers } from 'ethers';
import { sealPublicGraphSnapshot } from '@origintrail-official/dkg-chain';
import {
  MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import type { OxigraphStore, Quad } from '@origintrail-official/dkg-storage';
import type { VerifiedGraphScopedAsset } from '../../src/sync/requester/graph-scoped-materialization.js';

export const SNAPSHOT_AUTHOR = `0x${'ab'.repeat(20)}`;

/** Graph-scoped public assets as a core serves them: confirmed metadata whose root matches the content. */
export function makeSnapshotAssets(graph: string, count: number, options: { subGraphName?: string; version?: number } = {}) {
  const version = options.version ?? 1;
  const metaGraph = `did:dkg:context-graph:${graph}/_meta`;
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const ual = `did:dkg:evm:31337/${SNAPSHOT_AUTHOR}/${number}`;
    const assertionGraph = knowledgeAssetLayerGraphUri(graph, MemoryLayer.VerifiableMemory,
      createGraphKnowledgeAssetScope(ual, version), options.subGraphName);
    const dataQuads: Quad[] = [{ subject: `urn:entity:${number}`, predicate: 'urn:value',
      object: version === 1 ? `"asset ${number}"` : `"asset ${number} v${version}"`, graph: assertionGraph }];
    const root = computeFlatKCRootV10(dataQuads, []);
    const kaId = (BigInt(SNAPSHOT_AUTHOR) << 96n) | BigInt(number);
    const metadataQuads = generateGraphKnowledgeAssetMetadata({
      ual, contextGraphId: graph, assertionGraph, assertionVersion: String(version), merkleRoot: root, publisherPeerId: 'core',
      accessPolicy: 'public', timestamp: new Date(0), publicTripleCount: dataQuads.length, privateTripleCount: 0,
      ...(options.subGraphName ? { subGraphName: options.subGraphName } : {}),
    }, { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: {
      batchId: kaId, materializedVersion: { blockNumber: 10, txIndex: 0 },
    } } });
    const verified: VerifiedGraphScopedAsset = {
      contextGraphId: graph, ual, assertionVersion: BigInt(version), assertionGraph, metaGraph,
      merkleRootHex: ethers.hexlify(root).slice(2), dataQuads, metadataQuads,
      ...(options.subGraphName ? { subGraphName: options.subGraphName } : {}),
    };
    return { ual, kaId, root: ethers.hexlify(root), assertionGraph, verified };
  });
}
export type SnapshotAsset = ReturnType<typeof makeSnapshotAssets>[number];

/** A freshly observed sealed snapshot of these assets. */
export function sealSnapshotOf(graph: string, assets: readonly SnapshotAsset[], version = '1') {
  return sealPublicGraphSnapshot({ version: 1, chainId: 'evm:31337', deploymentId: 'test',
    contextGraphId: graph, onChainId: '1', nameHash: ethers.id(graph),
    contextGraphStorage: SNAPSHOT_AUTHOR, assetStorage: SNAPSHOT_AUTHOR,
    blockNumber: '10', blockHash: `0x${'a'.repeat(64)}`, finalityConfirmations: 1, observedAt: Date.now(),
    expiresAt: Date.now() + 120_000, accessPolicy: 0,
    assets: assets.map(asset => ({ id: asset.kaId.toString(), root: asset.root, version })) });
}

export async function countStoredAssets(store: OxigraphStore, assets: readonly SnapshotAsset[]) {
  let stored = 0;
  for (const asset of assets) {
    const result = await store.query(`ASK { GRAPH <${asset.assertionGraph}> { ?s ?p ?o } }`);
    if (result.type === 'boolean' && result.value) stored++;
  }
  return stored;
}
