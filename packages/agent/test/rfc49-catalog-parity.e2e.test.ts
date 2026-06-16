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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { DKGAgent } from '../src/index.js';
import {
  extractCatalogLeavesFromStore,
} from '@origintrail-official/dkg-random-sampling';
import { computeCatalogRoot, contextGraphCatalogUri } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
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
      chainConfig: chainConfig(HARDHAT_KEYS.CORE_OP, HARDHAT_KEYS.CORE_ADMIN),
    });
    ackCore = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(), name: 'ParityAckCore', nodeRole: 'core', listenPort: 0, skills: [],
      dataDir: mkDataDir('ack'),
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
    await publisher.assertion.finalize(CG, name);
    await publisher.assertion.promote(CG, name);

    const pub: any = await publisher.publishFromFinalizedAssertion(CG, name);

    // A confirmed publish, with the ACK supplied by the REMOTE ackCore, is free
    // proof that producer/collector/handler agree on the catalog ACK digest.
    expect(pub.status).toBe('confirmed');
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
});
