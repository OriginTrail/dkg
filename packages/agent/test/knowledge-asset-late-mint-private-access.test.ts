import { TypedEventBus, contextGraphSharedMemoryMetaUri, decodeAccessResponse, ed25519Sign, encodeAccessRequest, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { AccessHandler, generateGraphKnowledgeAssetMetadata, resolveKnowledgeAssetWorkspaceHead } from '@origintrail-official/dkg-publisher';
import { GraphManager } from '@origintrail-official/dkg-storage';
/**
 * A named asset whose publish transaction mined after the node stopped
 * waiting, through the agent's real named-asset lifecycle: create, write,
 * finalize, share, then the lost mint lands on chain while the node still
 * reads `swm-shared`. Both the synchronous `vm/publish` retry (which reverts
 * `KaIdAlreadyMinted`) and the operator reconcile record that mint, and the
 * lifecycle ends `vm-confirmed` with the reserved UAL as its published UAL.
 * A reconcile interrupted after the share was consumed resumes from the
 * verified VM record.
 */
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  MemoryLayer,
  contextGraphCatalogUri,
  contextGraphFinalizationTopic,
  contextGraphLayerUri,
  decodeFinalizationMessage
} from '@origintrail-official/dkg-core';
import {
  VM_CURRENT_ASSERTION_PRED,
  computePrivateRootV10,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
  skolemizeKnowledgeAssetParts
} from '@origintrail-official/dkg-publisher';
import { type Quad } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KA_MINT_RECONCILE_INCOMPLETE_CODE } from '../src/index.js';

import { AUTHOR, CONTEXT_GRAPH, META_GRAPH, QUADS, RECONCILE, failNextLifecycleWrite, strandedAsset } from './support/late-mint-fixture.js';

