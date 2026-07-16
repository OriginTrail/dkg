/**
 * GH #842 — gossip receiver (`UpdateHandler`) must materialise updated KAs into
 * the per-cgId partition the RS prover reads, EVEN when the `dkg:batchId`
 * resolution edge isn't present yet.
 *
 * Before the fix the receiver resolved the KA's UAL only from the meta store;
 * when that lookup missed (a receiver that hadn't yet materialised the batchId
 * edge) it logged "skipped per-cgId promotion (UAL unresolved)" and the KA
 * stayed permanently `kc-not-synced` for Random Sampling. The fix adds a
 * deterministic canonical-UAL fallback so the promotion always runs.
 *
 * This uses a minimal mock ChainAdapter (no Hardhat) — we only exercise the
 * apply + per-cgId promotion path, not on-chain submission.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, PrivateContentStore, GraphManager, type Quad } from '@origintrail-official/dkg-storage';
import {
  TypedEventBus,
  encodeKAUpdateRequest,
  contextGraphDataUri,
  contextGraphLayerUri,
  contextGraphMetaUri,
  generateEd25519Keypair,
  MemoryLayer,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGPublisher, UpdateHandler, autoPartition, computeFlatKCRootV10 as computeFlatKCRoot } from '../src/index.js';

const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const CG_NAME = 'gossip-cg';
const CG_ON_CHAIN_ID = '5';
const KAS_ADDRESS = '0xKnowledgeAssets';
const CHAIN_ID = 'hardhat';
const BATCH_ID = 77n;
const BLOCK = 250;
const TX_INDEX = 1;

function q(s: string, p: string, o: string, g = ''): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function quadsToNQuads(quads: Quad[], graph: string): Uint8Array {
  const str = quads
    .map((qd) => `<${qd.subject}> <${qd.predicate}> ${qd.object.startsWith('"') ? qd.object : `<${qd.object}>`} <${graph}> .`)
    .join('\n');
  return new TextEncoder().encode(str);
}

function makeMockChain(onChainMerkleRoot: Uint8Array): ChainAdapter {
  return {
    chainId: CHAIN_ID,
    async verifyKAUpdate() {
      return { verified: true, onChainMerkleRoot, blockNumber: BLOCK, txIndex: TX_INDEX };
    },
    async getDKGKnowledgeAssetsAddress() {
      return KAS_ADDRESS;
    },
  } as unknown as ChainAdapter;
}

describe('UpdateHandler — GH #842 deterministic-UAL fallback (gossip receiver)', () => {
  let store: OxigraphStore;
  beforeEach(() => {
    store = new OxigraphStore();
  });

  it('promotes an update into the per-cgId partition even when no batchId edge exists yet', async () => {
    const updateTriples = [
      q('urn:upd:r', 'urn:p:type', 'urn:UpdateAction'),
      q('urn:upd:r', 'urn:p:name', '"received"'),
    ];
    const labelGraph = contextGraphDataUri(CG_NAME);
    const computedRoot = computeFlatKCRoot(
      updateTriples.map((t) => ({ ...t, graph: labelGraph })),
      [],
    );

    const chain = makeMockChain(computedRoot);
    const handler = new UpdateHandler(store, chain, new TypedEventBus(), {
      resolveOnChainCgId: async () => CG_ON_CHAIN_ID,
    });

    const msg = encodeKAUpdateRequest({
      contextGraphId: CG_NAME,
      batchId: BATCH_ID,
      nquads: quadsToNQuads(updateTriples, labelGraph),
      manifest: [{ rootEntity: 'urn:upd:r', privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWReceiverTest',
      publisherAddress: '0xPublisher',
      txHash: '0xabc',
      blockNumber: BigInt(BLOCK),
      newMerkleRoot: computedRoot,
      timestampMs: BigInt(Date.now()),
    });

    await handler.handle(msg, '12D3KooWPeer');

    // The deterministic UAL the fallback should have minted.
    const expectedUal = `did:dkg:${CHAIN_ID}/${KAS_ADDRESS.toLowerCase()}/${BATCH_ID}`;
    const perCgIdMeta = contextGraphMetaUri(CG_NAME, CG_ON_CHAIN_ID);
    const perCgIdData = contextGraphDataUri(CG_NAME, CG_ON_CHAIN_ID);

    // 1. The per-cgId meta resolves the KA by batchId under the deterministic UAL.
    const metaRes = await store.query(
      `SELECT ?ual WHERE { GRAPH <${perCgIdMeta}> { ?ual <${DKG}batchId> "${BATCH_ID}"^^<${XSD}integer> } }`,
    );
    expect(metaRes.type).toBe('bindings');
    expect(metaRes.type === 'bindings' && metaRes.bindings.map((b) => b['ual'])).toContain(expectedUal);

    // 2. The per-cgId data graph holds the payload (RS read partition).
    const dataRes = await store.query(
      `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${perCgIdData}> { <urn:upd:r> ?p ?o } }`,
    );
    const count = dataRes.type === 'bindings' ? Number(String(dataRes.bindings[0]['c']).match(/\d+/)?.[0] ?? 0) : 0;
    expect(count).toBe(updateTriples.length);

    // 3. The version guard recorded the update's chain version.
    const verRes = await store.query(
      `SELECT ?v WHERE { GRAPH <${perCgIdMeta}> { <${expectedUal}> <${DKG}materializedVersion> ?v } }`,
    );
    expect(verRes.type === 'bindings' && String(verRes.bindings[0]?.['v'])).toContain(`${BLOCK}:${TX_INDEX}`);
  });

  // PR #845 review bug #6 (@branarakic): a transient ontology/store error
  // in `resolveOnChainCgId` (the on-chain CG lookup) was escaping the
  // gossip apply path and aborting the entire update before the label
  // graph could be restated. The fix wraps that single lookup in try/catch
  // (matching the agent-side guard) so per-cgId promotion is best-effort
  // and the verified label-graph restatement still happens.
  it('still restates the label graph when resolveOnChainCgId throws', async () => {
    const updateTriples = [
      q('urn:upd:r2', 'urn:p:type', 'urn:UpdateAction'),
      q('urn:upd:r2', 'urn:p:name', '"received-2"'),
    ];
    const labelGraph = contextGraphDataUri(CG_NAME);
    const computedRoot = computeFlatKCRoot(
      updateTriples.map((t) => ({ ...t, graph: labelGraph })),
      [],
    );

    const chain = makeMockChain(computedRoot);
    let resolverCalls = 0;
    const handler = new UpdateHandler(store, chain, new TypedEventBus(), {
      resolveOnChainCgId: async () => {
        resolverCalls++;
        throw new Error('simulated transient ontology/store error');
      },
    });

    const msg = encodeKAUpdateRequest({
      contextGraphId: CG_NAME,
      batchId: BATCH_ID,
      nquads: quadsToNQuads(updateTriples, labelGraph),
      manifest: [{ rootEntity: 'urn:upd:r2', privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWReceiverTest',
      publisherAddress: '0xPublisher',
      txHash: '0xabc2',
      blockNumber: BigInt(BLOCK),
      newMerkleRoot: computedRoot,
      timestampMs: BigInt(Date.now()),
    });

    await handler.handle(msg, '12D3KooWPeer');

    expect(resolverCalls).toBe(1);

    // The verified update is restated into the per-KA verifiable-memory graph
    // (rc.17 uniform layout) the original publish wrote — keyed by the
    // on-chain batchId (= the packed kaId), unpacked into author+number. The
    // restatement still happens even though the per-cgId resolver threw.
    const vmAuthor = '0x' + (BATCH_ID >> 96n).toString(16).padStart(40, '0');
    const vmNumber = BATCH_ID & ((1n << 96n) - 1n);
    const verifiableMemoryGraph = contextGraphLayerUri(
      CG_NAME,
      MemoryLayer.VerifiableMemory,
      vmAuthor,
      vmNumber,
    );
    const labelDataCount = await store.query(
      `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${verifiableMemoryGraph}> { <urn:upd:r2> ?p ?o } }`,
    );
    const labelCount = labelDataCount.type === 'bindings'
      ? Number(String(labelDataCount.bindings[0]['c']).match(/\d+/)?.[0] ?? 0)
      : 0;
    expect(labelCount).toBe(updateTriples.length);

    // Per-cgId partition was skipped (resolver failed) — no leak into a
    // partition we couldn't address.
    const perCgIdMeta = contextGraphMetaUri(CG_NAME, CG_ON_CHAIN_ID);
    const perCgIdRes = await store.query(
      `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${perCgIdMeta}> { ?s ?p ?o } }`,
    );
    const perCgIdCount = perCgIdRes.type === 'bindings'
      ? Number(String(perCgIdRes.bindings[0]['c']).match(/\d+/)?.[0] ?? 0)
      : 0;
    expect(perCgIdCount).toBe(0);
  });
});

// GH #842 / PR #845 round 2 — Codex flagged that the publisher's update
// path only purged private triples for the NEW root entities. If an update
// changes the root entity (`urn:orig` → `urn:new`), the prior root's
// private payload was left in `PrivateContentStore` (keyed by
// `(contextGraph, rootEntity)`) and would leak into any future KA that
// reused the prior root in the same context graph. The fix resolves the
// prior roots from `_meta` and purges them too.
describe('DKGPublisher.update — purges private triples for PRIOR roots (GH #842 round 2)', () => {
  const PRIVATE_PRED = 'urn:p:secret';
  const PUBLIC_PRED = 'urn:p:name';
  const CG = 'private-leak-cg';
  const PUBLISHER_ADDR = '0x000000000000000000000000000000000000DEAD';
  const PRIOR_ROOT = 'urn:orig:secret';
  const NEW_ROOT = 'urn:new:secret';
  // Deterministic kaId for the prior+update — `localOnlyUpdate` doesn't
  // hit a chain, so the publisher resolves UAL as
  // `did:dkg:none/<publisher>/<kaId>`.
  const KA_ID = 11n;

  async function makePublisher(store: OxigraphStore): Promise<DKGPublisher> {
    const keypair = await generateEd25519Keypair();
    return new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair,
      publisherAddress: PUBLISHER_ADDR,
    });
  }

  it('deletes the prior root\'s private triples when the update changes root entity', async () => {
    const store = new OxigraphStore();
    const gm = new GraphManager(store);
    await gm.ensureContextGraph(CG);
    const publisher = await makePublisher(store);
    const privateStore = new PrivateContentStore(store, gm);

    // Seed the label `_meta` with the PRIOR KA pointing at `urn:orig:secret`.
    // `storeUpdatedQuads` discovers prior roots via this exact pattern.
    const labelMeta = gm.metaGraphUri(CG);
    const ual = `did:dkg:none/${PUBLISHER_ADDR.toLowerCase()}/${KA_ID}`;
    await store.insert([
      { subject: ual, predicate: `${DKG}batchId`, object: `"${KA_ID}"^^<${XSD}integer>`, graph: labelMeta },
      { subject: `${ual}/1`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${DKG}KnowledgeAsset`, graph: labelMeta },
      { subject: `${ual}/1`, predicate: `${DKG}partOf`, object: ual, graph: labelMeta },
      { subject: `${ual}/1`, predicate: `${DKG}rootEntity`, object: PRIOR_ROOT, graph: labelMeta },
    ]);

    // Seed the public data graph with the prior root's triples (so the label
    // restatement has something to delete).
    const labelData = gm.dataGraphUri(CG);
    await store.insert([
      { subject: PRIOR_ROOT, predicate: PUBLIC_PRED, object: '"orig"', graph: labelData },
    ]);

    // Seed `PrivateContentStore` with the PRIOR root's private payload.
    await privateStore.storePrivateTriples(CG, PRIOR_ROOT, [
      q(PRIOR_ROOT, PRIVATE_PRED, '"orig-secret"'),
    ]);
    expect(
      (await privateStore.getPrivateTriples(CG, PRIOR_ROOT)).length,
    ).toBeGreaterThan(0);

    // Update to a different root entity, with a new private triple.
    const result = await publisher.update(KA_ID, {
      contextGraphId: CG,
      quads: [q(NEW_ROOT, PUBLIC_PRED, '"updated"')],
      privateQuads: [q(NEW_ROOT, PRIVATE_PRED, '"new-secret"')],
    });
    // localOnly update returns `tentative` (no chain attribution).
    expect(['tentative', 'confirmed']).toContain(result.status);

    // The PRIOR root's private payload MUST be fully gone — otherwise a
    // future KA that reuses `urn:orig:secret` in the same CG would silently
    // adopt the stale secret.
    expect(await privateStore.getPrivateTriples(CG, PRIOR_ROOT)).toEqual([]);
    // And the NEW root's payload is in place.
    const newSecrets = await privateStore.getPrivateTriples(CG, NEW_ROOT);
    expect(newSecrets.length).toBeGreaterThan(0);
    expect(newSecrets.some((t) => t.predicate === PRIVATE_PRED)).toBe(true);
  });
});
