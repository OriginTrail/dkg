/**
 * OT-RFC-49 / WS-D — PRODUCER ↔ EXTRACTOR ↔ CHAIN parity (the HARD GATE).
 *
 * The curated random-sampling commitment is now the PUBLIC `_catalog` Merkle
 * root, committed on-chain via `DKGKnowledgeAssets.getCatalogRoot(kaId)`. This
 * test proves the three sides agree byte-for-byte, end-to-end, on a real chain:
 *
 *   1. PRODUCER — a curated product-path publish sets a NON-ZERO on-chain
 *      `getCatalogRoot(kaId)` / `getCatalogLeafCount(kaId)`.
 *   2. EXTRACTOR — the prover's `extractCatalogLeavesFromStore` reads the
 *      hosting core's `<cg>/_catalog` graph (numeric-keyed — written by the
 *      inverted storage-ACK handler from the inline catalog the producer
 *      shipped), and `computeCatalogRoot` rebuilds the tree.
 *   3. CHAIN — the rebuilt root == the on-chain `getCatalogRoot` AND the rebuilt
 *      leafCount == the on-chain `getCatalogLeafCount`.
 *
 * Why this matters: the producer computes the commitment over a SET of catalog
 * triples; the prover rebuilds over a SET read from the `_catalog` graph. If the
 * two SETS ever diverge by a single triple, curated proving fails SILENTLY every
 * period. The shared `catalogCommittedLeaves` filter pins them together; the
 * committedRoot-bite assertion below proves that filter is load-bearing (and not
 * a green-but-blind no-op): stamping a post-publish `dkg:committedRoot` into the
 * `_catalog` graph must NOT change the rebuilt root.
 *
 * A REMOTE core (not the publisher) supplies the ACK, so a confirmed publish is
 * also free proof of the producer/collector/handler three-way ACK-digest
 * agreement over the catalog fields.
 */
import { TEST_SNAPSHOT_STORAGE } from '../../../scripts/testing/snapshot-storage.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { DKGAgent } from '../src/index.js';
import {
  extractCatalogLeavesFromStore,
} from '@origintrail-official/dkg-random-sampling';
import {
  computeCatalogRoot,
  contextGraphCatalogUri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  buildUpdateAuthorAttestationTypedData,
  AUTHOR_SCHEME_VERSION_V1,
  type PrecomputedUpdateAttestation,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  skolemizeKnowledgeAsset,
  TripleStoreAsyncLiftPublisher,
} from '../../publisher/src/index.js';
import type { Quad } from '@origintrail-official/dkg-storage';
import { ethers, Wallet } from 'ethers';
import {
  spawnHardhatEnv, killHardhat, setMinimumRequiredSignatures, HARDHAT_KEYS, type HardhatContext,
} from '../../chain/test/hardhat-harness.js';

let ctx: HardhatContext;
const agents: DKGAgent[] = [];

function chainConfig(opKey: string, adminKey: string) {
  return { rpcUrl: ctx.rpcUrl, adminPrivateKey: adminKey, operationalKeys: [opKey], hubAddress: ctx.hubAddress, chainId: 'evm:31337' };
}

const mkDataDir = (name: string) => mkdtempSync(join(tmpdir(), `rfc49-parity-${name}-`));

