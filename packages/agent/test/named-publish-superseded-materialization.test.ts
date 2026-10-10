/**
 * A named publish whose confirmed materialization is superseded must not move
 * the named lifecycle back to its assertion.
 *
 * The race: a retry of assertion R1 reaches `KaIdAlreadyMinted` and adopts the
 * original mint. While adoption is still recovering the receipt, a newer
 * assertion R2 of the same KA completes locally. The publisher's version gate
 * then keeps R2's rows and skips R1, but `publish()` still reports R1 as
 * confirmed. The named publication caller must keep R2 current while recording
 * R1's own publish receipt.
 *
 * Hermetic: the real agent entrypoint and a real DKGPublisher over an
 * in-memory store and a MockChainAdapter whose mint reverts as already minted.
 */
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  ASSERTION_PUBLISH_RECEIPT_PREDICATES,
  AUTHOR_SCHEME_VERSION_V1,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  TypedEventBus,
  assertionLifecycleUri,
  buildAssertionSealQuads,
  buildAuthorAttestationTypedData,
  buildUpdateAuthorAttestationTypedData,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { MockChainAdapter, type AdoptedMintPublishResult, type OnChainPublishResult } from '@origintrail-official/dkg-chain';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  DKGPublisher,
  VM_CURRENT_ASSERTION_PRED,
  computeFlatKCRootV10,
  readMaterializedVersion,
  type PublishOptions,
} from '@origintrail-official/dkg-publisher';
import { applyPublishedNamedKaVmLifecycle } from '../src/named-ka-vm-lifecycle.js';
import { stubAgent } from './_helpers/foreign-author-resolution-fixtures.js';

const CG = '1';
const NAME = 'raced-asset';
// Must equal MockChainAdapter.getKnowledgeAssetsLifecycleAddress(): the
// publisher verifies the seal against the adapter's deployment.
const KAV10 = '0x000000000000000000000000000000000000c10a';
const WALLET = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const AUTHOR = WALLET.address;
const KA_NUMBER = 1n;
const KA_ID = (BigInt(AUTHOR) << 96n) | KA_NUMBER;
const KA_UAL = `did:dkg:31337/${AUTHOR.toLowerCase()}/${KA_NUMBER}`;
const META = contextGraphMetaUri(CG);
const LIFECYCLE = assertionLifecycleUri(CG, AUTHOR, NAME);
const ASSERTION = contextGraphAssertionUri(CG, AUTHOR, NAME);

const quad = (label: string): Quad => ({
  subject: 'urn:test:raced-asset', predicate: 'http://schema.org/name', object: `"${label}"`, graph: '',
});
const R1 = quad('R1');
const R2 = quad('R2');
const R1_ROOT = computeFlatKCRootV10([R1], []);
const R2_ROOT = computeFlatKCRootV10([R2], []);
const bare = (root: Uint8Array) => ethers.hexlify(root).slice(2);

/** Mock chain whose mint retry reverts as already minted and whose adoption can be held. */
class AdoptableMintChain extends MockChainAdapter {
  mintError?: unknown;
  provenance: AdoptedMintPublishResult | null = null;
  provenanceGate: Promise<void> = Promise.resolve();
  readonly adoptionStarted = Promise.withResolvers<void>();

  constructor() {
    super('mock:31337', AUTHOR);
    this.seedIdentity(AUTHOR, 1n);
    this.minimumRequiredSignatures = 1;
  }

  override async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const signature = ethers.Signature.from(await WALLET.signMessage(messageHash));
    return { r: ethers.getBytes(signature.r), vs: ethers.getBytes(signature.yParityAndS) };
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return WALLET.signTypedData(domain, types, value);
  }

  override async createKnowledgeAssets(
    params: Parameters<MockChainAdapter['createKnowledgeAssets']>[0],
  ): Promise<OnChainPublishResult> {
    if (this.mintError !== undefined) throw this.mintError;
    return super.createKnowledgeAssets(params);
  }

  override async getMintedKnowledgeAssetProvenance(): Promise<AdoptedMintPublishResult | null> {
    this.adoptionStarted.resolve();
    await this.provenanceGate;
    return this.provenance;
  }
}

async function sign(typedData: { domain: ethers.TypedDataDomain; types: any; message: any }) {
  const signature = ethers.Signature.from(
    await WALLET.signTypedData(typedData.domain, typedData.types, typedData.message),
  );
  return { r: ethers.getBytes(signature.r), vs: ethers.getBytes(signature.yParityAndS) };
}

const ackProvider: NonNullable<PublishOptions['v10ACKProvider']> = async () => {
  const signature = ethers.Signature.from(await WALLET.signMessage('superseded-adoption-ack'));
  return [{ peerId: 'ack-peer', signatureR: ethers.getBytes(signature.r),
    signatureVS: ethers.getBytes(signature.yParityAndS), nodeIdentityId: 1n }];
};

