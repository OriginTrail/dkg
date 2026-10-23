// SPDX-License-Identifier: Apache-2.0
import { vi } from 'vitest';
import { ethers } from 'ethers';
import { assertionLifecycleUri, contextGraphMetaUri, contextGraphLayerUri, MemoryLayer } from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { applyVerifiedNamedKaDescriptor as applyPublishedNamedKaVmLifecycle } from '../../src/named-ka-vm-lifecycle.js';
import { AUTHOR, PUBLISHER, TX_HASH } from './named-ka-recovery-fixture.js';

const DKG = 'http://dkg.io/ontology/';
export async function descriptorRepairFixture(version = 1, sourceAuthor: string = AUTHOR, lifecycleOwner?: string) {
  const store = new OxigraphStore();
  const author = lifecycleOwner ?? ethers.getAddress(sourceAuthor);
  const input = { contextGraphId: 'repair-cg', name: 'published', kaUal: `did:dkg:evm:31337/${sourceAuthor}/402` };
  const kaId = (BigInt(sourceAuthor) << 96n) | 402n;
  const subject = assertionLifecycleUri(input.contextGraphId, author, input.name);
  const graph = contextGraphMetaUri(input.contextGraphId);
  const vm = contextGraphLayerUri(input.contextGraphId, MemoryLayer.VerifiableMemory, sourceAuthor, 402n);
  const content: Quad[] = [{ graph: vm, subject: 'urn:asset:body', predicate: 'urn:text', object: '"exact accepted revision"' }];
  const root = computeFlatKCRootV10(content, []);
  const snapshot = { latestRoot: ethers.hexlify(root), rootCount: BigInt(version), latestAuthor: sourceAuthor,
    latestPublisher: PUBLISHER, blockNumber: 100, blockHash: `0x${'11'.repeat(32)}` };
  const chain = {
    chainId: 'evm:31337',
    readKnowledgeAssetVersionSnapshot: vi.fn(async () => snapshot),
    getKAContextGraphId: vi.fn(async () => 1n), getMerkleRootCount: vi.fn(async () => BigInt(version)),
    isContextGraphActiveOnChain: vi.fn(async () => true), getContextGraphAccessPolicy: vi.fn(async () => 0),
    isReceiptBlockFinalAndCanonical: vi.fn(async () => true),
    verifyKAUpdate: vi.fn(async () => ({ verified: true, onChainMerkleRoot: root,
      merkleRootCount: BigInt(version), blockNumber: 90, blockHash: snapshot.blockHash, txIndex: 1 })),
    resolveCanonicalFinalizationReceipt: vi.fn(async () => ({ status: 'confirmed', receipt: {
      txHash: TX_HASH, blockNumber: 90, blockHash: snapshot.blockHash, txIndex: 1,
      merkleRoot: root, publisherAddress: PUBLISHER, authorAddress: sourceAuthor,
      kaId, batchId: kaId, startKAId: kaId, endKAId: kaId,
    } })),
  };
  const host = { store, chain: chain as unknown as ChainAdapter, writeLocks: new Map<string, Promise<void>>(),
    getContextGraphOnChainId: async () => '1',
    stampPublishedLifecycle: (input: Parameters<typeof applyPublishedNamedKaVmLifecycle>[1]) => applyPublishedNamedKaVmLifecycle(store, input) };
  const row = (p: string, value: string): Quad => ({ graph, subject, predicate: DKG + p, object: JSON.stringify(value) });
  await store.insert([...content, ...generateGraphKnowledgeAssetMetadata({
    ual: input.kaUal, contextGraphId: input.contextGraphId, merkleRoot: root, publisherPeerId: 'fixture',
    accessPolicy: 'public', allowedPeers: [], timestamp: new Date(), authorAddress: sourceAuthor,
    assertionVersion: version, publicTripleCount: 1, privateTripleCount: 0, assertionGraph: vm,
  }, { status: 'confirmed', confirmation: { kind: 'transaction', provenance: {
    txHash: TX_HASH, blockNumber: 90, blockTimestamp: 0, publisherAddress: PUBLISHER,
    batchId: kaId, chainId: 'evm:31337',
  } } }),
  ...Object.entries({ assertionName: input.name, kaId: '402', reservedUal: input.kaUal, publishedUal: input.kaUal,
    assertionVersion: String(version), memoryLayer: 'VM', vmCurrentAssertion: snapshot.latestRoot.slice(2),
    wmCurrentAssertion: snapshot.latestRoot.slice(2), swmCurrentAssertion: snapshot.latestRoot.slice(2),
    shareOperationId: 'original-share' }).map(([p, v]) => row(p, v)),
  { graph, subject, predicate: DKG + 'assertionGraph', object: vm },
  { graph, subject, predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: `did:dkg:agent:${author}` },
  ]);
  await host.stampPublishedLifecycle({ ...input, agentAddress: author, publishedUal: input.kaUal,
    merkleRoot: snapshot.latestRoot, packedKaId: kaId });
  await store.deleteByPattern({ graph, subject, predicate: DKG + 'state' });
  const all = async () => {
    const r = await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }');
    if (r.type !== 'bindings') throw new Error('bindings required');
    return r.bindings.map(r => JSON.stringify(r)).sort();
  };
  return { host, chain, store, input, subject, graph, vm, content, snapshot, row, all };
}

