/**
 * KCExtractor unit + gold tests.
 *
 * Pin the bit-for-bit recipe between publisher publish-path and the
 * Random Sampling prover's local extraction:
 *  - resolve KC UAL via `dkg:batchId == kaId` in _meta
 *  - resolve root entities via `dkg:partOf` + `dkg:rootEntity`
 *  - pull public quads from the CG data graph filtered by root +
 *    `.well-known/genid/` skolemized blanks (same SPARQL shape as
 *    `dkg-publisher`'s `loadSWMQuads`)
 *  - re-emit V10 leaves that, when fed to V10MerkleTree, produce the
 *    same root the on-chain KC commits to
 *
 * The extractor's job is the seam between chain challenge and proof
 * builder — if the publisher refactors graph URIs or metadata
 * predicates, these tests fail loud and the prover does NOT silently
 * miss every period.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  OxigraphStore,
  type Quad,
} from '@origintrail-official/dkg-storage';
import {
  V10MerkleTree,
  hashTripleV10,
  tripleContentV10,
  keccak256,
  structuredKARootV10,
  buildV10ProofMaterial,
  verifyV10ProofMaterial,
  contextGraphDataUri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import {
  extractV10KCFromStore,
  extractV10KCQuads,
  KCNotFoundError,
  KCRootEntitiesNotFoundError,
  KCDataMissingError,
} from '../src/index.js';
import {
  promoteUpdatedKaToPerCgId,
  restateKaPartition,
  restateLabelGraphForUpdate,
  writeMaterializedVersion,
  readMaterializedVersion,
} from '@origintrail-official/dkg-publisher';

const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

interface KCFixture {
  cgId: bigint;
  kaId: bigint;
  /** Local CG name. Defaults to a synthetic `cg-<cgId>` when omitted. */
  cgName?: string;
  ual: string;
  rootEntities: string[];
  publicTriples: { subject: string; predicate: string; object: string }[];
  privateRoots?: Uint8Array[];
}