async function readPointer(store: OxigraphStore): Promise<string | undefined> {
  const result = await store.query(
    `SELECT ?vm WHERE { GRAPH <${META}> { <${LIFECYCLE}> <${VM_CURRENT_ASSERTION_PRED}> ?vm } }`,
  );
  if (result.type !== 'bindings') return undefined;
  expect(result.bindings.length).toBeLessThanOrEqual(1);
  return result.bindings[0]?.['vm']?.replace(/^"|"$/g, '');
}

async function readReceiptTx(store: OxigraphStore): Promise<string[]> {
  const result = await store.query(`SELECT ?tx WHERE { GRAPH <${META}> {
    <${ASSERTION}> <${ASSERTION_PUBLISH_RECEIPT_PREDICATES.PUBLISHED_AT_TX}> ?tx } }`);
  return result.type === 'bindings' ? result.bindings.map((row) => JSON.parse(String(row['tx']))) : [];
}

/**
 * R1 is minted and materialized, but its named lifecycle was never stamped
 * (the in-band result was lost). The finalized R1 seal and its share are still
 * resident, so a VM publish of the name takes the mint path again.
 */
async function lostMintFixture() {
  const store = new OxigraphStore();
  const chain = new AdoptableMintChain();
  const publisher = new DKGPublisher({
    store, chain, eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair(),
    publisherNodeIdentityId: 1n,
  });
  const attestation = await sign(buildAuthorAttestationTypedData({
    chainId: 31337n, kav10Address: KAV10, merkleRoot: R1_ROOT, authorAddress: AUTHOR, reservedKaId: KA_ID,
  }));
  const minted = await publisher.publish({
    contextGraphId: CG, quads: [R1], publisherPeerId: 'race-publisher',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION, kaUal: KA_UAL, assertionVersion: 1,
    publicTripleCount: 1, privateTripleCount: 0, v10ACKProvider: ackProvider,
    precomputedAttestation: { expectedMerkleRoot: R1_ROOT, authorAddress: AUTHOR, signature: attestation,
      schemeVersion: AUTHOR_SCHEME_VERSION_V1, reservedKaId: KA_ID },
  });
  expect(minted.status).toBe('confirmed');
  const mintVersion = await readMaterializedVersion(store, META, KA_UAL);
  if (!mintVersion) throw new Error('The original mint must persist its ordering fence');
  await store.insert(buildAssertionSealQuads({
    assertionUri: ASSERTION, metaGraph: META, merkleRoot: R1_ROOT, authorAddress: AUTHOR,
    authorAttestationR: attestation.r, authorAttestationVS: attestation.vs,
    authorSchemeVersion: AUTHOR_SCHEME_VERSION_V1, chainId: 31337n, kav10Address: KAV10,
    reservedKaId: KA_ID, finalizedAtIso: '2026-10-10T00:00:00.000Z',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION, kaUal: KA_UAL, assertionVersion: 1,
    publicTripleCount: 1, privateTripleCount: 0,
  }) as Quad[]);

  // The retry reverts as already minted and adopts the original transaction.
  chain.mintError = Object.assign(new Error(`execution reverted: KaIdAlreadyMinted(${KA_ID})`),
    { code: 'CALL_EXCEPTION', revert: { name: 'KaIdAlreadyMinted', args: [KA_ID] } });
  chain.provenance = await MockChainAdapter.prototype.getMintedKnowledgeAssetProvenance.call(
    chain, KA_ID, R1_ROOT, BigInt(CG));
  if (!chain.provenance) throw new Error('The mock mint must expose adoptable provenance');
  const releaseAdoption = Promise.withResolvers<void>();
  chain.provenanceGate = releaseAdoption.promise;

  const agent = stubAgent(store, AUTHOR);
  agent.chain = {};
  agent.publisher = publisher;
  agent._loadSelectedSWMQuads = async () => [R1];
  agent.resolveRfc64CatalogAuthoringLaneV1 = () => null;
  agent.removeRfc64SwmAuthorInventoryShadowV1 = async () => ({ status: 'absent' });
  agent.requestRfc64SwmCatalogProjectionV1 = () => {};
  vi.spyOn(publisher, 'hasSwmShareComplete').mockResolvedValue(true);
  const clearShareComplete = vi.spyOn(publisher, 'clearSwmShareComplete').mockResolvedValue(undefined);
  const clearRemainingShares = vi.spyOn(publisher, 'clearRemainingSharedMemory').mockResolvedValue(undefined);
  // The production wrapper reads the same share and calls this publish.
  agent.publishFromSharedMemory = async (contextGraphId: string, _selection: unknown, opts: any) =>
    publisher.publish({
      contextGraphId, quads: [R1], publisherPeerId: 'race-publisher', v10ACKProvider: ackProvider,
      contentScopeVersion: opts.contentScopeVersion, kaUal: opts.kaUal, assertionVersion: opts.assertionVersion,
      publicTripleCount: opts.publicTripleCount, privateTripleCount: opts.privateTripleCount,
      precomputedAttestation: opts.precomputedAttestation,
    });

  // Queued execution: no live encryption, a recorded gossip lane, and an exact
  // SWM cleanup that is version-bounded (kept for a superseded result).
  agent._resolveInlineEncryption = async () => ({});
  Object.defineProperty(agent, 'gossip', { value: { publish: vi.fn(async () => undefined) } });
  vi.spyOn(publisher, 'clearPublishedKnowledgeAssetSwm').mockResolvedValue(undefined);
  agent.retireLegacySwmAfterVerifiedVmTwin = async () => undefined;
  const signature = { r: ethers.hexlify(attestation.r), vs: ethers.hexlify(attestation.vs) };
  const queuedRequest = {
    contextGraphId: CG, name: NAME, agentAddress: AUTHOR, shareOperationId: 'race-share', roots: [],
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION, kaUal: KA_UAL, assertionVersion: '1',
    publicTripleCount: 1, privateTripleCount: 0, sealMerkleRoot: ethers.hexlify(R1_ROOT),
    seal: { merkleRoot: ethers.hexlify(R1_ROOT), authorAddress: AUTHOR, schemeVersion: AUTHOR_SCHEME_VERSION_V1,
      reservedKaId: KA_ID.toString(), signature },
    sealChainId: '31337', sealKav10Address: KAV10, sealFinalizedAtIso: '2026-10-10T00:00:00.000Z',
    intentKey: `sha256:${'ab'.repeat(32)}`, clearSharedMemoryAfter: true,
  };
  const queuedPublishOptions = { contextGraphId: CG, quads: [R1], publisherPeerId: 'race-publisher',
    v10ACKProvider: ackProvider };

  /** R2 confirms on chain after the mint and the update route stamps it current. */
  const completeNewerAssertion = async () => {
    const version = { blockNumber: mintVersion.blockNumber + 1, txIndex: 0 };
    vi.spyOn(chain, 'updateKnowledgeCollectionV10').mockResolvedValue({
      success: true, hash: `0x${'de'.repeat(32)}`, ...version,
    });
    const updated = await publisher.update(KA_ID, {
      contextGraphId: CG, onChainContextGraphId: 1n, quads: [R2],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION, kaUal: KA_UAL, assertionVersion: 2,
      publicTripleCount: 1, privateTripleCount: 0,
      precomputedUpdateAttestation: {
        expectedNewMerkleRoot: R2_ROOT, authorAddress: AUTHOR, schemeVersion: AUTHOR_SCHEME_VERSION_V1,
        signature: await sign(buildUpdateAuthorAttestationTypedData({
          chainId: 31337n, kav10Address: KAV10, kaId: KA_ID, newMerkleRoot: R2_ROOT, authorAddress: AUTHOR,
        })),
      },
    });
    expect(updated.status).toBe('confirmed');
    await applyPublishedNamedKaVmLifecycle(store, {
      contextGraphId: CG, agentAddress: AUTHOR, name: NAME, publishedUal: KA_UAL,
      merkleRoot: bare(R2_ROOT), packedKaId: KA_ID,
    });
    return version;
  };
  return { store, chain, agent, minted, releaseAdoption, clearShareComplete, clearRemainingShares,
    completeNewerAssertion, queuedRequest, queuedPublishOptions };
}

