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
  ASSERTION_PUBLISH_RECEIPT_PREDICATES,
  assertionLifecycleUri,
  buildAuthorAttestationTypedData,
  contextGraphAssertionUri,
  contextGraphMetaUri
} from '@origintrail-official/dkg-core';
import {
  VM_CURRENT_ASSERTION_PRED,
  computeFlatKCRootV10,
  computePrivateRootV10,
  skolemizeKnowledgeAssetParts
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { expect, onTestFinished, vi } from 'vitest';
import { DKGAgent } from '../../src/index.js';
import { makeTestKaNumberAllocator } from '../_helpers/ka-allocator.js';

export const wallet = new ethers.Wallet(`0x${'35'.repeat(32)}`);
export const AUTHOR = wallet.address;
export const CONTEXT_GRAPH = 'late-mint-cg';
export const ON_CHAIN_CONTEXT_GRAPH = 1n;
export const NAME = 'lots-2026-08-12';
export const RESERVED_KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
export const QUADS = [{ subject: 'urn:lot:2026-08-12', predicate: 'http://schema.org/name', object: '"Lot 12"', graph: '' }];
export const MERKLE_ROOT = computeFlatKCRootV10(QUADS, []);
export const ZERO = new Uint8Array(32);

export interface AssetContent { quads: Quad[]; privateQuads: Quad[]; accessPolicy?: 'public' | 'ownerOnly' | 'allowList'; allowedPeers?: string[] }

/** The KC root finalize seals for this content: canonical public triples plus the private root. */
export async function sealedRootOf({ quads, privateQuads }: AssetContent): Promise<Uint8Array> {
  const canonical = await skolemizeKnowledgeAssetParts(quads, privateQuads);
  const privateRoot = computePrivateRootV10(canonical.privateQuads);
  return computeFlatKCRootV10(canonical.publicQuads, privateRoot ? [privateRoot] : []);
}
export const PUBLISHED_UAL_PRED = 'http://dkg.io/ontology/publishedUal';
export const SWM_SHARE_COMPLETE_PRED = 'http://dkg.io/ontology/swmShareComplete';
export const LIFECYCLE = assertionLifecycleUri(CONTEXT_GRAPH, AUTHOR, NAME);
export const ASSERTION = contextGraphAssertionUri(CONTEXT_GRAPH, AUTHOR, NAME);
export const PUBLISHED_AT_TX_PRED = ASSERTION_PUBLISH_RECEIPT_PREDICATES.PUBLISHED_AT_TX;
export const META_GRAPH = contextGraphMetaUri(CONTEXT_GRAPH);
export const RECONCILE = { contextGraphId: CONTEXT_GRAPH, name: NAME };
/** Where the synchronous publish keeps its checkpoints (named-publish-finalization.ts); a queued publish writes none. */
export const NAMED_FINALIZATION_GRAPH = 'urn:dkg:publisher:named-finalization';

/** The mock chain with a real publish wallet, which the vm/publish path needs to sign. */
export class WalletMockChain extends MockChainAdapter {
  constructor() {
    super('mock:31337', wallet.address);
  }

  override async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const signature = ethers.Signature.from(await wallet.signMessage(messageHash));
    return { r: ethers.getBytes(signature.r), vs: ethers.getBytes(signature.yParityAndS) };
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return wallet.signTypedData(domain, types, value);
  }
}

/**
 * A finalized, fully shared asset whose own mint already landed on chain
 * unobserved. `publisherAddress` gives the node a wallet to publish with.
 */
export async function strandedAsset(chain: MockChainAdapter, publisherAddress?: string, subGraphName?: string, content?: AssetContent) {
  const store = new OxigraphStore();
  const agent = await DKGAgent.create({
    name: 'LateMintNode', listenPort: 0, listenHost: '127.0.0.1', store,
    chainAdapter: chain, nodeRole: 'core', skills: [], kaNumberAllocator: makeTestKaNumberAllocator(),
    ...(publisherAddress ? { publisherAddress } : {}),
  });
  onTestFinished(async () => { await agent.stop().catch(() => {}); });
  await agent.start();
  vi.spyOn(agent, 'getContextGraphOnChainId').mockResolvedValue(ON_CHAIN_CONTEXT_GRAPH.toString());
  // A public graph: no member ciphertext (as in the other named-publish agent tests).
  vi.spyOn(agent as unknown as { _resolveInlineEncryption(): Promise<object> }, '_resolveInlineEncryption')
    .mockResolvedValue({});
  const accessPolicy = vi.spyOn(agent, 'resolveOnChainAccessPolicyState').mockResolvedValue(0);
  await agent.createContextGraph({ id: CONTEXT_GRAPH, name: CONTEXT_GRAPH });
  if (subGraphName) {
    await agent.createSubGraph(CONTEXT_GRAPH, subGraphName);
  }
  const { sealed, lostMint, history } = await strandAuthorAsset(agent, chain, wallet, subGraphName, content);
  const createKnowledgeAssets = vi.spyOn(chain, 'createKnowledgeAssets');
  const updateKnowledgeCollection = vi.spyOn(chain, 'updateKnowledgeCollectionV10');
  return { agent, store, sealed, lostMint, history, createKnowledgeAssets, updateKnowledgeCollection, accessPolicy };
}