/** Pull the numeric on-chain cgId off the host core's `<cg>/_catalog` graph URI. */
function numericCgIdFromCatalogGraph(graphUri: string): bigint | null {
  const prefix = 'did:dkg:context-graph:';
  const suffix = '/_catalog';
  if (!graphUri.startsWith(prefix) || !graphUri.endsWith(suffix)) return null;
  const id = graphUri.slice(prefix.length, -suffix.length);
  try {
    const n = BigInt(id);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

/**
 * Build a `precomputedUpdateAttestation` for a curated UPDATE.
 *
 * A V10 update requires a caller-supplied attestation over the NEW atomic KA
 * Merkle root. The curated catalog floor is committed independently and is not
 * part of this author seal or the exact per-KA graph.
 */
async function buildCuratedUpdateSeal(opts: {
  kaId: bigint;
  newQuads: Quad[];
  author: Wallet;
  provider: ethers.JsonRpcProvider;
  kav10Address: string;
}): Promise<PrecomputedUpdateAttestation> {
  const allPublic = await skolemizeKnowledgeAsset(opts.newQuads);
  const newMerkleRoot = computeFlatKCRootV10(allPublic, []);

  const chainId = await opts.provider.getNetwork().then((n) => n.chainId);
  const td = buildUpdateAuthorAttestationTypedData({
    chainId: BigInt(chainId),
    kav10Address: opts.kav10Address,
    kaId: opts.kaId,
    newMerkleRoot,
    authorAddress: opts.author.address,
  });
  const sigHex = await opts.author.signTypedData(td.domain, td.types, td.message);
  const sig = ethers.Signature.from(sigHex);
  return {
    expectedNewMerkleRoot: newMerkleRoot,
    authorAddress: opts.author.address,
    signature: { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) },
    schemeVersion: AUTHOR_SCHEME_VERSION_V1,
  };
}

describe('OT-RFC-49 WS-D — catalog producer↔extractor↔chain parity', () => {
  let publisher: DKGAgent;
  let ackCore: DKGAgent;
  let curator: string;

  beforeAll(async () => {
    ctx = await spawnHardhatEnv(8554);
    await setMinimumRequiredSignatures(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, 1);

    publisher = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(), name: 'ParityPublisher', nodeRole: 'core', listenPort: 0, skills: [],
      dataDir: mkDataDir('pub'),
      sharedMemoryPublicSnapshotStorage: TEST_SNAPSHOT_STORAGE,
      chainConfig: chainConfig(HARDHAT_KEYS.CORE_OP, HARDHAT_KEYS.CORE_ADMIN),
    });
    ackCore = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(), name: 'ParityAckCore', nodeRole: 'core', listenPort: 0, skills: [],
      dataDir: mkDataDir('ack'),
      sharedMemoryPublicSnapshotStorage: TEST_SNAPSHOT_STORAGE,
      chainConfig: chainConfig(HARDHAT_KEYS.REC1_OP, HARDHAT_KEYS.REC1_ADMIN),
    });
    agents.push(publisher, ackCore);
    await publisher.start(); await ackCore.start();
    await ackCore.connectTo(publisher.multiaddrs[0]);
    await new Promise((r) => setTimeout(r, 2000));
    curator = publisher.defaultAgentAddress ?? publisher.peerId;
  }, 180_000);

  afterAll(async () => {
    for (const a of agents) { try { await a.stop(); } catch {} }
    killHardhat(ctx);
  });

  it('curated publish: rebuilt catalog root == on-chain getCatalogRoot (and committedRoot is excluded)', async () => {
    const CG = 'rfc49-parity-private';
    await publisher.createContextGraph({ id: CG, name: 'RFC49 Parity Private', accessPolicy: 1, callerAgentAddress: curator });
    await publisher.registerContextGraph(CG, { callerAgentAddress: curator });

    const name = 'shipment';
    await publisher.assertion.create(CG, name);
    await publisher.assertion.write(CG, name, [
      { subject: 'urn:acme:shipment/SH-42', predicate: 'urn:acme:product', object: '"P-9"' },
    ]);
    const finalized: any = await publisher.assertion.finalize(CG, name);
    expect(finalized.publicTripleCount).toBe(1);
    const promoted = await publisher.assertion.promote(CG, name);
    expect(promoted.promotedCount).toBe(1);

    const pub: any = await publisher.publishFromFinalizedAssertion(CG, name);

    // A confirmed publish, with the ACK supplied by the REMOTE ackCore, is free
    // proof that producer/collector/handler agree on the catalog ACK digest.
    expect(pub.status).toBe('confirmed');
    expect(pub.kaManifest).toEqual([]);
    expect(pub.publicQuads).toHaveLength(1);
    expect(pub.publicQuads[0]).toMatchObject({
      subject: 'urn:acme:shipment/SH-42',
      predicate: 'urn:acme:product',
      object: '"P-9"',
    });
    const vmGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.VerifiableMemory,
      createGraphKnowledgeAssetScope(pub.ual, pub.assertionVersion ?? '1'),
    );
    expect(await (publisher as any).store.countQuads(vmGraph)).toBe(1);
    const leakedCatalog = await (publisher as any).store.query(
      `ASK { GRAPH <${vmGraph}> { <did:dkg:context-graph:${CG}> ?p ?o } }`,
    );
    expect(leakedCatalog).toMatchObject({ type: 'boolean', value: false });
    const kaId: bigint = pub.kaId;
    expect(typeof kaId).toBe('bigint');

    // ── PRODUCER → CHAIN: a non-zero on-chain catalog commitment was set. ──
    const chain: any = (publisher as any).chain;
    expect(typeof chain.getCatalogRoot).toBe('function');
    expect(typeof chain.getCatalogLeafCount).toBe('function');
    const onChainRoot: Uint8Array = await chain.getCatalogRoot(kaId);
    const onChainLeafCount: number = await chain.getCatalogLeafCount(kaId);
    const onChainRootHex = ethers.hexlify(onChainRoot);
    expect(onChainRootHex).not.toBe(ethers.ZeroHash);          // commitment was actually set
    expect(onChainLeafCount).toBeGreaterThan(0);

    // ── EXTRACTOR: read the HOST core's numeric-keyed `<cg>/_catalog`. ──
    // The hosting core persisted the catalog from the inline ACK payload under
    // contextGraphCatalogUri(numericCgId) — exactly the prover's path. Discover
    // the numeric cgId empirically off the graph the handler actually wrote; if
    // it is absent the keying is broken (the production "extractor finds nothing
    // → skip every period" silent failure WS-D exists to catch).
    const ackStore: any = (ackCore as any).store;
    const ackGraphs: string[] = await ackStore.listGraphs();
    const catalogGraphs = ackGraphs.filter((g) => g.endsWith('/_catalog'));
    const numericCgIds = catalogGraphs
      .map(numericCgIdFromCatalogGraph)
      .filter((n): n is bigint => n !== null);
    expect(
      numericCgIds.length,
      `host core has no numeric-keyed _catalog graph (found: ${JSON.stringify(catalogGraphs)}) — ` +
      `the curated catalog never reached the prover's store; curated proving would be inert`,
    ).toBeGreaterThan(0);
    const cgId = numericCgIds[0];

    const catalogTriples = await extractCatalogLeavesFromStore({ store: ackStore, contextGraphId: cgId });
    const rebuilt = computeCatalogRoot(catalogTriples);
    const rebuiltRootHex = ethers.hexlify(rebuilt.root);

    // ── THE GATE: rebuilt == on-chain (root AND leafCount). ──
    expect(rebuiltRootHex, `rebuilt catalog root must equal on-chain getCatalogRoot`).toBe(onChainRootHex);
    expect(rebuilt.leafCount, `rebuilt leafCount must equal on-chain getCatalogLeafCount`).toBe(onChainLeafCount);

    // ── THE BITE: prove the committedRoot filter is load-bearing. ──
    // Stamp a POST-PUBLISH `dkg:committedRoot` into the SAME numeric `_catalog`
    // graph, then re-run the extractor + rebuild. The shared
    // `catalogCommittedLeaves` filter must strip it, so the rebuilt root is
    // UNCHANGED. If it changes, the producer↔prover sets would silently diverge
    // the instant the public projection stamps committedRoot post-publish.
    const cgDid = `did:dkg:context-graph:${cgId}`;
    const catalogGraph = contextGraphCatalogUri(String(cgId));
    await ackStore.insert([{
      subject: cgDid,
      predicate: 'https://dkg.network/ontology#committedRoot',
      object: `"${onChainRootHex}"`,
      graph: catalogGraph,
    }]);

    const afterStamp = await extractCatalogLeavesFromStore({ store: ackStore, contextGraphId: cgId });
    const rebuiltAfter = computeCatalogRoot(afterStamp);
    expect(
      ethers.hexlify(rebuiltAfter.root),
      'committedRoot stamp must be EXCLUDED from the committed/proven set — ' +
      'the rebuilt root must not change when a post-publish stamp lands',
    ).toBe(onChainRootHex);
    expect(rebuiltAfter.leafCount).toBe(onChainLeafCount);
  }, 180_000);

  it('curated named-KA publish-async reaches the same remote catalog ACK path as sync (#1670)', async () => {
    const CG = 'rfc49-parity-private-async';
    await publisher.createContextGraph({
      id: CG,
      name: 'RFC49 Parity Private Async',
      accessPolicy: 1,
      callerAgentAddress: curator,
    });
    await publisher.registerContextGraph(CG, { callerAgentAddress: curator });

    const name = 'shipment-async';
    const root = 'urn:acme:shipment/SH-ASYNC';
    await publisher.assertion.create(CG, name);
    await publisher.assertion.write(CG, name, [
      { subject: root, predicate: 'urn:acme:product', object: '"P-ASYNC"' },
    ]);
    await publisher.assertion.finalize(CG, name);
    const promoted = await publisher.assertion.promote(CG, name);
    expect(promoted.publishReady).toBe(true);

    const intent = await publisher.resolveFinalizedAssertionVmPublishIntent(CG, name);
    let queuedResult: any;
    const queue = new TripleStoreAsyncLiftPublisher((publisher as any).store, {
      publicSnapshotStore: (publisher as any).publicSnapshotStore,
      knowledgeAssetVmPublishPreflight: ({ request }) =>
        publisher.preflightQueuedKnowledgeAssetVmPublishExecution(request),
      knowledgeAssetVmPublishExecutor: async ({ request, publishOptions }) => {
        queuedResult = await publisher.publishQueuedKnowledgeAssetVmPublish(request, publishOptions);
        return queuedResult;
      },
    });
    const jobId = await queue.enqueueKnowledgeAssetVmPublish(intent);
    const processed = await queue.processNext('rfc49-async-wallet');

    expect(processed?.jobId).toBe(jobId);
    if (processed?.status !== 'finalized') {
      throw new Error(`Expected curated async publish to finalize: ${JSON.stringify((processed as any)?.failure)}`);
    }
    expect(queuedResult?.status).toBe('confirmed');
    expect(queuedResult?.onChainResult).toBeDefined();

    const kaId = BigInt(queuedResult.kaId);
    const chain: any = (publisher as any).chain;
    const onChainRoot = ethers.hexlify(await chain.getCatalogRoot(kaId));
    const onChainLeafCount = await chain.getCatalogLeafCount(kaId);
    expect(onChainRoot).not.toBe(ethers.ZeroHash);
    expect(onChainLeafCount).toBeGreaterThan(0);

    // ackCore is not a member of this private CG. Its catalog copy therefore
    // proves that the queued path shipped the public floor inline instead of
    // asking the core for private SWM and receiving NO_DATA_IN_SWM.
    const cgId: bigint = await chain.getKAContextGraphId(kaId);
    const rebuilt = computeCatalogRoot(await extractCatalogLeavesFromStore({
      store: (ackCore as any).store,
      contextGraphId: cgId,
    }));
    expect(ethers.hexlify(rebuilt.root)).toBe(onChainRoot);
    expect(rebuilt.leafCount).toBe(onChainLeafCount);
  }, 180_000);

  it('curated UPDATE re-commits the catalog (root non-zero, == publish baseline) and a remote core re-hosts it', async () => {
    const CG = 'rfc49-parity-update';
    await publisher.createContextGraph({ id: CG, name: 'RFC49 Parity Update', accessPolicy: 1, callerAgentAddress: curator });
    await publisher.registerContextGraph(CG, { callerAgentAddress: curator });

    const name = 'shipment-upd';
    // ── initial curated publish (the baseline) ──
    await publisher.assertion.create(CG, name);
    await publisher.assertion.write(CG, name, [
      { subject: 'urn:acme:shipment/SH-99', predicate: 'urn:acme:product', object: '"P-1"' },
    ]);
    await publisher.assertion.finalize(CG, name);
    await publisher.assertion.promote(CG, name);
    const pub: any = await publisher.publishFromFinalizedAssertion(CG, name);
    expect(pub.status).toBe('confirmed');
    const kaId: bigint = pub.kaId;

    const chain: any = (publisher as any).chain;
    const baselineRoot = ethers.hexlify(await chain.getCatalogRoot(kaId));
    const baselineLeafCount: number = await chain.getCatalogLeafCount(kaId);
    expect(baselineRoot).not.toBe(ethers.ZeroHash);
    expect(baselineLeafCount).toBeGreaterThan(0);

    // ── the curated UPDATE ──
    // Re-finalizing a PUBLISHED assertion is structurally impossible: the seal
    // is keyed by the assertion URI, and neither `discard` (clears the
    // number-based WM-layer URI) nor `create` (clears the lifecycle URN) touches
    // it, so re-finalize hits `already finalized with a different merkleRoot`.
    // So we drive the on-chain UPDATE primitive directly — the SAME primitive
    // `publishFromFinalizedAssertion`'s update branch delegates to — by calling
    // `publisher.update(kaId, ...)` with new content + a `precomputedUpdateAttestation`.
    // This exercises the identical curated WS-D feature code (the `isCuratedUpdate`
    // floor re-projection in dkg-agent-publish.ts update()): the producer re-injects
    // the public `_catalog` floor, ships it inline, commits a NON-ZERO catalog root,
    // and the update CONFIRMS. BEFORE this feature a curated update shipped a zero
    // catalog root and REVERTED with `CuratedCGRequiresCatalogCommitment`.
    //
    // The attestation is signed by the KA's ORIGINAL author (the operational key
    // that published the baseline) over the POST-floor-injection merkle — see
    // `buildCuratedUpdateSeal`.
    const author = new Wallet(HARDHAT_KEYS.CORE_OP, ctx.provider);
    expect(
      author.address.toLowerCase(),
      'the baseline publish was authored by the publisher operational key (CORE_OP)',
    ).toBe(String(pub.seal.authorAddress).toLowerCase());

    const newQuads: Quad[] = [
      { subject: 'urn:acme:shipment/SH-99', predicate: 'urn:acme:product', object: '"P-1"', graph: '' },
      { subject: 'urn:acme:shipment/SH-99', predicate: 'urn:acme:status', object: '"delivered"', graph: '' },
    ];
    const precomputedUpdateAttestation = await buildCuratedUpdateSeal({
      kaId,
      newQuads,
      author,
      provider: ctx.provider,
      kav10Address: await chain.getKnowledgeAssetsLifecycleAddress(),
    });

    // V2 updates consume one immutable version-scoped SWM graph; callers do
    // not get to substitute an arbitrary inline bag after the author seal is
    // created. Stage the exact assertionVersion=2 payload at that boundary.
    const updateScope = createGraphKnowledgeAssetScope(pub.ual, '2');
    const updateSwmGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.SharedWorkingMemory,
      updateScope,
    );
    await (publisher as any).store.insert(
      newQuads.map((quad) => ({ ...quad, graph: updateSwmGraph })),
    );

    const upd: any = await publisher.update(kaId, CG, newQuads, [], {
      precomputedUpdateAttestation,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: pub.ual,
      assertionVersion: '2',
      publicTripleCount: newQuads.length,
      privateTripleCount: 0,
    });
    expect(upd.status, 'curated update must CONFIRM (no CuratedCGRequiresCatalogCommitment revert)').toBe('confirmed');
    // The update targets — and re-confirms — the SAME on-chain KA as the publish.
    expect(upd.kaId).toBe(kaId);
    expect(upd.publicQuads).toHaveLength(newQuads.length);
    const updateVmGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.VerifiableMemory,
      updateScope,
    );
    expect(await (publisher as any).store.countQuads(updateVmGraph)).toBe(newQuads.length);
    const updateCatalogLeak = await (publisher as any).store.query(
      `ASK { GRAPH <${updateVmGraph}> { <did:dkg:context-graph:${CG}> ?p ?o } }`,
    );
    expect(updateCatalogLeak).toMatchObject({ type: 'boolean', value: false });

    // ── on-chain: catalog still committed, non-zero, EQUALS the publish baseline. ──
    // The catalog is the stable public floor — a curated update RE-COMMITS the
    // same root (that's what satisfies the on-chain gate); it does NOT rotate.
    const afterRoot = ethers.hexlify(await chain.getCatalogRoot(kaId));
    const afterLeafCount: number = await chain.getCatalogLeafCount(kaId);
    expect(afterRoot).not.toBe(ethers.ZeroHash);
    expect(afterRoot, 'curated update re-commits the stable floor (== baseline, not rotated)').toBe(baselineRoot);
    expect(afterLeafCount).toBe(baselineLeafCount);

    // ── the REMOTE core re-hosts the updated catalog; rebuilt == on-chain. ──
    // The update ACK supplied by ackCore drove its updateHandler to rebuild +
    // verify + REPLACE-persist `<cg>/_catalog`, so an updated curated KA is
    // genuinely provable (it was inert before WS-D).
    const cgId: bigint = await chain.getKAContextGraphId(kaId);
    const ackStore: any = (ackCore as any).store;
    const rebuilt = computeCatalogRoot(await extractCatalogLeavesFromStore({ store: ackStore, contextGraphId: cgId }));
    expect(ethers.hexlify(rebuilt.root), 'remote core re-hosts the updated catalog; rebuilt must equal on-chain').toBe(afterRoot);
    expect(rebuilt.leafCount).toBe(afterLeafCount);
  }, 180_000);
});