describe('named publish whose adopted materialization is superseded', () => {
  it.each(['sync vm/publish', 'queued vm/publish'] as const)('%s keeps the newer VM assertion current and records only the adopted receipt', async (entrypoint) => {
    const f = await lostMintFixture();
    try {
      expect(await readPointer(f.store)).toBeUndefined();
      const publishing = entrypoint === 'sync vm/publish'
        ? f.agent.publishFromFinalizedAssertion(CG, NAME, { agentAddress: AUTHOR, clearSharedMemoryAfter: true })
        : f.agent.publishQueuedKnowledgeAssetVmPublish(f.queuedRequest, f.queuedPublishOptions);
      const settled = publishing.then((result: any) => ({ result }), (error: unknown) => ({ error }));
      await f.chain.adoptionStarted.promise;

      const newer = await f.completeNewerAssertion();
      expect(await readPointer(f.store)).toBe(bare(R2_ROOT));
      f.releaseAdoption.resolve();

      const outcome = await settled;
      if ('error' in outcome) throw outcome.error;
      // The skipped R1 materialization moves no current named-lifecycle state...
      expect(await readPointer(f.store)).toBe(bare(R2_ROOT));
      expect(await readMaterializedVersion(f.store, META, KA_UAL)).toEqual(newer);
      expect(f.clearShareComplete).not.toHaveBeenCalled();
      expect(f.clearRemainingShares).not.toHaveBeenCalled();
      // ...while the adopted transaction stays R1's confirmed, recorded receipt.
      expect(outcome.result).toMatchObject({ status: 'confirmed', materializationSuperseded: true,
        onChainResult: { txHash: f.minted.onChainResult?.txHash } });
      expect(await readReceiptTx(f.store)).toEqual([f.minted.onChainResult?.txHash]);
    } finally {
      f.releaseAdoption.resolve();
      await f.store.close();
    }
  });
});