/** One author's finalized, shared asset named NAME on the running agent, whose mint landed unobserved. */
export async function strandAuthorAsset(
  agent: DKGAgent,
  chain: MockChainAdapter,
  author: ethers.Wallet,
  subGraphName?: string,
  content: AssetContent = { quads: QUADS, privateQuads: [] },
) {
  const reservedKaId = (BigInt(author.address) << 96n) | 7n;
  const merkleRoot = await sealedRootOf(content);
  const typedData = buildAuthorAttestationTypedData({
    chainId: await chain.getEvmChainId(),
    kav10Address: await chain.getKnowledgeAssetsLifecycleAddress(),
    authorAddress: author.address, merkleRoot, reservedKaId, schemeVersion: 1,
  });
  const signed = ethers.Signature.from(await author.signTypedData(typedData.domain, typedData.types, typedData.message));
  const signature = { r: ethers.getBytes(signed.r), vs: ethers.getBytes(signed.yParityAndS) };
  const preSignedAuthorAttestation = { address: author.address, reservedKaId, signature };
  const agentAddress = author.address;
  await agent.assertion.create(CONTEXT_GRAPH, NAME, { agentAddress, reservedKaId, subGraphName });
  if (content.quads.length > 0) await agent.assertion.write(CONTEXT_GRAPH, NAME, content.quads, { agentAddress, subGraphName });
  if (content.privateQuads.length > 0) {
    await agent.publisher.assertionWritePrivate(CONTEXT_GRAPH, NAME, agentAddress, content.privateQuads, subGraphName);
  }
  const sealed = await agent.assertion.finalize(CONTEXT_GRAPH, NAME, { agentAddress, preSignedAuthorAttestation, subGraphName });
  await agent.assertion.promote(CONTEXT_GRAPH, NAME, { agentAddress, preSignedAuthorAttestation, entities: 'all', subGraphName, accessPolicy: content.accessPolicy, allowedPeers: content.allowedPeers });

  // The first publish attempt's transaction, which mined after the node gave up on its receipt.
  const lostMint = await chain.createKnowledgeAssets({
    publishOperationId: 'lost-attempt',
    contextGraphId: ON_CHAIN_CONTEXT_GRAPH,
    publisherAddress: chain.signerAddress,
    reservedKaId,
    merkleRoot,
    knowledgeAssetsAmount: 1,
    byteSize: 1n,
    epochs: 1,
    tokenAmount: 5n,
    isImmutable: false,
    author: { address: author.address, signature, schemeVersion: 1 },
    ackSignatures: [{ identityId: 1n, r: ZERO, vs: ZERO }],
  });
  const history = () => agent.assertion.history(CONTEXT_GRAPH, NAME, { agentAddress, subGraphName });
  expect(await history()).toMatchObject({ status: 'swm-shared', reservedUal: sealed.kaUal });
  return { sealed, lostMint, history };
}

/** Fail chosen lifecycle writes once each, as transient store failures would. */
export function lifecycleWriteFailures(target: DKGAgent, store: OxigraphStore) {
  const pending = new Set<string>();
  const stampLifecycle = target.publishedNamedKaVmLifecycleWriter;
  vi.spyOn(target, 'publishedNamedKaVmLifecycleWriter').mockImplementation(async input => {
    for (const predicate of [VM_CURRENT_ASSERTION_PRED, PUBLISHED_UAL_PRED]) {
      if (pending.delete(predicate)) throw new Error(`store write of ${predicate} failed`);
    }
    return stampLifecycle(input);
  });
  const insert = store.insert.bind(store);
  vi.spyOn(store, 'insert').mockImplementation(async (quads: Quad[]) => {
    const failing = quads.find((quad) => pending.delete(quad.predicate));
    if (failing) throw new Error(`store write of ${failing.predicate} failed`);
    return insert(quads);
  });
  return { failNext: (predicate: string) => { pending.add(predicate); } };
}

export function failNextLifecycleWrite(target: DKGAgent, store: OxigraphStore, predicate: string) {
  lifecycleWriteFailures(target, store).failNext(predicate);
}

export async function receiptTxHashes(store: OxigraphStore): Promise<string[]> {
  const receipt = await store.query(`SELECT ?tx WHERE { GRAPH <${META_GRAPH}> { <${ASSERTION}> <${PUBLISHED_AT_TX_PRED}> ?tx } }`);
  return receipt.type === 'bindings' ? receipt.bindings.map((row) => String(row['tx']).replace(/^"|"$/g, '')) : [];
}
