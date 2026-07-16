/**
 * RS-heal content-binding gate — over the SPARQL-HTTP adapter (the DEVNET backend).
 *
 * The embedded-OxigraphStore gate (`rs-heal-stranded-kc.test.ts`) proves the
 * heal's copy fidelity on the in-process wasm store. But devnet daemons run
 * `backend: "oxigraph-server"`, which routes through the `sparql-http` adapter
 * — a DIFFERENT serialization path (HTTP + W3C SPARQL JSON / N-Quads on the
 * wire). The heal's `store.update(INSERT…WHERE)` mandate exists precisely so
 * the relocated terms never round-trip through THAT adapter's JS
 * serialization; this test exercises that path end-to-end against a real
 * oxigraph engine fronted by an HTTP SPARQL endpoint (the SAME helper
 * `sparql-http.test.ts` uses), seeding + healing + extracting ALL over
 * `SparqlHttpStore`.
 *
 * LOAD-BEARING ASSERTION (same shape as the wasm gate): a CONTROL CG seeded by
 * a single direct `store.insert` of the SAME raw triples DIRECTLY into its
 * SCOPED graphs yields `expectedRoot`. After the heal relocates the legacy
 * strand, the recomputed root over the now-populated scoped graphs must EQUAL
 * `expectedRoot` — plus a STRLEN==13 genuineness check (the escape-bearing
 * literal really is a single-byte newline + single backslash on the server).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SparqlHttpStore, type Quad } from '@origintrail-official/dkg-storage';
import { V10MerkleTree, contextGraphDataUri, contextGraphMetaUri, contextGraphLayerUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { extractV10KCFromStore } from '@origintrail-official/dkg-random-sampling';
import { writeMaterializedVersion } from '@origintrail-official/dkg-publisher';
import { SwmHostModeMethods } from '../src/dkg-agent-swm-host.js';
import { startOxigraphSparqlEndpoint, type OxigraphSparqlEndpoint } from '../../storage/test/helpers/oxigraph-sparql-endpoint.js';

const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const ONTOLOGY_GRAPH = 'did:dkg:context-graph:ontology';
const CONTEXT_GRAPH_ON_CHAIN_ID = 'https://dkg.network/ontology#ContextGraphOnChainId';

// Escape-bearing value: a raw backslash AND a raw newline. .length === 13.
const ESCAPE_BEARING_VALUE = 'line1\nline2\\x';
const ROOT = 'urn:entity:strand-root';
const GENID = `${ROOT}/.well-known/genid/blank-1`;
const KA_ID = 42n;

function publicTriples(): { subject: string; predicate: string; object: string }[] {
  return [
    { subject: ROOT, predicate: 'urn:p:name', object: '"strand"' },
    { subject: ROOT, predicate: 'urn:p:payload', object: `"${ESCAPE_BEARING_VALUE.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}"` },
    { subject: ROOT, predicate: 'urn:p:has', object: GENID },
    { subject: GENID, predicate: 'urn:p:value', object: '"42"' },
  ];
}

function metaQuads(ual: string, metaGraph: string): Quad[] {
  return [
    { subject: ual, predicate: `${RDF}type`, object: `${DKG}KnowledgeCollection`, graph: metaGraph },
    { subject: ual, predicate: `${DKG}batchId`, object: `"${KA_ID}"^^<${XSD}integer>`, graph: metaGraph },
    { subject: `${ual}/1`, predicate: `${RDF}type`, object: `${DKG}KnowledgeAsset`, graph: metaGraph },
    { subject: `${ual}/1`, predicate: `${DKG}partOf`, object: ual, graph: metaGraph },
    { subject: `${ual}/1`, predicate: `${DKG}rootEntity`, object: ROOT, graph: metaGraph },
  ];
}

describe('healStrandedScopedKCs — content-binding gate over SPARQL-HTTP', () => {
  let endpoint: OxigraphSparqlEndpoint;
  let store: SparqlHttpStore;

  const TEST_CG = 'stranded-cg';
  const TEST_ONCHAIN = '7';
  const TEST_UAL = 'did:dkg:hardhat:31337/0xpub/42';
  const CTRL_CG = 'control-cg';
  const CTRL_ONCHAIN = '8';
  const CTRL_UAL = 'did:dkg:hardhat:31337/0xctrl/42';

  beforeAll(async () => {
    endpoint = await startOxigraphSparqlEndpoint();
    store = new SparqlHttpStore({
      queryEndpoint: endpoint.queryEndpoint,
      updateEndpoint: endpoint.updateEndpoint,
    });
  });

  afterAll(async () => {
    await endpoint.close();
  });

  // The extractor maps cgId → local CG name via the ontology graph
  // (resolveContextGraphNameFromOnChainId); without this binding it reports
  // KCNotFound. The heal itself takes the name+onChainId directly, but the
  // assertions go through extractV10KCFromStore which needs it.
  async function seedOntology(localCgId: string, onChainId: string): Promise<void> {
    await store.insert([{
      subject: `did:dkg:context-graph:${localCgId}`,
      predicate: CONTEXT_GRAPH_ON_CHAIN_ID,
      object: `"${onChainId}"`,
      graph: ONTOLOGY_GRAPH,
    }]);
  }

  beforeEach(async () => {
    await store.update('DROP ALL');

    // CONTROL: same raw triples DIRECTLY into the SCOPED graphs.
    await seedOntology(CTRL_CG, CTRL_ONCHAIN);
    await store.insert([
      ...metaQuads(CTRL_UAL, contextGraphMetaUri(CTRL_CG, CTRL_ONCHAIN)),
      ...publicTriples().map((t) => ({ ...t, graph: contextGraphDataUri(CTRL_CG, CTRL_ONCHAIN) })),
    ]);

    // TEST: stranded in the LEGACY label graphs; SCOPED graphs EMPTY.
    await seedOntology(TEST_CG, TEST_ONCHAIN);
    const legacyMeta = contextGraphMetaUri(TEST_CG);
    await store.insert([
      ...metaQuads(TEST_UAL, legacyMeta),
      ...publicTriples().map((t) => ({ ...t, graph: contextGraphDataUri(TEST_CG) })),
    ]);
    await writeMaterializedVersion(store, legacyMeta, TEST_UAL, { blockNumber: 100, txIndex: 0 });
  });

  async function runHeal(localCgId: string, onChainId: string): Promise<void> {
    await SwmHostModeMethods.prototype.healStrandedScopedKCs.call(
      { store, log: { info: () => undefined, warn: () => undefined, error: () => undefined } } as never,
      localCgId,
      { subscribed: true, synced: true, onChainId } as never,
    );
  }

  it('relocates a stranded legacy KC into scoped graphs byte-exactly over HTTP (ROOT EQUALITY)', async () => {
    const ctrl = await extractV10KCFromStore(store, BigInt(CTRL_ONCHAIN), KA_ID);
    const expectedRoot = new V10MerkleTree(ctrl.leaves).root;

    // Before the heal the prover cannot find the stranded KC (scoped is empty).
    await expect(extractV10KCFromStore(store, BigInt(TEST_ONCHAIN), KA_ID)).rejects.toBeTruthy();

    await runHeal(TEST_CG, TEST_ONCHAIN);

    const healed = await extractV10KCFromStore(store, BigInt(TEST_ONCHAIN), KA_ID);
    expect(new V10MerkleTree(healed.leaves).root).toEqual(expectedRoot);

    // Genuineness: the server stored a single-byte newline + single backslash.
    const scopedData = contextGraphDataUri(TEST_CG, TEST_ONCHAIN);
    const lenRes = await store.query(
      `SELECT (STRLEN(?o) AS ?len) WHERE { GRAPH <${scopedData}> { <${ROOT}> <urn:p:payload> ?o } }`,
    );
    const lenStr = lenRes.type === 'bindings' ? (lenRes.bindings[0]?.['len'] ?? '') : '';
    expect(/^"?(\d+)/.exec(lenStr)?.[1]).toBe(String(ESCAPE_BEARING_VALUE.length)); // 13

    // COPIES, never moves: the legacy label graph still resolves the KC.
    const legacyStill = await store.query(
      `ASK { GRAPH <${contextGraphMetaUri(TEST_CG)}> { <${TEST_UAL}> <${DKG}batchId> "${KA_ID}"^^<${XSD}integer> } }`,
    );
    expect(legacyStill.type === 'boolean' && legacyStill.value).toBe(true);
  });

  it('is a version-equal no-op on a second run over HTTP (root stays stable)', async () => {
    await runHeal(TEST_CG, TEST_ONCHAIN);
    const first = await extractV10KCFromStore(store, BigInt(TEST_ONCHAIN), KA_ID);
    const firstRoot = new V10MerkleTree(first.leaves).root;

    await runHeal(TEST_CG, TEST_ONCHAIN);
    const second = await extractV10KCFromStore(store, BigInt(TEST_ONCHAIN), KA_ID);
    expect(new V10MerkleTree(second.leaves).root).toEqual(firstRoot);

    const ctrl = await extractV10KCFromStore(store, BigInt(CTRL_ONCHAIN), KA_ID);
    expect(firstRoot).toEqual(new V10MerkleTree(ctrl.leaves).root);
  });

  it('relocates a VM-graph-only one-shot strand over HTTP (read-both server-side UPDATE)', async () => {
    // The publisher's OWN one-shot publish() lands confirmed PUBLIC data in the
    // per-KA verifiable-memory graph, NOT the legacy root data graph. The heal's
    // data reads are now `rootData UNION <per-KA VM graph>` — this exercises that
    // UNION-in-UPDATE over the real SPARQL-HTTP backend (the devnet path).
    const VM_CG = 'vmstrand-cg';
    const VM_ONCHAIN = '17';
    const VM_UAL = 'did:dkg:hardhat:31337/0xvm/42';
    await seedOntology(VM_CG, VM_ONCHAIN);
    await store.insert(metaQuads(VM_UAL, contextGraphMetaUri(VM_CG)));
    const vmNumber = KA_ID & ((1n << 96n) - 1n);
    const vmAuthor = '0x' + (KA_ID >> 96n).toString(16).padStart(40, '0');
    const vmGraph = contextGraphLayerUri(VM_CG, MemoryLayer.VerifiableMemory, vmAuthor, vmNumber);
    await store.insert(publicTriples().map((t) => ({ ...t, graph: vmGraph })));

    await expect(extractV10KCFromStore(store, BigInt(VM_ONCHAIN), KA_ID)).rejects.toBeTruthy();
    const rootEmpty = await store.query(`ASK { GRAPH <${contextGraphDataUri(VM_CG)}> { ?s ?p ?o } }`);
    expect(rootEmpty.type === 'boolean' && rootEmpty.value).toBe(false);

    await runHeal(VM_CG, VM_ONCHAIN);

    const ctrl = await extractV10KCFromStore(store, BigInt(CTRL_ONCHAIN), KA_ID);
    const healed = await extractV10KCFromStore(store, BigInt(VM_ONCHAIN), KA_ID);
    expect(new V10MerkleTree(healed.leaves).root).toEqual(new V10MerkleTree(ctrl.leaves).root);
  });
});