function toHexNoPrefix(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const ONTOLOGY_GRAPH = 'did:dkg:context-graph:ontology';
const CONTEXT_GRAPH_ON_CHAIN_ID = 'https://dkg.network/ontology#ContextGraphOnChainId';

async function seedOntology(
  store: OxigraphStore,
  cgName: string,
  cgId: bigint,
): Promise<void> {
  await store.insert([
    {
      subject: `did:dkg:context-graph:${cgName}`,
      predicate: CONTEXT_GRAPH_ON_CHAIN_ID,
      object: `"${cgId.toString()}"`,
      graph: ONTOLOGY_GRAPH,
    },
  ]);
}

async function seedKC(store: OxigraphStore, fixture: KCFixture): Promise<void> {
  const cgIdStr = fixture.cgId.toString();
  const cgName = fixture.cgName ?? `cg-${cgIdStr}`;
  await seedOntology(store, cgName, fixture.cgId);
  const metaGraph = contextGraphMetaUri(cgName, cgIdStr);
  const dataGraph = contextGraphDataUri(cgName, cgIdStr);

  const metaQuads: Quad[] = [
    {
      subject: fixture.ual,
      predicate: `${RDF}type`,
      object: `${DKG}KnowledgeCollection`,
      graph: metaGraph,
    },
    {
      subject: fixture.ual,
      predicate: `${DKG}batchId`,
      object: `"${fixture.kaId}"^^<${XSD}integer>`,
      graph: metaGraph,
    },
  ];

  // KA -> rootEntity per fixture entry.
  for (let i = 0; i < fixture.rootEntities.length; i++) {
    const kaUri = `${fixture.ual}/${i + 1}`;
    metaQuads.push(
      { subject: kaUri, predicate: `${RDF}type`, object: `${DKG}KnowledgeAsset`, graph: metaGraph },
      { subject: kaUri, predicate: `${DKG}partOf`, object: fixture.ual, graph: metaGraph },
      { subject: kaUri, predicate: `${DKG}rootEntity`, object: fixture.rootEntities[i], graph: metaGraph },
    );
    if (fixture.privateRoots && fixture.privateRoots[i]) {
      metaQuads.push({
        subject: kaUri,
        predicate: `${DKG}privateMerkleRoot`,
        object: `"${toHexNoPrefix(fixture.privateRoots[i])}"`,
        graph: metaGraph,
      });
    }
  }
  await store.insert(metaQuads);

  // Public KC quads in the data graph.
  await store.insert(
    fixture.publicTriples.map((t) => ({ ...t, graph: dataGraph })),
  );
}

describe('extractV10KCFromStore — happy path / publisher round-trip parity', () => {
  let store: OxigraphStore;
  beforeEach(() => {
    store = new OxigraphStore();
  });

  it('returns the KC triples and computes leaves whose V10 root matches a manual rebuild', async () => {
    const fixture: KCFixture = {
      cgId: 7n,
      kaId: 42n,
      ual: 'did:dkg:hardhat:31337/0xpub/42',
      rootEntities: ['urn:entity:alpha', 'urn:entity:beta'],
      publicTriples: [
        { subject: 'urn:entity:alpha', predicate: 'urn:p:name', object: '"alpha"' },
        { subject: 'urn:entity:beta', predicate: 'urn:p:name', object: '"beta"' },
        { subject: 'urn:entity:beta', predicate: 'urn:p:friend', object: 'urn:entity:alpha' },
      ],
    };
    await seedKC(store, fixture);

    const result = await extractV10KCFromStore(store, fixture.cgId, fixture.kaId);

    expect(result.ual).toBe(fixture.ual);
    expect(result.rootEntities).toEqual([...fixture.rootEntities].sort()
      .filter((v, i, a) => a.indexOf(v) === i));
    expect(result.triples).toHaveLength(fixture.publicTriples.length);
    expect(result.privateRoots).toEqual([]);

    // Build the canonical V10 root from the fixture (the source of truth) and from the extractor.
    const fixtureLeaves = fixture.publicTriples.map((t) => hashTripleV10(t.subject, t.predicate, t.object));
    const fixtureRoot = new V10MerkleTree(fixtureLeaves).root;

    const extractedRoot = new V10MerkleTree(result.leaves).root;
    expect(extractedRoot).toEqual(fixtureRoot);
  });

  it('handles skolemized blank-node descendants (.well-known/genid/) bound to a root entity', async () => {
    const ROOT = 'urn:entity:root';
    const BLANK = `${ROOT}/.well-known/genid/abc-1`;
    const fixture: KCFixture = {
      cgId: 9n,
      kaId: 100n,
      ual: 'did:dkg:hardhat:31337/0xpub/100',
      rootEntities: [ROOT],
      publicTriples: [
        { subject: ROOT, predicate: 'urn:p:has', object: BLANK },
        { subject: BLANK, predicate: 'urn:p:value', object: '"42"' },
      ],
    };
    await seedKC(store, fixture);

    const result = await extractV10KCFromStore(store, fixture.cgId, fixture.kaId);
    expect(result.triples.map((t) => t.subject).sort()).toEqual([ROOT, BLANK].sort());

    const fixtureLeaves = fixture.publicTriples.map((t) => hashTripleV10(t.subject, t.predicate, t.object));
    expect(new V10MerkleTree(result.leaves).root).toEqual(new V10MerkleTree(fixtureLeaves).root);
  });

  it('returns quads in the resolved named context graph data URI', async () => {
    const fixture: KCFixture = {
      cgId: 42n,
      cgName: 'devnet-test',
      kaId: 8n,
      ual: 'did:dkg:hardhat:31337/0xpub/8',
      rootEntities: ['urn:e:named'],
      publicTriples: [
        { subject: 'urn:e:named', predicate: 'urn:p:name', object: '"named"' },
      ],
    };
    await seedKC(store, fixture);

    const quads = await extractV10KCQuads(store, fixture.cgId, fixture.kaId);

    expect(quads).toHaveLength(1);
    expect(quads[0].graph).toBe(contextGraphDataUri(fixture.cgName!, fixture.cgId.toString()));
  });

  // Regression: T2 (devnet-sweep triage). The daemon's verify-quorum
  // path stamps `dkg:trustLevel = "N"` onto the dataGraph AFTER the
  // publisher has computed `merkleLeafCount` and registered it on-chain
  // (see `dkg-agent.stampTrustLevel` / `stampBatchTrustLevel`). For
  // single-node publishes (no remote ACK lands) this happens within
  // seconds of publish, polluting the dataGraph with one extra triple
  // per root subject. Without the post-publish predicate skip, the
  // extractor recomputes `merkleLeafCount + 1` and the prover dies with
  // `V10ProofLeafCountMismatchError` for every challenge period.
  it('skips post-publish dkg:trustLevel stamps so leaf count stays bit-identical with merkleLeafCount', async () => {
    const fixture: KCFixture = {
      cgId: 11n,
      kaId: 17n,
      ual: 'did:dkg:hardhat:31337/0xpub/17',
      rootEntities: ['urn:entity:trust-target'],
      publicTriples: [
        { subject: 'urn:entity:trust-target', predicate: 'urn:p:k', object: '"v"' },
      ],
    };
    await seedKC(store, fixture);

    const cgName = `cg-${fixture.cgId.toString()}`;
    const dataGraph = contextGraphDataUri(cgName, fixture.cgId.toString());
    const TRUST_LEVEL_PREDICATE = 'http://dkg.io/ontology/trustLevel';
    const LEGACY_TRUST_LEVEL_PREDICATE = 'https://dkg.network/ontology#trustLevel';
    await store.insert([
      {
        subject: 'urn:entity:trust-target',
        predicate: TRUST_LEVEL_PREDICATE,
        object: '"0"',
        graph: dataGraph,
      },
      {
        subject: 'urn:entity:trust-target',
        predicate: LEGACY_TRUST_LEVEL_PREDICATE,
        object: '"0"',
        graph: dataGraph,
      },
    ]);

    const result = await extractV10KCFromStore(store, fixture.cgId, fixture.kaId);

    expect(result.triples).toHaveLength(fixture.publicTriples.length);
    expect(result.triples.map((t) => t.predicate)).not.toContain(TRUST_LEVEL_PREDICATE);
    expect(result.triples.map((t) => t.predicate)).not.toContain(LEGACY_TRUST_LEVEL_PREDICATE);
    expect(result.leaves).toHaveLength(fixture.publicTriples.length);

    const fixtureLeaves = fixture.publicTriples.map((t) => hashTripleV10(t.subject, t.predicate, t.object));
    expect(new V10MerkleTree(result.leaves).root).toEqual(new V10MerkleTree(fixtureLeaves).root);
  });

  it('round-trips through buildV10ProofMaterial (extractor leaves accept on-chain commitment)', async () => {
    const fixture: KCFixture = {
      cgId: 1n,
      kaId: 5n,
      ual: 'did:dkg:hardhat:31337/0xpub/5',
      rootEntities: ['urn:e:1', 'urn:e:2', 'urn:e:3'],
      publicTriples: [
        { subject: 'urn:e:1', predicate: 'urn:p:k', object: '"a"' },
        { subject: 'urn:e:2', predicate: 'urn:p:k', object: '"b"' },
        { subject: 'urn:e:3', predicate: 'urn:p:k', object: '"c"' },
      ],
    };
    await seedKC(store, fixture);

    const result = await extractV10KCFromStore(store, fixture.cgId, fixture.kaId);
    // content-binding + structured commitment: prover submits N-Triple content bytes;
    // private sub-roots ride along as the committed sibling.
    const contents = result.triples.map((t) => tripleContentV10(t.subject, t.predicate, t.object));
    const { root, leafCount } = structuredKARootV10(contents.map(keccak256), result.privateRoots);
    const expected = { merkleRoot: root, merkleLeafCount: leafCount };

    for (let chunkId = 0; chunkId < leafCount; chunkId++) {
      const material = buildV10ProofMaterial(contents, result.privateRoots, chunkId, expected);
      expect(verifyV10ProofMaterial(material, chunkId, expected)).toBe(true);
    }
  });

  it('resolves CG names that contain "/" (v9-style <owner>/<slug> namespacing)', async () => {
    // Regression for a testnet incident where every random-sampling proof on every
    // beacon went unsubmitted: the CG name resolver in `ka-extractor.ts` rejected
    // any name containing "/", but real CGs were registered as
    // "0xb08…4794c/laptop-smoke" — owner-prefixed slugs. The FinalizationHandler
    // wrote canonical data under `did:dkg:context-graph:<owner>/<slug>/context/<cgId>/_meta`
    // (which is correct), but the extractor returned `null` from name resolution
    // and threw `KCNotFoundError` even after data was promoted, blocking proofs
    // forever. The relevant log line on every beacon was:
    //   `Finalization: promoted SWM snapshot to context graph 12 …`
    //   `[rs.tick.kc-not-synced] {"kaId":"6","cgId":"12","err":"KCNotFoundError"}`
    const fixture: KCFixture = {
      cgId: 12n,
      cgName: '0xb08A0F66d5A225D57Dee5fFa6C442e4DC2a4794c/laptop-smoke',
      kaId: 6n,
      ual: 'did:dkg:base:84532/0xb08A0F66d5A225D57Dee5fFa6C442e4DC2a4794c/5000001',
      rootEntities: ['urn:entity:slash-cg'],
      publicTriples: [
        { subject: 'urn:entity:slash-cg', predicate: 'urn:p:name', object: '"slash"' },
      ],
    };
    await seedKC(store, fixture);

    const result = await extractV10KCFromStore(store, fixture.cgId, fixture.kaId);
    expect(result.contextGraphName).toBe(fixture.cgName);
    expect(result.ual).toBe(fixture.ual);
    expect(result.triples).toHaveLength(1);
  });

  it('mixes public-triple leaves with private sub-root leaves (publisher symmetry)', async () => {
    const PRIVATE_ROOT = new Uint8Array(32).fill(0xab);
    const fixture: KCFixture = {
      cgId: 11n,
      kaId: 88n,
      ual: 'did:dkg:hardhat:31337/0xpub/88',
      rootEntities: ['urn:mix:1'],
      publicTriples: [
        { subject: 'urn:mix:1', predicate: 'urn:p:k', object: '"public"' },
      ],
      privateRoots: [PRIVATE_ROOT],
    };
    await seedKC(store, fixture);

    const result = await extractV10KCFromStore(store, fixture.cgId, fixture.kaId);
    expect(result.privateRoots).toEqual([PRIVATE_ROOT]);
    expect(result.leaves).toHaveLength(2);
    expect(result.leaves[1]).toEqual(PRIVATE_ROOT);
  });
});

describe('extractV10KCFromStore — error paths', () => {
  let store: OxigraphStore;
  beforeEach(() => {
    store = new OxigraphStore();
  });

  it('throws KCNotFoundError when the cgId has no ontology mapping (CG not synced)', async () => {
    // No ontology entry → cgId → name lookup fails → kc-not-synced.
    await expect(extractV10KCFromStore(store, 1n, 999n)).rejects.toBeInstanceOf(KCNotFoundError);
  });

  it('throws KCNotFoundError when the kaId is not indexed in _meta (CG synced, KC missing)', async () => {
    await seedOntology(store, 'cg-1', 1n);
    await expect(extractV10KCFromStore(store, 1n, 999n)).rejects.toBeInstanceOf(KCNotFoundError);
  });

  it('throws KCRootEntitiesNotFoundError when UAL exists but has no rootEntity links', async () => {
    const cgIdStr = '1';
    const cgName = 'cg-1';
    await seedOntology(store, cgName, 1n);
    const metaGraph = contextGraphMetaUri(cgName, cgIdStr);
    const ual = 'did:dkg:hardhat:31337/0xpub/9';
    await store.insert([
      { subject: ual, predicate: `${DKG}batchId`, object: `"9"^^<${XSD}integer>`, graph: metaGraph },
    ]);

    await expect(extractV10KCFromStore(store, 1n, 9n)).rejects.toBeInstanceOf(
      KCRootEntitiesNotFoundError,
    );
  });

  it('throws KCDataMissingError when meta resolves but the data graph has no triples for those roots', async () => {
    const fixture: KCFixture = {
      cgId: 1n,
      kaId: 7n,
      ual: 'did:dkg:hardhat:31337/0xpub/7',
      rootEntities: ['urn:absent:root'],
      publicTriples: [],
    };
    await seedKC(store, fixture);

    await expect(extractV10KCFromStore(store, fixture.cgId, fixture.kaId)).rejects.toBeInstanceOf(
      KCDataMissingError,
    );
  });

  it('uses a typed integer literal so kaId 1 vs 10 do not collide (P-18 lesson, mirrored)', async () => {
    // Two KCs with different batchIds in the same _meta graph. If the
    // SPARQL accidentally string-prefix-matches "1" against "10", we'd
    // get the wrong UAL. Mirrors publisher-layer P-18 regression test.
    const cgIdStr = '1';
    const cgName = 'cg-1';
    await seedOntology(store, cgName, 1n);
    const metaGraph = contextGraphMetaUri(cgName, cgIdStr);
    const dataGraph = contextGraphDataUri(cgName, cgIdStr);
    const UAL_1 = 'did:dkg:hardhat:31337/0xpub/1';
    const UAL_10 = 'did:dkg:hardhat:31337/0xpub/10';
    const ROOT_1 = 'urn:e:1';
    const ROOT_10 = 'urn:e:10';

    await store.insert([
      { subject: UAL_1, predicate: `${DKG}batchId`, object: `"1"^^<${XSD}integer>`, graph: metaGraph },
      { subject: `${UAL_1}/1`, predicate: `${DKG}partOf`, object: UAL_1, graph: metaGraph },
      { subject: `${UAL_1}/1`, predicate: `${DKG}rootEntity`, object: ROOT_1, graph: metaGraph },
      { subject: UAL_10, predicate: `${DKG}batchId`, object: `"10"^^<${XSD}integer>`, graph: metaGraph },
      { subject: `${UAL_10}/1`, predicate: `${DKG}partOf`, object: UAL_10, graph: metaGraph },
      { subject: `${UAL_10}/1`, predicate: `${DKG}rootEntity`, object: ROOT_10, graph: metaGraph },
      { subject: ROOT_1, predicate: 'urn:p:k', object: '"one"', graph: dataGraph },
      { subject: ROOT_10, predicate: 'urn:p:k', object: '"ten"', graph: dataGraph },
    ]);

    const r1 = await extractV10KCFromStore(store, 1n, 1n);
    expect(r1.ual).toBe(UAL_1);
    expect(r1.rootEntities).toEqual([ROOT_1]);

    const r10 = await extractV10KCFromStore(store, 1n, 10n);
    expect(r10.ual).toBe(UAL_10);
    expect(r10.rootEntities).toEqual([ROOT_10]);
  });
});

// GH #842 — updated KAs must remain provable by Random Sampling.
//
// V10 treats an update as a full restatement: the chain ASSIGNS merkleRoot /
// merkleLeafCount over the update payload. Before the fix, the update paths
// only wrote the payload into the label data graph and never promoted it into
// the per-cgId partition the prover reads, so `extractV10KCFromStore` kept
// returning the STALE pre-update KA — a leaf count that can never match the
// chain commitment (permanent `data-corrupted`). These tests pin that
// `promoteUpdatedKaToPerCgId` makes the extract reflect EXACTLY the payload.
describe('promoteUpdatedKaToPerCgId — updated KA stays provable (GH #842)', () => {
  let store: OxigraphStore;
  beforeEach(() => {
    store = new OxigraphStore();
  });

  const CG_ID = 5n;
  const CG_NAME = 'cg-5';
  const KA_ID = 42n;
  const UAL = 'did:dkg:hardhat:31337/0xpub/42';

  function payloadMap(triples: { subject: string; predicate: string; object: string }[]): Map<string, Quad[]> {
    const m = new Map<string, Quad[]>();
    for (const t of triples) {
      const root = t.subject.split('/.well-known/genid/')[0];
      const arr = m.get(root) ?? [];
      arr.push({ ...t, graph: '' });
      m.set(root, arr);
    }
    return m;
  }

  it('purges prior per-cgId data discovered through new-only dkg:entity rows', async () => {
    const dataGraph = `${contextGraphDataUri(CG_NAME)}/context/${CG_ID.toString()}/data`;
    const metaGraph = `${contextGraphDataUri(CG_NAME)}/context/${CG_ID.toString()}/_meta`;
    await store.insert([
      { subject: UAL, predicate: `${DKG}batchId`, object: `"${KA_ID}"^^<${XSD}integer>`, graph: metaGraph },
      { subject: `${UAL}/1`, predicate: `${RDF}type`, object: `${DKG}KnowledgeAsset`, graph: metaGraph },
      { subject: `${UAL}/1`, predicate: `${DKG}partOf`, object: UAL, graph: metaGraph },
      { subject: `${UAL}/1`, predicate: `${DKG}entity`, object: 'urn:orig:new-only', graph: metaGraph },
      { subject: 'urn:orig:new-only', predicate: 'urn:p:stale', object: '"stale"', graph: dataGraph },
    ]);
    const updateTriples = [{ subject: 'urn:upd:new-only', predicate: 'urn:p:fresh', object: '"fresh"' }];
    const merkleRoot = new V10MerkleTree(
      updateTriples.map((t) => hashTripleV10(t.subject, t.predicate, t.object)),
    ).root;

    const applied = await restateKaPartition({
      store, dataGraph, metaGraph, ual: UAL, kaId: KA_ID,
      merkleRoot, payloadByRoot: payloadMap(updateTriples),
    });
    expect(applied).toBe(true);

    const stale = await store.query(
      `ASK { GRAPH <${dataGraph}> { <urn:orig:new-only> ?p ?o } }`,
    );
    expect(stale.type === 'boolean' && stale.value).toBe(false);
  });

  it('extracts ONLY the update payload (new root) — stale original roots are purged', async () => {
    // Original publish promotion: one root with three triples.
    await seedKC(store, {
      cgId: CG_ID,
      cgName: CG_NAME,
      kaId: KA_ID,
      ual: UAL,
      rootEntities: ['urn:orig:a'],
      publicTriples: [
        { subject: 'urn:orig:a', predicate: 'urn:p:name', object: '"orig"' },
        { subject: 'urn:orig:a', predicate: 'urn:p:k1', object: '"1"' },
        { subject: 'urn:orig:a', predicate: 'urn:p:k2', object: '"2"' },
      ],
    });

    // Sanity: before the update the extract sees the original 3 triples.
    const before = await extractV10KCFromStore(store, CG_ID, KA_ID);
    expect(before.triples).toHaveLength(3);

    // Full-restatement update to a brand-new root with two triples (mirrors the
    // surgical RS harness's INCLUDE_UPDATED_COHORT pattern).
    const updateTriples = [
      { subject: 'urn:upd:b', predicate: 'urn:p:type', object: 'urn:UpdateAction' },
      { subject: 'urn:upd:b', predicate: 'urn:p:name', object: '"updated"' },
    ];
    const merkleRoot = new V10MerkleTree(
      updateTriples.map((t) => hashTripleV10(t.subject, t.predicate, t.object)),
    ).root;

    await promoteUpdatedKaToPerCgId({
      store,
      contextGraphId: CG_NAME,
      cgId: CG_ID.toString(),
      ual: UAL,
      kaId: KA_ID,
      merkleRoot,
      payloadByRoot: payloadMap(updateTriples),
    });

    const after = await extractV10KCFromStore(store, CG_ID, KA_ID);

    // The extract now reflects EXACTLY the payload — stale 'urn:orig:a' gone.
    expect(after.rootEntities).toEqual(['urn:upd:b']);
    expect(after.triples).toHaveLength(updateTriples.length);
    expect(after.triples.every((t) => t.subject === 'urn:upd:b')).toBe(true);

    // And the recomputed extract root matches what the chain committed to.
    expect(new V10MerkleTree(after.leaves).root).toEqual(merkleRoot);
  });

  it('replaces in-place when the update keeps the same root (content swap)', async () => {
    await seedKC(store, {
      cgId: CG_ID,
      cgName: CG_NAME,
      kaId: KA_ID,
      ual: UAL,
      rootEntities: ['urn:e:a'],
      publicTriples: [
        { subject: 'urn:e:a', predicate: 'urn:p:v', object: '"old-1"' },
        { subject: 'urn:e:a', predicate: 'urn:p:w', object: '"old-2"' },
      ],
    });

    const updateTriples = [{ subject: 'urn:e:a', predicate: 'urn:p:v', object: '"new"' }];
    const merkleRoot = new V10MerkleTree(
      updateTriples.map((t) => hashTripleV10(t.subject, t.predicate, t.object)),
    ).root;

    await promoteUpdatedKaToPerCgId({
      store,
      contextGraphId: CG_NAME,
      cgId: CG_ID.toString(),
      ual: UAL,
      kaId: KA_ID,
      merkleRoot,
      payloadByRoot: payloadMap(updateTriples),
    });

    const after = await extractV10KCFromStore(store, CG_ID, KA_ID);
    expect(after.rootEntities).toEqual(['urn:e:a']);
    expect(after.triples).toHaveLength(1);
    expect(after.triples[0].object).toBe('"new"');
    expect(new V10MerkleTree(after.leaves).root).toEqual(merkleRoot);
  });

  it('is idempotent on re-apply (gossip retry / duplicate delivery)', async () => {
    await seedKC(store, {
      cgId: CG_ID,
      cgName: CG_NAME,
      kaId: KA_ID,
      ual: UAL,
      rootEntities: ['urn:e:a'],
      publicTriples: [{ subject: 'urn:e:a', predicate: 'urn:p:v', object: '"old"' }],
    });

    const updateTriples = [
      { subject: 'urn:upd:x', predicate: 'urn:p:a', object: '"1"' },
      { subject: 'urn:upd:x', predicate: 'urn:p:b', object: '"2"' },
    ];
    const merkleRoot = new V10MerkleTree(
      updateTriples.map((t) => hashTripleV10(t.subject, t.predicate, t.object)),
    ).root;

    for (let i = 0; i < 2; i++) {
      await promoteUpdatedKaToPerCgId({
        store,
        contextGraphId: CG_NAME,
        cgId: CG_ID.toString(),
        ual: UAL,
        kaId: KA_ID,
        merkleRoot,
        payloadByRoot: payloadMap(updateTriples),
      });
    }

    const after = await extractV10KCFromStore(store, CG_ID, KA_ID);
    expect(after.rootEntities).toEqual(['urn:upd:x']);
    expect(after.triples).toHaveLength(updateTriples.length);
    expect(new V10MerkleTree(after.leaves).root).toEqual(merkleRoot);
  });
});

// GH #842 — the materialization version guard (last-writer-wins by chain order).
//
// Several independent async writers project a KA into the per-cgId partition:
// the publish→per-cgId promotion, the inline update promotion, and the gossip
// FinalizationHandler. The chain orders them (publish THEN update), but locally
// they can land in the OPPOSITE order — a late publish-promotion re-materialises
// the pre-update KA on top of an applied update, and the prover then extracts
// the stale state forever. The guard stamps each write with its chain version
// (`block:txIndex`) and refuses to apply anything older. These tests pin that
// the race is closed.
describe('materialization version guard — stale writer cannot clobber an update (GH #842)', () => {
  let store: OxigraphStore;
  beforeEach(() => {
    store = new OxigraphStore();
  });

  const CG_ID = 5n;
  const CG_NAME = 'cg-5';
  const KA_ID = 42n;
  const UAL = 'did:dkg:hardhat:31337/0xpub/42';

  function payloadMap(triples: { subject: string; predicate: string; object: string }[]): Map<string, Quad[]> {
    const m = new Map<string, Quad[]>();
    for (const t of triples) {
      const root = t.subject.split('/.well-known/genid/')[0];
      const arr = m.get(root) ?? [];
      arr.push({ ...t, graph: '' });
      m.set(root, arr);
    }
    return m;
  }

  const origTriples = [
    { subject: 'urn:orig:a', predicate: 'urn:p:name', object: '"orig"' },
    { subject: 'urn:orig:a', predicate: 'urn:p:k1', object: '"1"' },
    { subject: 'urn:orig:a', predicate: 'urn:p:k2', object: '"2"' },
  ];
  const origRoot = new V10MerkleTree(
    origTriples.map((t) => hashTripleV10(t.subject, t.predicate, t.object)),
  ).root;
  const updateTriples = [
    { subject: 'urn:upd:b', predicate: 'urn:p:type', object: 'urn:UpdateAction' },
    { subject: 'urn:upd:b', predicate: 'urn:p:name', object: '"updated"' },
  ];
  const updateRoot = new V10MerkleTree(
    updateTriples.map((t) => hashTripleV10(t.subject, t.predicate, t.object)),
  ).root;

  async function seedOriginalPublish(publishBlock: number): Promise<void> {
    // Original publish promotion: per-cgId KA materialised at `publishBlock`.
    await seedKC(store, {
      cgId: CG_ID, cgName: CG_NAME, kaId: KA_ID, ual: UAL,
      rootEntities: ['urn:orig:a'],
      publicTriples: origTriples,
    });
    const ctxMeta = contextGraphMetaUri(CG_NAME, CG_ID.toString());
    await writeMaterializedVersion(store, ctxMeta, UAL, { blockNumber: publishBlock, txIndex: 0 });
  }

  it('race: a late publish-promotion (older block) is a no-op once an update is applied', async () => {
    await seedOriginalPublish(100);

    // Update lands at a strictly later block — applies.
    const updateApplied = await promoteUpdatedKaToPerCgId({
      store, contextGraphId: CG_NAME, cgId: CG_ID.toString(), ual: UAL, kaId: KA_ID,
      merkleRoot: updateRoot, payloadByRoot: payloadMap(updateTriples),
      version: { blockNumber: 200, txIndex: 0 },
    });
    expect(updateApplied).toBe(true);

    // Late, stale publish-promotion of the ORIGINAL payload at the publish
    // block re-arrives (the GH#842 race). It MUST be rejected.
    const staleApplied = await promoteUpdatedKaToPerCgId({
      store, contextGraphId: CG_NAME, cgId: CG_ID.toString(), ual: UAL, kaId: KA_ID,
      merkleRoot: origRoot, payloadByRoot: payloadMap(origTriples),
      version: { blockNumber: 100, txIndex: 0 },
    });
    expect(staleApplied).toBe(false);

    // The prover still extracts EXACTLY the update — the race did not corrupt it.
    const after = await extractV10KCFromStore(store, CG_ID, KA_ID);
    expect(after.rootEntities).toEqual(['urn:upd:b']);
    expect(after.triples).toHaveLength(updateTriples.length);
    expect(new V10MerkleTree(after.leaves).root).toEqual(updateRoot);

    // And the recorded version is still the update's.
    const ctxMeta = contextGraphMetaUri(CG_NAME, CG_ID.toString());
    expect(await readMaterializedVersion(store, ctxMeta, UAL)).toEqual({ blockNumber: 200, txIndex: 0 });
  });

  it('uses txIndex as a tiebreaker within the same block', async () => {
    await seedOriginalPublish(200);
    // Same block, higher txIndex → newer → applies.
    const applied = await promoteUpdatedKaToPerCgId({
      store, contextGraphId: CG_NAME, cgId: CG_ID.toString(), ual: UAL, kaId: KA_ID,
      merkleRoot: updateRoot, payloadByRoot: payloadMap(updateTriples),
      version: { blockNumber: 200, txIndex: 3 },
    });
    expect(applied).toBe(true);
    // Same block, lower txIndex → older → no-op.
    const stale = await promoteUpdatedKaToPerCgId({
      store, contextGraphId: CG_NAME, cgId: CG_ID.toString(), ual: UAL, kaId: KA_ID,
      merkleRoot: origRoot, payloadByRoot: payloadMap(origTriples),
      version: { blockNumber: 200, txIndex: 1 },
    });
    expect(stale).toBe(false);
    const after = await extractV10KCFromStore(store, CG_ID, KA_ID);
    expect(after.rootEntities).toEqual(['urn:upd:b']);
  });

  it('re-applying the SAME version is idempotent (equal version allowed)', async () => {
    await seedOriginalPublish(100);
    const v = { blockNumber: 200, txIndex: 0 };
    for (let i = 0; i < 2; i++) {
      const applied = await promoteUpdatedKaToPerCgId({
        store, contextGraphId: CG_NAME, cgId: CG_ID.toString(), ual: UAL, kaId: KA_ID,
        merkleRoot: updateRoot, payloadByRoot: payloadMap(updateTriples), version: v,
      });
      expect(applied).toBe(true);
    }
    const after = await extractV10KCFromStore(store, CG_ID, KA_ID);
    expect(after.rootEntities).toEqual(['urn:upd:b']);
    expect(after.triples).toHaveLength(updateTriples.length);
    expect(new V10MerkleTree(after.leaves).root).toEqual(updateRoot);
  });

  it('without a version, writes always apply (back-compat with un-guarded callers)', async () => {
    await seedOriginalPublish(100);
    // No version passed → unconditional restatement (legacy behaviour).
    const applied = await promoteUpdatedKaToPerCgId({
      store, contextGraphId: CG_NAME, cgId: CG_ID.toString(), ual: UAL, kaId: KA_ID,
      merkleRoot: updateRoot, payloadByRoot: payloadMap(updateTriples),
    });
    expect(applied).toBe(true);
    const after = await extractV10KCFromStore(store, CG_ID, KA_ID);
    expect(after.rootEntities).toEqual(['urn:upd:b']);
  });
});

// GH #842 §7.1 — the LABEL graph must be fully restated on update too.
//
// The label graph (`did:dkg:context-graph:<name>` + `…/_meta`) is the
// app-facing, query-able view. The old update path deleted/inserted only the
// NEW payload roots, so a prior root's triples lingered (stale query results)
// and `resolveKA` still pointed at the gone root. `restateLabelGraphForUpdate`
// purges prior roots' data, repoints `dkg:rootEntity`, and preserves the rest
// of the KA's metadata (provenance, type).
describe('restateLabelGraphForUpdate — label graph full restatement (GH #842 §7.1)', () => {
  let store: OxigraphStore;
  beforeEach(() => {
    store = new OxigraphStore();
  });

  const CG_NAME = 'label-cg';
  const KA_ID = 7n;
  const UAL = 'did:dkg:hardhat:31337/0xpub/7';
  const labelData = contextGraphDataUri(CG_NAME);
  const labelMeta = contextGraphMetaUri(CG_NAME);

  function payloadMap(triples: { subject: string; predicate: string; object: string }[]): Map<string, Quad[]> {
    const m = new Map<string, Quad[]>();
    for (const t of triples) {
      const arr = m.get(t.subject) ?? [];
      arr.push({ ...t, graph: '' });
      m.set(t.subject, arr);
    }
    return m;
  }

  async function seedLabelPublish(): Promise<void> {
    await store.insert([
      // KC-level meta + rich KA provenance that must survive the update.
      { subject: UAL, predicate: `${DKG}batchId`, object: `"${KA_ID}"^^<${XSD}integer>`, graph: labelMeta },
      { subject: `${UAL}/1`, predicate: `${RDF}type`, object: `${DKG}KnowledgeAsset`, graph: labelMeta },
      { subject: `${UAL}/1`, predicate: `${DKG}partOf`, object: UAL, graph: labelMeta },
      { subject: `${UAL}/1`, predicate: `${DKG}rootEntity`, object: 'urn:orig:r', graph: labelMeta },
      { subject: `${UAL}/1`, predicate: `${DKG}authoredBy`, object: '"0xauthor"', graph: labelMeta },
      // Original public data.
      { subject: 'urn:orig:r', predicate: 'urn:p:a', object: '"1"', graph: labelData },
      { subject: 'urn:orig:r', predicate: 'urn:p:b', object: '"2"', graph: labelData },
    ]);
  }

  async function labelDataSubjects(): Promise<string[]> {
    const res = await store.query(
      `SELECT DISTINCT ?s WHERE { GRAPH <${labelData}> { ?s ?p ?o } }`,
    );
    return res.type === 'bindings'
      ? res.bindings.map((b) => b['s']).filter((s): s is string => !!s).sort()
      : [];
  }

  it('purges the prior root data, repoints rootEntity, and preserves provenance', async () => {
    await seedLabelPublish();
    const updateTriples = [{ subject: 'urn:new:r', predicate: 'urn:p:x', object: '"new"' }];
    const merkleRoot = new V10MerkleTree(
      updateTriples.map((t) => hashTripleV10(t.subject, t.predicate, t.object)),
    ).root;

    const applied = await restateLabelGraphForUpdate({
      store, dataGraph: labelData, metaGraph: labelMeta, ual: UAL,
      merkleRoot, payloadByRoot: payloadMap(updateTriples),
      version: { blockNumber: 200, txIndex: 0 },
    });
    expect(applied).toBe(true);

    // Stale 'urn:orig:r' data is gone; only the new root remains.
    expect(await labelDataSubjects()).toEqual(['urn:new:r']);

    // RFC ka-metadata-trim P3.1 (collapsed shape): rootEntity is re-stamped
    // on the UAL subject itself; the legacy `<ual>/1` token row found in the
    // store is removed entirely (the restate IS the migration).
    const rootRes = await store.query(
      `SELECT ?root WHERE { GRAPH <${labelMeta}> { <${UAL}> <${DKG}rootEntity> ?root } }`,
    );
    expect(rootRes.type === 'bindings' && rootRes.bindings[0]['root']).toBe('urn:new:r');
    const tokenGone = await store.query(
      `ASK { GRAPH <${labelMeta}> { <${UAL}/1> ?p ?o } }`,
    );
    expect(tokenGone.type === 'boolean' && tokenGone.value).toBe(false);
    // KC-level rows on the UAL subject are preserved.
    const batchKept = await store.query(
      `ASK { GRAPH <${labelMeta}> { <${UAL}> <${DKG}batchId> "${KA_ID}"^^<${XSD}integer> } }`,
    );
    expect(batchKept.type === 'boolean' && batchKept.value).toBe(true);
  });

  it('purges prior label data discovered through new-only dkg:entity rows', async () => {
    await store.insert([
      { subject: UAL, predicate: `${DKG}batchId`, object: `"${KA_ID}"^^<${XSD}integer>`, graph: labelMeta },
      { subject: `${UAL}/1`, predicate: `${RDF}type`, object: `${DKG}KnowledgeAsset`, graph: labelMeta },
      { subject: `${UAL}/1`, predicate: `${DKG}partOf`, object: UAL, graph: labelMeta },
      { subject: `${UAL}/1`, predicate: `${DKG}entity`, object: 'urn:orig:entity-only', graph: labelMeta },
      { subject: 'urn:orig:entity-only', predicate: 'urn:p:stale', object: '"stale"', graph: labelData },
    ]);
    const updateTriples = [{ subject: 'urn:new:entity-only', predicate: 'urn:p:fresh', object: '"fresh"' }];
    const merkleRoot = new V10MerkleTree(
      updateTriples.map((t) => hashTripleV10(t.subject, t.predicate, t.object)),
    ).root;

    const applied = await restateLabelGraphForUpdate({
      store, dataGraph: labelData, metaGraph: labelMeta, ual: UAL,
      merkleRoot, payloadByRoot: payloadMap(updateTriples),
      version: { blockNumber: 201, txIndex: 0 },
    });
    expect(applied).toBe(true);

    expect(await labelDataSubjects()).toEqual(['urn:new:entity-only']);
  });

  it('is guarded: an older-version label restatement is a no-op', async () => {
    await seedLabelPublish();
    await writeMaterializedVersion(store, labelMeta, UAL, { blockNumber: 300, txIndex: 0 });

    const updateTriples = [{ subject: 'urn:new:r', predicate: 'urn:p:x', object: '"new"' }];
    const merkleRoot = new V10MerkleTree(
      updateTriples.map((t) => hashTripleV10(t.subject, t.predicate, t.object)),
    ).root;
    const applied = await restateLabelGraphForUpdate({
      store, dataGraph: labelData, metaGraph: labelMeta, ual: UAL,
      merkleRoot, payloadByRoot: payloadMap(updateTriples),
      version: { blockNumber: 100, txIndex: 0 },
    });
    expect(applied).toBe(false);
    // Original data untouched.
    expect(await labelDataSubjects()).toEqual(['urn:orig:r']);
  });
});

// GH #842 — Codex review on PR #845 surfaced three sharper bugs in the original
// fix. These tests pin each one closed:
//
//  1. `txIndex` tiebreaker for SAME-block publish + update.
//     A publish that promotes at (block=B, txIndex=2) lands AFTER an update
//     applied at (block=B, txIndex=5) was supposed to win. With the v1 fix
//     both compared as `(B, 0)` (txIndex was hardcoded to 0), so the stale
//     publish-promotion clobbered the update.
//
//  2. Manifest root order preserved across restatement (≥10 roots).
//     `<ual>/1`, `<ual>/2`, …, `<ual>/10` are stable token identifiers.
//     Lex sort would put `<ual>/10` BEFORE `<ual>/2`, so the token→root
//     binding flipped on every restatement.
//
//  3. Surplus kaSubjects deleted when an update SHRINKS the root count.
//     The v1 fix only repointed `dkg:rootEntity` on retained tokens; surplus
//     prior tokens kept their `rdf:type KnowledgeAsset` / `dkg:partOf <ual>`
//     and showed up as phantoms in enumeration queries.
describe('GH#842 / PR #845 — Codex review fixes', () => {
  let store: OxigraphStore;
  beforeEach(() => {
    store = new OxigraphStore();
  });

  const CG_ID = 9n;
  const CG_NAME = 'cg-9';
  const KA_ID = 99n;
  const UAL = 'did:dkg:hardhat:31337/0xpub/99';
  const labelData = contextGraphDataUri(CG_NAME);
  const labelMeta = contextGraphMetaUri(CG_NAME);

  it('publish-promotion at (B, 2) is rejected when an update already materialised at (B, 5)', async () => {
    // Update materialised first at same block, higher txIndex.
    const ctxMeta = contextGraphMetaUri(CG_NAME, CG_ID.toString());
    const updateTriples = [{ subject: 'urn:upd', predicate: 'urn:p', object: '"u"' }];
    const updateRoot = new V10MerkleTree(
      updateTriples.map((t) => hashTripleV10(t.subject, t.predicate, t.object)),
    ).root;
    const updatePayload = new Map<string, Quad[]>([
      ['urn:upd', updateTriples.map((t) => ({ ...t, graph: '' }))],
    ]);
    expect(
      await promoteUpdatedKaToPerCgId({
        store, contextGraphId: CG_NAME, cgId: CG_ID.toString(), ual: UAL, kaId: KA_ID,
        merkleRoot: updateRoot, payloadByRoot: updatePayload,
        version: { blockNumber: 500, txIndex: 5 },
      }),
    ).toBe(true);

    // Late, stale publish-promotion at the SAME block, earlier txIndex.
    const origTriples = [{ subject: 'urn:orig', predicate: 'urn:p', object: '"o"' }];
    const origRoot = new V10MerkleTree(
      origTriples.map((t) => hashTripleV10(t.subject, t.predicate, t.object)),
    ).root;
    const origPayload = new Map<string, Quad[]>([
      ['urn:orig', origTriples.map((t) => ({ ...t, graph: '' }))],
    ]);
    expect(
      await promoteUpdatedKaToPerCgId({
        store, contextGraphId: CG_NAME, cgId: CG_ID.toString(), ual: UAL, kaId: KA_ID,
        merkleRoot: origRoot, payloadByRoot: origPayload,
        version: { blockNumber: 500, txIndex: 2 },
      }),
    ).toBe(false);
    // Materialised version is unchanged — and equals the update's.
    expect(await readMaterializedVersion(store, ctxMeta, UAL)).toEqual({ blockNumber: 500, txIndex: 5 });
  });

  it('preserves manifest root order for ≥10 batches (Codex bug 2)', async () => {
    // Seed a 12-batch KA in the label graph: token `<ual>/N` → root `urn:root:N`.
    const N = 12;
    const seedQuads: Quad[] = [
      { subject: UAL, predicate: `${DKG}batchId`, object: `"${KA_ID}"^^<${XSD}integer>`, graph: labelMeta },
    ];
    for (let i = 1; i <= N; i++) {
      seedQuads.push(
        { subject: `${UAL}/${i}`, predicate: `${RDF}type`, object: `${DKG}KnowledgeAsset`, graph: labelMeta },
        { subject: `${UAL}/${i}`, predicate: `${DKG}partOf`, object: UAL, graph: labelMeta },
        { subject: `${UAL}/${i}`, predicate: `${DKG}rootEntity`, object: `urn:root:${i}`, graph: labelMeta },
      );
    }
    await store.insert(seedQuads);

    // Update with NEW roots in the same numeric order. The map's insertion
    // order is the canonical "manifest" order, which restateLabelGraphForUpdate
    // MUST preserve when re-binding tokens.
    const payload: Map<string, Quad[]> = new Map();
    for (let i = 1; i <= N; i++) {
      payload.set(`urn:new:${i}`, [
        { subject: `urn:new:${i}`, predicate: 'urn:p', object: `"v${i}"`, graph: '' },
      ]);
    }
    const allTriples: { subject: string; predicate: string; object: string }[] = [];
    for (const qs of payload.values()) for (const q of qs) allTriples.push(q);
    const merkleRoot = new V10MerkleTree(
      allTriples.map((t) => hashTripleV10(t.subject, t.predicate, t.object)),
    ).root;

    expect(
      await restateLabelGraphForUpdate({
        store, dataGraph: labelData, metaGraph: labelMeta, ual: UAL,
        merkleRoot, payloadByRoot: payload,
      }),
    ).toBe(true);

    // RFC ka-metadata-trim P3.1 conditional collapse: a MULTI-root update
    // re-emits the per-token `<ual>/N` rows ALONGSIDE the collapsed UAL-subject
    // member set (see packages/publisher/test/multi-root-token-rows.test.ts).
    // The collapsed aggregate carries every new root as an unordered set.
    const rootsRes = await store.query(
      `SELECT ?root WHERE { GRAPH <${labelMeta}> { <${UAL}> <${DKG}rootEntity> ?root } }`,
    );
    expect(rootsRes.type).toBe('bindings');
    if (rootsRes.type === 'bindings') {
      const roots = new Set(rootsRes.bindings.map((b) => b['root']));
      expect(roots).toEqual(new Set(Array.from({ length: N }, (_, i) => `urn:new:${i + 1}`)));
    }
    // Codex bug 2 regression lock: EVERY re-emitted token `<ual>/N` MUST bind
    // `urn:new:N` in MANIFEST order. With a lex-sort regression we'd see
    // `<ual>/10` bound to `urn:new:2` (or vice-versa) because `"urn:new:10"`
    // lex-sorts before `"urn:new:2"`.
    for (let i = 1; i <= N; i++) {
      const res = await store.query(
        `SELECT ?root WHERE { GRAPH <${labelMeta}> { <${UAL}/${i}> <${DKG}rootEntity> ?root . <${UAL}/${i}> <${DKG}partOf> <${UAL}> } }`,
      );
      expect(res.type).toBe('bindings');
      if (res.type === 'bindings') {
        expect(res.bindings).toHaveLength(1);
        expect(res.bindings[0]['root']).toBe(`urn:new:${i}`);
      }
    }
  });

  it('deletes surplus kaSubjects when an update shrinks the root count (Codex bug 3)', async () => {
    // Seed a 5-batch KA, then update with 2 roots.
    await store.insert([
      { subject: UAL, predicate: `${DKG}batchId`, object: `"${KA_ID}"^^<${XSD}integer>`, graph: labelMeta },
      ...[1, 2, 3, 4, 5].flatMap((i) => [
        { subject: `${UAL}/${i}`, predicate: `${RDF}type`, object: `${DKG}KnowledgeAsset`, graph: labelMeta },
        { subject: `${UAL}/${i}`, predicate: `${DKG}partOf`, object: UAL, graph: labelMeta },
        { subject: `${UAL}/${i}`, predicate: `${DKG}rootEntity`, object: `urn:orig:${i}`, graph: labelMeta },
      ] as Quad[]),
    ]);

    const updateTriples = [
      { subject: 'urn:new:a', predicate: 'urn:p', object: '"a"' },
      { subject: 'urn:new:b', predicate: 'urn:p', object: '"b"' },
    ];
    const merkleRoot = new V10MerkleTree(
      updateTriples.map((t) => hashTripleV10(t.subject, t.predicate, t.object)),
    ).root;
    const payload = new Map<string, Quad[]>([
      ['urn:new:a', [{ ...updateTriples[0], graph: '' }]],
      ['urn:new:b', [{ ...updateTriples[1], graph: '' }]],
    ]);

    expect(
      await restateLabelGraphForUpdate({
        store, dataGraph: labelData, metaGraph: labelMeta, ual: UAL,
        merkleRoot, payloadByRoot: payload,
      }),
    ).toBe(true);

    // RFC ka-metadata-trim P3.1 (CONDITIONAL collapse): a MULTI-root update
    // re-emits exactly `newRoots.length` per-token rows in manifest order
    // alongside the UAL-subject member set. The Codex-bug-3 invariant is that
    // NO SURPLUS token survives the shrink: after 5→2, only `<ual>/1` and
    // `<ual>/2` exist; `<ual>/3..5` (and their roots) are gone.
    const enumRes = await store.query(
      `SELECT DISTINCT ?ka WHERE { GRAPH <${labelMeta}> { ?ka <${DKG}partOf> <${UAL}> } }`,
    );
    expect(enumRes.type).toBe('bindings');
    if (enumRes.type === 'bindings') {
      expect(new Set(enumRes.bindings.map((b) => b['ka']))).toEqual(
        new Set([`${UAL}/1`, `${UAL}/2`]),
      );
    }
    // Surplus prior tokens deleted: none of <ual>/3..5 survive.
    const surplusGone = await store.query(
      `ASK { GRAPH <${labelMeta}> {
         VALUES ?ka { <${UAL}/3> <${UAL}/4> <${UAL}/5> }
         ?ka ?p ?o .
       } }`,
    );
    expect(surplusGone.type === 'boolean' && surplusGone.value).toBe(false);
    // Re-emitted tokens carry the new roots in manifest order.
    const tokenRootRes = await store.query(
      `SELECT ?ka ?root WHERE { GRAPH <${labelMeta}> {
         ?ka <${DKG}partOf> <${UAL}> ; <${DKG}rootEntity> ?root .
       } }`,
    );
    expect(tokenRootRes.type).toBe('bindings');
    if (tokenRootRes.type === 'bindings') {
      const byToken = new Map(tokenRootRes.bindings.map((b) => [b['ka'], b['root']]));
      expect(byToken.get(`${UAL}/1`)).toBe('urn:new:a');
      expect(byToken.get(`${UAL}/2`)).toBe('urn:new:b');
    }
    const rootsRes = await store.query(
      `SELECT ?root WHERE { GRAPH <${labelMeta}> { <${UAL}> <${DKG}rootEntity> ?root } }`,
    );
    expect(rootsRes.type).toBe('bindings');
    if (rootsRes.type === 'bindings') {
      expect(new Set(rootsRes.bindings.map((b) => b['root']))).toEqual(new Set(['urn:new:a', 'urn:new:b']));
    }
  });
});
