/**
 * detached-catalog rootless baseline — curated e2e.
 *
 * The first end-to-end curated/private-CG VM publish on the devnet, via the
 * PRODUCT path (write -> promote -> publishFromFinalizedAssertion). Uses the
 * pre-staked genesis core nodes for the ACK quorum (lowered to 1), so the
 * curated `nodeExists` signer check passes.
 *
 * Baseline invariant: a private CG publishing N submitted triples yields one
 * exact graph-scoped KA with N VM triples and an empty legacy root manifest.
 * The public DCAT floor is committed independently and served from `_catalog`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { DKGAgent } from '../src/index.js';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  spawnHardhatEnv, killHardhat, setMinimumRequiredSignatures, HARDHAT_KEYS, type HardhatContext,
} from '../../chain/test/hardhat-harness.js';

let ctx: HardhatContext;
const agents: DKGAgent[] = [];

function chainConfig(opKey: string, adminKey: string) {
  return { rpcUrl: ctx.rpcUrl, adminPrivateKey: adminKey, operationalKeys: [opKey], hubAddress: ctx.hubAddress, chainId: 'evm:31337' };
}

// A disk-backed dataDir is REQUIRED for SWM host mode — without it a core cannot
// store the curated ciphertext chunks and declines the ACK (MISSING_CIPHERTEXT_CHUNKS).
const mkDataDir = (name: string) => mkdtempSync(join(tmpdir(), `rfc49-${name}-`));

describe('baseline — curated CG rootless publish with detached catalog', () => {
  let publisher: DKGAgent;
  let curator: string;

  beforeAll(async () => {
    ctx = await spawnHardhatEnv(8553);
    await setMinimumRequiredSignatures(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, 1);

    // Genesis core nodes are pre-staked. Publisher = CORE_OP (curator/member);
    // the connected REC1 core holds the curated ciphertext and supplies the ACK.
    publisher = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(), name: 'CatPublisher', nodeRole: 'core', listenPort: 0, skills: [],
      dataDir: mkDataDir('pub'),
      chainConfig: chainConfig(HARDHAT_KEYS.CORE_OP, HARDHAT_KEYS.CORE_ADMIN),
    });
    const ackCore = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(), name: 'CatAckCore', nodeRole: 'core', listenPort: 0, skills: [],
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

  it('a private CG publishes exact KAs while retaining a public catalog commitment', async () => {
    const CG = 'rfc49-baseline-private';
    await publisher.createContextGraph({ id: CG, name: 'RFC49 Baseline Private', accessPolicy: 1, callerAgentAddress: curator });
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

    expect(pub.status).toBe('confirmed');
    expect(pub.kaManifest).toEqual([]);
    expect(pub.publicQuads).toHaveLength(1);
    expect(pub.publicQuads[0]).toMatchObject({ subject: 'urn:acme:shipment/SH-42' });
    const vmGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.VerifiableMemory,
      createGraphKnowledgeAssetScope(pub.ual, pub.assertionVersion ?? '1'),
    );
    expect(await (publisher as any).store.countQuads(vmGraph)).toBe(1);

    // The catalog entry persists PLAINTEXT in the public _catalog graph — a
    // queryable, standards-compliant DCAT dataset record (NOT encrypted, unlike
    // the private data which only exists as ciphertext chunks).
    const cgUal = `did:dkg:context-graph:${CG}`;
    const catalogGraph = `${cgUal}/_catalog`;
    const res: any = await (publisher as any).store.query(
      `SELECT ?p ?o WHERE { GRAPH <${catalogGraph}> { <${cgUal}> ?p ?o } }`,
    );
    expect(res.type).toBe('bindings');
    const triples = res.bindings.map((b: any) => ({ p: b.p, o: b.o }));
    const types = triples.filter((t: any) => t.p === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type').map((t: any) => t.o);
    expect(types).toContain('http://www.w3.org/ns/dcat#Dataset');             // standards-compliant DCAT
    expect(types).toContain('https://dkg.network/ontology#PrivateContextGraph'); // dual-typed
    const accessRights = triples.find((t: any) => t.p === 'http://purl.org/dc/terms/accessRights');
    expect(accessRights?.o).toBe('http://publications.europa.eu/resource/authority/access-right/RESTRICTED');

    const secondName = 'shipment-2';
    await publisher.assertion.create(CG, secondName);
    await publisher.assertion.write(CG, secondName, [
      { subject: 'urn:acme:shipment/SH-43', predicate: 'urn:acme:product', object: '"P-10"' },
    ]);
    const secondFinalized: any = await publisher.assertion.finalize(CG, secondName);
    expect(secondFinalized.publicTripleCount).toBe(1);
    const secondPromoted = await publisher.assertion.promote(CG, secondName);
    expect(secondPromoted.promotedCount).toBe(1);

    const secondPub: any = await publisher.publishFromFinalizedAssertion(CG, secondName);
    expect(secondPub.status).toBe('confirmed');
    expect(secondPub.kaManifest).toEqual([]);
    expect(secondPub.publicQuads).toHaveLength(1);
    expect(secondPub.publicQuads[0]).toMatchObject({ subject: 'urn:acme:shipment/SH-43' });
    const secondVmGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.VerifiableMemory,
      createGraphKnowledgeAssetScope(secondPub.ual, secondPub.assertionVersion ?? '1'),
    );
    expect(await (publisher as any).store.countQuads(secondVmGraph)).toBe(1);

    const postSecondCatalog: any = await (publisher as any).store.query(
      `SELECT ?p ?o WHERE { GRAPH <${catalogGraph}> { <${cgUal}> ?p ?o } }`,
    );
    expect(postSecondCatalog.type).toBe('bindings');
    const postSecondTriples = postSecondCatalog.bindings.map((b: any) => ({ p: b.p, o: b.o }));
    expect(postSecondTriples.filter((t: any) => t.p === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type').map((t: any) => t.o))
      .toEqual(expect.arrayContaining([
        'http://www.w3.org/ns/dcat#Dataset',
        'https://dkg.network/ontology#PrivateContextGraph',
      ]));
    expect(postSecondTriples.find((t: any) => t.p === 'http://purl.org/dc/terms/accessRights')?.o)
      .toBe('http://publications.europa.eu/resource/authority/access-right/RESTRICTED');
  });
});
