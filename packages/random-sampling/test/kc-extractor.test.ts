/**
 * KCExtractor unit + gold tests.
 *
 * Pin the bit-for-bit recipe between publisher publish-path and the
 * Random Sampling prover's local extraction:
 *  - resolve KC UAL via `dkg:batchId == kcId` in _meta
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
  buildV10ProofMaterial,
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

const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

interface KCFixture {
  cgId: bigint;
  kcId: bigint;
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
      object: `"${fixture.kcId}"^^<${XSD}integer>`,
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
      kcId: 42n,
      ual: 'did:dkg:hardhat:31337/0xpub/42',
      rootEntities: ['urn:entity:alpha', 'urn:entity:beta'],
      publicTriples: [
        { subject: 'urn:entity:alpha', predicate: 'urn:p:name', object: '"alpha"' },
        { subject: 'urn:entity:beta', predicate: 'urn:p:name', object: '"beta"' },
        { subject: 'urn:entity:beta', predicate: 'urn:p:friend', object: 'urn:entity:alpha' },
      ],
    };
    await seedKC(store, fixture);

    const result = await extractV10KCFromStore(store, fixture.cgId, fixture.kcId);

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
      kcId: 100n,
      ual: 'did:dkg:hardhat:31337/0xpub/100',
      rootEntities: [ROOT],
      publicTriples: [
        { subject: ROOT, predicate: 'urn:p:has', object: BLANK },
        { subject: BLANK, predicate: 'urn:p:value', object: '"42"' },
      ],
    };
    await seedKC(store, fixture);

    const result = await extractV10KCFromStore(store, fixture.cgId, fixture.kcId);
    expect(result.triples.map((t) => t.subject).sort()).toEqual([ROOT, BLANK].sort());

    const fixtureLeaves = fixture.publicTriples.map((t) => hashTripleV10(t.subject, t.predicate, t.object));
    expect(new V10MerkleTree(result.leaves).root).toEqual(new V10MerkleTree(fixtureLeaves).root);
  });

  it('returns quads in the resolved named context graph data URI', async () => {
    const fixture: KCFixture = {
      cgId: 42n,
      cgName: 'devnet-test',
      kcId: 8n,
      ual: 'did:dkg:hardhat:31337/0xpub/8',
      rootEntities: ['urn:e:named'],
      publicTriples: [
        { subject: 'urn:e:named', predicate: 'urn:p:name', object: '"named"' },
      ],
    };
    await seedKC(store, fixture);

    const quads = await extractV10KCQuads(store, fixture.cgId, fixture.kcId);

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
      kcId: 17n,
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

    const result = await extractV10KCFromStore(store, fixture.cgId, fixture.kcId);

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
      kcId: 5n,
      ual: 'did:dkg:hardhat:31337/0xpub/5',
      rootEntities: ['urn:e:1', 'urn:e:2', 'urn:e:3'],
      publicTriples: [
        { subject: 'urn:e:1', predicate: 'urn:p:k', object: '"a"' },
        { subject: 'urn:e:2', predicate: 'urn:p:k', object: '"b"' },
        { subject: 'urn:e:3', predicate: 'urn:p:k', object: '"c"' },
      ],
    };
    await seedKC(store, fixture);

    const result = await extractV10KCFromStore(store, fixture.cgId, fixture.kcId);
    const tree = new V10MerkleTree(result.leaves);
    const expected = { merkleRoot: tree.root, merkleLeafCount: tree.leafCount };

    for (let chunkId = 0; chunkId < tree.leafCount; chunkId++) {
      const material = buildV10ProofMaterial(result.leaves, chunkId, expected);
      expect(V10MerkleTree.verify(expected.merkleRoot, material.leaf, material.proof, chunkId))
        .toBe(true);
    }
  });

  it('resolves CG names that contain "/" (v9-style <owner>/<slug> namespacing)', async () => {
    // Regression for a testnet incident where every random-sampling proof on every
    // beacon went unsubmitted: the CG name resolver in `kc-extractor.ts` rejected
    // any name containing "/", but real CGs were registered as
    // "0xb08…4794c/laptop-smoke" — owner-prefixed slugs. The FinalizationHandler
    // wrote canonical data under `did:dkg:context-graph:<owner>/<slug>/context/<cgId>/_meta`
    // (which is correct), but the extractor returned `null` from name resolution
    // and threw `KCNotFoundError` even after data was promoted, blocking proofs
    // forever. The relevant log line on every beacon was:
    //   `Finalization: promoted SWM snapshot to context graph 12 …`
    //   `[rs.tick.kc-not-synced] {"kcId":"6","cgId":"12","err":"KCNotFoundError"}`
    const fixture: KCFixture = {
      cgId: 12n,
      cgName: '0xb08A0F66d5A225D57Dee5fFa6C442e4DC2a4794c/laptop-smoke',
      kcId: 6n,
      ual: 'did:dkg:base:84532/0xb08A0F66d5A225D57Dee5fFa6C442e4DC2a4794c/5000001',
      rootEntities: ['urn:entity:slash-cg'],
      publicTriples: [
        { subject: 'urn:entity:slash-cg', predicate: 'urn:p:name', object: '"slash"' },
      ],
    };
    await seedKC(store, fixture);

    const result = await extractV10KCFromStore(store, fixture.cgId, fixture.kcId);
    expect(result.contextGraphName).toBe(fixture.cgName);
    expect(result.ual).toBe(fixture.ual);
    expect(result.triples).toHaveLength(1);
  });

  it('mixes public-triple leaves with private sub-root leaves (publisher symmetry)', async () => {
    const PRIVATE_ROOT = new Uint8Array(32).fill(0xab);
    const fixture: KCFixture = {
      cgId: 11n,
      kcId: 88n,
      ual: 'did:dkg:hardhat:31337/0xpub/88',
      rootEntities: ['urn:mix:1'],
      publicTriples: [
        { subject: 'urn:mix:1', predicate: 'urn:p:k', object: '"public"' },
      ],
      privateRoots: [PRIVATE_ROOT],
    };
    await seedKC(store, fixture);

    const result = await extractV10KCFromStore(store, fixture.cgId, fixture.kcId);
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

  it('throws KCNotFoundError when the kcId is not indexed in _meta (CG synced, KC missing)', async () => {
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
      kcId: 7n,
      ual: 'did:dkg:hardhat:31337/0xpub/7',
      rootEntities: ['urn:absent:root'],
      publicTriples: [],
    };
    await seedKC(store, fixture);

    await expect(extractV10KCFromStore(store, fixture.cgId, fixture.kcId)).rejects.toBeInstanceOf(
      KCDataMissingError,
    );
  });

  it('uses a typed integer literal so kcId 1 vs 10 do not collide (P-18 lesson, mirrored)', async () => {
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
