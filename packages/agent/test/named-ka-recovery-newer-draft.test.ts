// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { getBytes, hexlify } from 'ethers';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { assertionLifecycleUri, contextGraphLayerUri, contextGraphMetaUri, MemoryLayer, parseAssertionSealQuads } from '@origintrail-official/dkg-core';
import { TripleStoreAsyncLiftPublisher, assertionRecoverySealGraph, assertionRecoverySealSubject,
  computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata, replaceLocallyTrustedKnowledgeAssetControlEnvelope,
} from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/dkg-agent.js';
import { KA_VM_VALIDATION } from '../../../scripts/testing/ka-vm-publish.js';
import { AUTHOR, TX_HASH, baseRequest, legacyEvidence, seededChain } from './_helpers/named-ka-recovery-fixture.js';

it.each(['draft', 'shared', 'missing-vm-pointer'] as const)(
  'keeps the original job pending until confirmed controls commit, preserving newer %s', async variant => {
  const store = new OxigraphStore();
  const payload = [{ graph: '', subject: 'urn:original', predicate: 'urn:value', object: '"confirmed"' }];
  const merkleRoot = hexlify(computeFlatKCRootV10(payload, [])) as `0x${string}`;
  const agent = await DKGAgent.create({ name: 'newer-draft-recovery', store, chainAdapter: seededChain(merkleRoot),
    rfc64CatalogActivation: { enabled: false } });
  vi.spyOn(agent, 'peerId', 'get').mockReturnValue('12D3KooWRecoveryFixture');
  const base = baseRequest(), request = { ...base, agentAddress: AUTHOR, sealMerkleRoot: merkleRoot,
    seal: { ...base.seal, merkleRoot } };
  const prior = legacyEvidence(), evidence = { ...prior, publishProof: { ...prior.publishProof, merkleRoot } };
  vi.spyOn((agent as any).chain, 'getKnowledgeAssetsLifecycleAddress').mockResolvedValue(request.sealKav10Address);
  const graph = contextGraphMetaUri(request.contextGraphId), subject = assertionLifecycleUri(request.contextGraphId, AUTHOR, request.name);
  const vm = contextGraphLayerUri(request.contextGraphId, MemoryLayer.VerifiableMemory, AUTHOR, 402n);
  const wm = contextGraphLayerUri(request.contextGraphId, MemoryLayer.WorkingMemory, AUTHOR, 402n);
  const dkg = 'http://dkg.io/ontology/', nextRoot = 'cd'.repeat(32);
  const state = variant === 'shared' ? 'promoted' : 'created', layer = variant === 'shared' ? 'SWM' : 'WM';
  const draft = [{ graph: wm, subject: 'urn:newer', predicate: 'urn:value', object: '"unpublished"' }];
  const executor = vi.fn(async () => { throw new Error('must never publish again'); });
  const queue = new TripleStoreAsyncLiftPublisher(store, {
    chainProofResolver: async () => ({ status: 'recovered', recovery: evidence }),
    knowledgeAssetVmPublishRecoveryResolver: async () => evidence,
    knowledgeAssetVmPublishHandler: { execute: executor,
      finalizeRecovered: input => agent.finalizeRecoveredQueuedKnowledgeAssetVmPublish(input) },
  });
  try {
    await store.insert([
      ...payload.map(q => ({ ...q, graph: vm })), ...draft,
      ...generateGraphKnowledgeAssetMetadata({ ual: request.kaUal!, contextGraphId: request.contextGraphId,
        merkleRoot: getBytes(merkleRoot), assertionVersion: '1', publicTripleCount: 1, privateTripleCount: 0,
        assertionGraph: vm, authorAddress: AUTHOR, publisherPeerId: '12D3KooWRecoveryFixture',
        accessPolicy: 'public', allowedPeers: [], timestamp: new Date(request.sealFinalizedAtIso),
      }, { status: 'confirmed', confirmation: { kind: 'transaction', provenance: {
        txHash: TX_HASH, blockNumber: 77, blockTimestamp: 1_700_000_077, publisherAddress: AUTHOR,
        batchId: BigInt(request.seal.reservedKaId!), chainId: request.sealChainId,
      } } }),
      ...Object.entries({ state, memoryLayer: layer, assertionName: request.name, kaId: '402',
        reservedUal: request.kaUal!, shareOperationId: 'newer-share-operation', assertionVersion: '2',
        wmCurrentAssertion: nextRoot, ...(variant === 'shared' ? { swmCurrentAssertion: nextRoot } : {}),
        ...(variant !== 'missing-vm-pointer' ? { vmCurrentAssertion: merkleRoot.slice(2) } : {}) }).map(([p, value]) => ({ graph, subject,
        predicate: dkg + p, object: JSON.stringify(value) + (p === 'kaId' ? '^^<http://www.w3.org/2001/XMLSchema#integer>' : '') })),
      { graph, subject, predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: `did:dkg:agent:${AUTHOR}` },
    ]);
    await replaceLocallyTrustedKnowledgeAssetControlEnvelope(store, request.kaUal!,
      { assertionVersion: '1', merkleRoot: getBytes(merkleRoot) },
      { publisherPeerId: '12D3KooWRecoveryFixture', accessPolicy: 'public', allowedPeers: [] });
    // The background reconciler has already restored exact VM content and metadata.
    vi.spyOn(agent as any, 'getOrCreateFinalizationHandler').mockReturnValue({ handleChainReconciledKC: async () => 'already-confirmed' });
    vi.spyOn(agent, 'getContextGraphOnChainId').mockResolvedValue('1');
    const id = await queue.enqueueKnowledgeAssetVmPublish(request);
    await queue.claimNext('wallet');
    await queue.update(id, 'validated', { validation: KA_VM_VALIDATION });
    await queue.update(id, 'broadcast', { broadcast: { txHash: TX_HASH, walletId: 'wallet', operationKind: 'create' } });
    const archive = assertionRecoverySealSubject(request.contextGraphId, request.name, AUTHOR);
    const archiveGraph = assertionRecoverySealGraph(request.contextGraphId);
    const archived = () => store.query(`CONSTRUCT { <${archive}> ?p ?o } WHERE { GRAPH <${archiveGraph}> { <${archive}> ?p ?o } }`);
    expect(await archived()).toMatchObject({ quads: [] });
    const fault = vi.spyOn(agent.store, 'replaceSubject').mockRejectedValue(new Error('confirmed controls unavailable'));
    expect(await queue.recover()).toBe(0);
    expect((await queue.getStatus(id))?.status).toBe('broadcast');
    expect(executor).not.toHaveBeenCalled();
    fault.mockRestore();
    expect(await queue.recover()).toBe(1);
    expect((await queue.getStatus(id))?.status).toBe('finalized');
    const seal = await archived();
    expect(seal.type === 'quads' && parseAssertionSealQuads(seal.quads, archive)).toMatchObject({
      merkleRoot: getBytes(merkleRoot), assertionVersion: '1', kaUal: request.kaUal,
      reservedKaId: BigInt(request.seal.reservedKaId!), publicTripleCount: 1, privateTripleCount: 0,
    });
    expect(await agent.assertion.history(request.contextGraphId, request.name, { agentAddress: AUTHOR }))
      .toMatchObject({ state, memoryLayer: layer, wmCurrentAssertion: nextRoot, kaNumber: '402',
        currentShareOperationId: 'newer-share-operation', ...(variant === 'shared' ? { swmCurrentAssertion: nextRoot } : {}),
        reservedUal: request.kaUal, vmCurrentAssertion: merkleRoot.slice(2) });
    expect(await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${wm}> { ?s ?p ?o } }`))
      .toMatchObject({ quads: draft.map(q => ({ ...q, graph: '' })) });
    expect(executor).not.toHaveBeenCalled();
  } finally { await agent.stop(); }
});
