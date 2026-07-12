import { afterEach, describe, it, expect, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { MockChainAdapter, buildKnowledgeAssetUal } from '@origintrail-official/dkg-chain';
import { computeFlatKCRootV10, generatedPrivateCatalogFloorQuads } from '@origintrail-official/dkg-publisher';
import {
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { FinalizationHandler } from '../src/finalization-handler.js';

/**
 * #1609 — the write-generation-gated NEGATIVE memo over `findSwmSnapshotForMerkleRoot`
 * (the layer #1612's digest memo could not provide). During the 2026-07-11/12 testnet
 * incident, never-match KAs — publishes this node never shared — re-ran O(#ops)
 * unbounded SWM CONSTRUCT reads on EVERY reconcile sweep tick, stalling the event
 * loop 30–46s per pass on big stores and dropping storage-ACK streams. These tests
 * pin the memo's contract: a "no local snapshot" verdict is replayed with ZERO slice
 * reads while the store's write generation for the CG is unchanged (the win), and
 * ANY local write under the CG — entity-keyed data changes with identical triple
 * counts, `privateMerkleRoot` meta arrivals, whole-snapshot arrivals — invalidates
 * it so the next reconcile rescans and PROMOTES (the false-negative guard, the class
 * that caught #1612's first cut in core-fills-gap.test.ts). The TTL bounds writers
 * the adapter counter cannot see.
 */

const LOCAL_CG = 'fun-facts';
const ON_CHAIN_CG = 77n;
const wsGraph = contextGraphWorkspaceGraphUri(LOCAL_CG);
const wsMetaGraph = contextGraphWorkspaceMetaGraphUri(LOCAL_CG);
const NAME_PRED = 'http://schema.org/name';
const PRIVATE_ROOT_PRED = 'http://dkg.io/ontology/privateMerkleRoot';

/** Seed a local SWM snapshot for one KA and return its flat-KC merkle root. */
async function seedSwmSnapshot(store: OxigraphStore, entity: string, value: string): Promise<Uint8Array> {
  await store.insert([
    { subject: entity, predicate: NAME_PRED, object: `"${value}"`, graph: wsGraph },
    { subject: `urn:dkg:share:${entity}`, predicate: 'http://dkg.io/ontology/rootEntity', object: entity, graph: wsMetaGraph },
  ]);
  return rootFor(entity, value);
}

/** The flat-KC root a snapshot with this (entity,value) would hash to — WITHOUT seeding it. */
function rootFor(entity: string, value: string, privateRoots: Uint8Array[] = []): Uint8Array {
  return computeFlatKCRootV10(
    [{ subject: entity, predicate: NAME_PRED, object: `"${value}"`, graph: '' }],
    privateRoots,
  );
}

/** Drive the FinalizationHandler's chain-reconcile entry directly for one registered kaId. */
async function reconcileOne(
  chain: MockChainAdapter,
  fh: FinalizationHandler,
  kaId: bigint,
  onChainCgId: bigint = ON_CHAIN_CG,
): Promise<string> {
  const storageAddr = await chain.getDKGKnowledgeAssetsAddress();
  const ual = buildKnowledgeAssetUal(chain.chainId, storageAddr, kaId);
  const merkleRoot = await chain.getLatestMerkleRoot(kaId);
  const publisherAddress = await chain.getLatestMerkleRootPublisher(kaId);
  return fh.handleChainReconciledKC(
    { contextGraphId: LOCAL_CG, onChainCgId: onChainCgId.toString(), ual, merkleRoot, publisherAddress, kaId, versionBlock: 0 },
    createOperationContext('system'),
  );
}

async function isInVm(store: OxigraphStore, entity: string, value: string, onChainCgId: bigint = ON_CHAIN_CG): Promise<boolean> {
  const perCgGraph = `did:dkg:context-graph:${LOCAL_CG}/context/${onChainCgId}`;
  const res = await store.query(`ASK { GRAPH <${perCgGraph}> { <${entity}> <${NAME_PRED}> "${value}" } }`);
  return res.type === 'boolean' && res.value;
}

/**
 * Drive the never-match reconcile until the negative memo is stable. The first
 * scan may restamp ops (#1612) — a local write that self-invalidates the memo
 * recorded at the pre-scan generation — so the second pass scans unchanged
 * content, performs no writes, and records a stable-generation entry.
 */
async function settleNegativeMemo(
  chain: MockChainAdapter,
  fh: FinalizationHandler,
  kaId: bigint,
  onChainCgId: bigint = ON_CHAIN_CG,
): Promise<void> {
  expect(await reconcileOne(chain, fh, kaId, onChainCgId)).toBe('no-swm');
  expect(await reconcileOne(chain, fh, kaId, onChainCgId)).toBe('no-swm');
}

type FhSeams = {
  getSharedMemoryQuadsForRoots: (...a: unknown[]) => Promise<unknown>;
  computeOpMerkleRoot: (...a: unknown[]) => unknown;
};
const readSeam = (fh: FinalizationHandler) =>
  vi.spyOn(fh as unknown as FhSeams, 'getSharedMemoryQuadsForRoots');
const recomputeSeam = (fh: FinalizationHandler) =>
  vi.spyOn(fh as unknown as FhSeams, 'computeOpMerkleRoot');

afterEach(() => {
  delete process.env.DKG_VM_RECONCILE_NEGATIVE_TTL_MS;
  vi.restoreAllMocks();
});

describe('#1609 — write-gen-gated negative memo (chain-reconcile backstop)', () => {
  it('replays a warm never-match verdict with ZERO slice reads until a local write lands', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);

    await seedSwmSnapshot(store, 'urn:fact:a', 'Honey never spoils');
    await seedSwmSnapshot(store, 'urn:fact:b', 'Octopuses have three hearts');
    // Warm the #1612 op stamps with one absent-KA pass so the cold pass below
    // performs no writes of its own (a stamping pass bumps the write generation
    // and correctly self-invalidates its memo entry).
    chain.__registerKC({ kaId: 940n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(rootFor('urn:fact:w', 'warm-up')), chunks: [] });
    expect(await reconcileOne(chain, fh, 940n)).toBe('no-swm');

    chain.__registerKC({ kaId: 941n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(rootFor('urn:fact:absent', 'published elsewhere')), chunks: [] });
    const reads = readSeam(fh);
    const recompute = recomputeSeam(fh);

    // Cold pass for THIS root: the authoritative scan must read ≥1 op slice.
    expect(await reconcileOne(chain, fh, 941n)).toBe('no-swm');
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(1);

    // Warm pass, same root, no writes since: served from the memo — not one
    // slice read, not one merkle recompute.
    reads.mockClear();
    recompute.mockClear();
    expect(await reconcileOne(chain, fh, 941n)).toBe('no-swm');
    expect(reads.mock.calls.length).toBe(0);
    expect(recompute.mock.calls.length).toBe(0);
  });

  it('promotes after the matching SWM arrives through the real write path (false-negative guard)', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);

    // An unrelated op so a real scan is observable on the read seam.
    await seedSwmSnapshot(store, 'urn:fact:a', 'Honey never spoils');
    const value = 'A KA that arrives later';
    chain.__registerKC({ kaId: 950n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(rootFor('urn:fact:late', value)), chunks: [] });
    await settleNegativeMemo(chain, fh, 950n);

    // Memo engaged — the exact moment a stale negative verdict could strand the KA.
    const reads = readSeam(fh);
    expect(await reconcileOne(chain, fh, 950n)).toBe('no-swm');
    expect(reads.mock.calls.length).toBe(0);

    // Arrival: gossip receive / publish share / active fetch all end in adapter
    // writes under the CG's SWM graphs — the write generation bumps.
    await seedSwmSnapshot(store, 'urn:fact:late', value);

    reads.mockClear();
    expect(await reconcileOne(chain, fh, 950n)).toBe('promoted');
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(await isInVm(store, 'urn:fact:late', value)).toBe(true);
  });

  it('invalidates on an entity-keyed data change with an identical triple count', async () => {
    // The class that stranded #1612's first cut (core-fills-gap.test.ts:981): an
    // op completes incrementally via entity-keyed writes that never rewrite the
    // op subject and never change the graph's row count.
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);

    await seedSwmSnapshot(store, 'urn:fact:morph', 'incomplete draft');
    chain.__registerKC({ kaId: 960n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(rootFor('urn:fact:morph', 'final content')), chunks: [] });
    await settleNegativeMemo(chain, fh, 960n);

    const reads = readSeam(fh);
    expect(await reconcileOne(chain, fh, 960n)).toBe('no-swm');
    expect(reads.mock.calls.length).toBe(0);

    // Same-count content swap on the entity — op subject untouched.
    await store.delete([{ subject: 'urn:fact:morph', predicate: NAME_PRED, object: '"incomplete draft"', graph: wsGraph }]);
    await store.insert([{ subject: 'urn:fact:morph', predicate: NAME_PRED, object: '"final content"', graph: wsGraph }]);

    reads.mockClear();
    expect(await reconcileOne(chain, fh, 960n)).toBe('promoted');
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(await isInVm(store, 'urn:fact:morph', 'final content')).toBe(true);
  });

  it('invalidates on a privateMerkleRoot meta write', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);

    const value = 'private-backed content';
    await seedSwmSnapshot(store, 'urn:fact:priv', value);
    const privRoot = new Uint8Array(32).fill(7);
    // The chain root commits to the private root the op does not yet carry.
    chain.__registerKC({ kaId: 970n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(rootFor('urn:fact:priv', value, [privRoot])), chunks: [] });
    await settleNegativeMemo(chain, fh, 970n);

    const reads = readSeam(fh);
    expect(await reconcileOne(chain, fh, 970n)).toBe('no-swm');
    expect(reads.mock.calls.length).toBe(0);

    // The private root replicates in via an entity-keyed SWM meta write.
    await store.insert([{ subject: 'urn:fact:priv', predicate: PRIVATE_ROOT_PRED, object: `"${ethers.hexlify(privRoot)}"`, graph: wsMetaGraph }]);

    reads.mockClear();
    expect(await reconcileOne(chain, fh, 970n)).toBe('promoted');
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(await isInVm(store, 'urn:fact:priv', value)).toBe(true);
  });

  it('suppresses rescans for a public catalog-floor CG and still promotes a floor-augmented match on arrival', async () => {
    // Public (catalog-floor) CGs disable the #1612 stamp index entirely — their
    // match is over quads+floor, not an op's intrinsic root — so this memo is
    // the ONLY rescan damping they get. The memo caches the whole scan result,
    // floor retry included.
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);
    const created = await chain.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 1,
      nameHash: ethers.keccak256(ethers.toUtf8Bytes(LOCAL_CG)),
    });
    const cgId = created.contextGraphId;

    await seedSwmSnapshot(store, 'urn:fact:a', 'Honey never spoils');
    const value = 'floor-augmented content';
    const floorRoot = computeFlatKCRootV10(
      [
        { subject: 'urn:fact:floor', predicate: NAME_PRED, object: `"${value}"`, graph: '' },
        ...generatedPrivateCatalogFloorQuads(LOCAL_CG),
      ],
      [],
    );
    chain.__registerKC({ kaId: 980n, contextGraphId: cgId, merkleRootHex: ethers.hexlify(floorRoot), chunks: [] });
    await settleNegativeMemo(chain, fh, 980n, cgId);

    const reads = readSeam(fh);
    expect(await reconcileOne(chain, fh, 980n, cgId)).toBe('no-swm');
    expect(reads.mock.calls.length).toBe(0);

    await seedSwmSnapshot(store, 'urn:fact:floor', value);

    reads.mockClear();
    expect(await reconcileOne(chain, fh, 980n, cgId)).toBe('promoted');
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(await isInVm(store, 'urn:fact:floor', value, cgId)).toBe(true);
  });

  it('forces a rescan once the TTL expires even with no observed writes', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);

    await seedSwmSnapshot(store, 'urn:fact:a', 'Honey never spoils');
    chain.__registerKC({ kaId: 990n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(rootFor('urn:fact:absent', 'published elsewhere')), chunks: [] });
    await settleNegativeMemo(chain, fh, 990n);

    // Within TTL: memoized.
    const reads = readSeam(fh);
    expect(await reconcileOne(chain, fh, 990n)).toBe('no-swm');
    expect(reads.mock.calls.length).toBe(0);

    // Shrink the TTL below the entry's age: the writer-invisible-to-the-counter
    // escape hatch must force one authoritative rescan.
    process.env.DKG_VM_RECONCILE_NEGATIVE_TTL_MS = '1';
    await new Promise((resolve) => setTimeout(resolve, 10));
    reads.mockClear();
    expect(await reconcileOne(chain, fh, 990n)).toBe('no-swm');
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