describe('late-mint private-access', () => {
  afterEach(() => vi.restoreAllMocks());
  it('reconciles a curated asset from policy alone, without a signing key or sender-key setup', async () => {
    const chain = new MockChainAdapter();
    const { agent, store, sealed, lostMint, accessPolicy } = await strandedAsset(chain);
    accessPolicy.mockResolvedValue(1);
    vi.spyOn(chain, 'getContextGraphFinalizedCreation').mockResolvedValue({
      nameHash: ethers.keccak256(ethers.toUtf8Bytes(CONTEXT_GRAPH)), accessPolicy: 1,
    });
    const keyed = agent as unknown as Record<string, (...args: unknown[]) => unknown>;
    vi.spyOn(agent, 'getLocalSigningAgentForAddress').mockReturnValue(null);
    const recordExistingMint = vi.spyOn(agent.publisher, 'recordExistingMintFromSharedMemory');
    const livePublish = vi.spyOn(agent.publisher, 'publishFromSharedMemory');
    const liveFinalizedPublish = vi.spyOn(agent, 'publishFromFinalizedAssertion');
    const senderKeyWork = ['_resolveCuratedChainKeyContext', '_resolveInlineEncryption', 'loadSwmSenderKeyState', 'createV10ACKProvider']
      .map((method) => vi.spyOn(keyed, method));
    for (const spy of senderKeyWork) spy.mockClear();

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .resolves.toMatchObject({ status: 'adopted', ual: sealed.kaUal, txHash: lostMint.txHash });

    for (const spy of senderKeyWork) expect(spy).not.toHaveBeenCalled();
    // The curated catalog floor is recorded as the minting publish records it.
    const catalog = await store.query(`SELECT ?s WHERE { GRAPH <${contextGraphCatalogUri(CONTEXT_GRAPH)}> { ?s ?p ?o } }`);
    expect(catalog.type === 'bindings' && catalog.bindings.length).toBeGreaterThan(0);
    expect(livePublish).not.toHaveBeenCalled();
    expect(liveFinalizedPublish).not.toHaveBeenCalled();
    expect(recordExistingMint).toHaveBeenCalledOnce();
    expect(recordExistingMint.mock.calls[0]?.[2]).toEqual({ kind: 'prepared', evidence: expect.any(Object) });
    const options = recordExistingMint.mock.calls[0]?.[3];
    expect(options?.trustedNonManifestCatalogTriples?.size ?? options?.trustedNonManifestCatalogTriples?.length).toBeGreaterThan(0);
    expect(options?.encryptInlinePayload).toBeUndefined();
    expect(options?.encryptInlineChunked).toBeUndefined();
  });


  it.each([false, true])('preserves the persisted private allow-list and original publisher (receiptless public metadata=%s)', async receiptless => {
    const secret: Quad = { subject: 'urn:lot:2026-08-12', predicate: 'urn:private-note', object: '"allowed reader secret"', graph: '' };
    const { agent, store, sealed, createKnowledgeAssets } = await strandedAsset(new MockChainAdapter(), undefined, undefined,
      { quads: QUADS, privateQuads: [secret], accessPolicy: 'allowList', allowedPeers: ['reader-peer'] });
    // Model a retained share originating at another peer, now recovered by this node.
    const graph = contextGraphSharedMemoryMetaUri(CONTEXT_GRAPH);
    const predicate = 'http://dkg.io/ontology/publisherPeerId';
    const metadata = await store.query(`CONSTRUCT { ?s <${predicate}> ?o } WHERE { GRAPH <${graph}> { ?s <${predicate}> ?o } }`);
    if (metadata.type !== 'quads' || metadata.quads.length === 0) throw new Error('Missing persisted share publisher');
    await store.deleteByPattern({ graph, predicate });
    await store.insert(metadata.quads.map(q => ({ ...q, graph, object: '"original-share-peer"' })));
    expect(await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store),
      contextGraphId: CONTEXT_GRAPH, kaUal: sealed.kaUal! })).toMatchObject({ publisherPeerId: 'original-share-peer',
      access: { accessPolicy: 'allowList', allowedPeers: ['reader-peer'] } });
    if (receiptless) {
      const { publicQuads, privateQuads } = await skolemizeKnowledgeAssetParts(QUADS, [secret]);
      const assertionGraph = contextGraphLayerUri(CONTEXT_GRAPH, MemoryLayer.VerifiableMemory, AUTHOR.toLowerCase(), 7n);
      await store.insert([...publicQuads.map(q => ({ ...q, graph: assertionGraph })), ...generateGraphKnowledgeAssetMetadata({
        ual: sealed.kaUal!, contextGraphId: CONTEXT_GRAPH, assertionGraph,
        merkleRoot: sealed.merkleRoot, assertionVersion: 1, authorAddress: AUTHOR,
        publisherPeerId: 'receiptless-chain-peer', accessPolicy: 'public', allowedPeers: [], timestamp: new Date(0),
        publicTripleCount: publicQuads.length, privateTripleCount: privateQuads.length,
        privateMerkleRoot: computePrivateRootV10(privateQuads)!,
      }, { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: {
        batchId: sealed.reservedKaId!, materializedVersion: { blockNumber: 1, txIndex: 0 },
      } } })]);
    }
    const gossip = vi.spyOn((agent as any).gossip, 'publish');
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).resolves.toMatchObject({ status: 'adopted' });
    const finalization = gossip.mock.calls.filter(([topic]) => topic === contextGraphFinalizationTopic(CONTEXT_GRAPH))
      .map(([, bytes]) => decodeFinalizationMessage(bytes as Uint8Array));
    const owner = await store.query(`SELECT ?owner WHERE { GRAPH <${META_GRAPH}> { <${sealed.kaUal}> <${predicate}> ?owner } }`);
    const handler = new AccessHandler(store, new TypedEventBus());
    for (const [peer, allowed] of [['reader-peer', true], ['stranger-peer', false]] as const) {
      const keypair = await generateEd25519Keypair();
      const signature = await ed25519Sign(new TextEncoder().encode(sealed.kaUal!), keypair.secretKey);
      const response = decodeAccessResponse(await handler.handler(encodeAccessRequest({ kaUal: sealed.kaUal!,
        requesterPeerId: peer, paymentProof: new Uint8Array(0), requesterSignature: signature,
        requesterPublicKey: keypair.publicKey }), peer as never));
      expect(response.granted, response.rejectionReason).toBe(allowed);
      if (allowed) expect(new TextDecoder().decode(response.nquads)).toContain('allowed reader secret');
      else expect(response.rejectionReason).toMatch(/allow/i);
    }
    expect(owner).toMatchObject({ type: 'bindings', bindings: [{ owner: '"original-share-peer"' }] });
    expect(finalization).toContainEqual(expect.objectContaining({ accessPolicy: 'allowList', allowedPeers: ['reader-peer'] }));
    if (receiptless) {
      const retained = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, { contextGraphId: CONTEXT_GRAPH, ual: sealed.kaUal! });
      expect(retained.state === 'confirmed' && retained.envelope.transactionHash).toBeUndefined();
    }
    expect(createKnowledgeAssets).not.toHaveBeenCalled();
  });


  it('records a private-only late mint and resumes it, keeping the private content and its commitment', async () => {
    const secret: Quad = { subject: 'urn:lot:2026-08-12', predicate: 'http://schema.org/description', object: '"farm-only notes"', graph: '' };
    const content = { quads: [], privateQuads: [secret] };
    const { agent, store, sealed, lostMint, history, createKnowledgeAssets } =
      await strandedAsset(new MockChainAdapter(), undefined, undefined, content);
    expect(sealed.publicTripleCount).toBe(0);
    const privateRoot = computePrivateRootV10((await skolemizeKnowledgeAssetParts([], [secret])).privateQuads)!;
    const keyed = agent as unknown as Record<string, (...args: unknown[]) => unknown>;
    const memberEncryption = ['_resolveInlineEncryption', '_resolveCuratedChainKeyContext', 'createV10ACKProvider']
      .map((method) => vi.spyOn(keyed, method));
    for (const spy of memberEncryption) spy.mockClear();
    const secretCopies = async () => {
      const result = await store.query(`SELECT ?g WHERE { GRAPH ?g { <${secret.subject}> <${secret.predicate}> ${secret.object} } }`);
      return result.type === 'bindings' ? result.bindings.length : 0;
    };
    failNextLifecycleWrite(agent, store, VM_CURRENT_ASSERTION_PRED);

    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE)).rejects.toMatchObject({ code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
    await expect(agent.reconcileKnowledgeAssetMint(RECONCILE))
      .resolves.toMatchObject({ status: 'adopted', ual: sealed.kaUal, txHash: lostMint.txHash });

    expect(await history()).toMatchObject({ status: 'vm-confirmed', publishedUal: sealed.kaUal });
    expect(await readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, { contextGraphId: CONTEXT_GRAPH, ual: sealed.kaUal }))
      .toMatchObject({ state: 'confirmed', envelope: { publicTripleCount: 0, privateTripleCount: 1, privateMerkleRoot: privateRoot } });
    expect(await secretCopies()).toBeGreaterThan(0);
    expect(createKnowledgeAssets).not.toHaveBeenCalled();
    for (const spy of memberEncryption) expect(spy).not.toHaveBeenCalled();
  });


});
