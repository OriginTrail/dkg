import { describe, it, expect, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { MockChainAdapter, buildKnowledgeAssetUal } from '@origintrail-official/dkg-chain';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import {
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { FinalizationHandler, SWM_SNAPSHOT_MERKLE_ROOT_PREDICATE } from '../src/finalization-handler.js';

/**
 * #1609 — the reader-maintained SWM snapshot-root memo. `findSwmSnapshotInNamespace`
 * used to recompute EVERY WorkspaceOperation's flat-KC root on every reconcile, so a
 * KA published elsewhere (no local SWM) forced a full O(#ops) scan just to conclude
 * "not here" — the 30–45s reconcile CONSTRUCT that dominated beacon load. These tests
 * pin the memo's contract: it is written from the exact `computeFlatKCRoot` value the
 * verify uses (consistency), the absent-KA lookup stops rescanning once ops are
 * stamped (the win), a stale stamp can only miss (never mis-promote — verify stays
 * authoritative) and self-heals, and any op re-write clears the stamp (invalidation).
 */

const LOCAL_CG = 'fun-facts';
const ON_CHAIN_CG = 77n;
const wsMetaGraph = contextGraphWorkspaceMetaGraphUri(LOCAL_CG);

/** Seed a local SWM snapshot for one KA and return its flat-KC merkle root. */
async function seedSwmSnapshot(store: OxigraphStore, entity: string, value: string): Promise<Uint8Array> {
  const wsGraph = contextGraphWorkspaceGraphUri(LOCAL_CG);
  await store.insert([
    { subject: entity, predicate: 'http://schema.org/name', object: `"${value}"`, graph: wsGraph },
    { subject: `urn:dkg:share:${entity}`, predicate: 'http://dkg.io/ontology/rootEntity', object: entity, graph: wsMetaGraph },
  ]);
  return computeFlatKCRootV10(
    [{ subject: entity, predicate: 'http://schema.org/name', object: `"${value}"`, graph: '' }],
    [],
  );
}

/** The flat-KC root a snapshot with this (entity,value) would hash to — WITHOUT seeding it. */
function rootFor(entity: string, value: string): Uint8Array {
  return computeFlatKCRootV10(
    [{ subject: entity, predicate: 'http://schema.org/name', object: `"${value}"`, graph: '' }],
    [],
  );
}

/** Drive the FinalizationHandler's chain-reconcile entry directly for one registered kaId. */
async function reconcileOne(chain: MockChainAdapter, fh: FinalizationHandler, kaId: bigint): Promise<string> {
  const storageAddr = await chain.getDKGKnowledgeAssetsAddress();
  const ual = buildKnowledgeAssetUal(chain.chainId, storageAddr, kaId);
  const merkleRoot = await chain.getLatestMerkleRoot(kaId);
  const publisherAddress = await chain.getLatestMerkleRootPublisher(kaId);
  return fh.handleChainReconciledKC(
    { contextGraphId: LOCAL_CG, onChainCgId: ON_CHAIN_CG.toString(), ual, merkleRoot, publisherAddress, kaId, versionBlock: 0 },
    createOperationContext('system'),
  );
}

/** Read back the snapshot-root memo as opSubject -> stamped hex. */
async function readStamps(store: OxigraphStore): Promise<Map<string, string>> {
  const res = await store.query(`SELECT ?op ?root WHERE {
    GRAPH <${wsMetaGraph}> { ?op <${SWM_SNAPSHOT_MERKLE_ROOT_PREDICATE}> ?root . }
  }`);
  const out = new Map<string, string>();
  if (res.type === 'bindings') {
    for (const row of res.bindings) {
      const op = typeof row['op'] === 'string' ? row['op'].replace(/^<(.*)>$/, '$1') : '';
      const root = typeof row['root'] === 'string' ? row['root'].replace(/^"(.*)".*$/, '$1') : '';
      if (op) out.set(op, root);
    }
  }
  return out;
}

async function isInVm(store: OxigraphStore, entity: string, value: string): Promise<boolean> {
  const perCgGraph = `did:dkg:context-graph:${LOCAL_CG}/context/${ON_CHAIN_CG}`;
  const res = await store.query(`ASK { GRAPH <${perCgGraph}> { <${entity}> <http://schema.org/name> "${value}" } }`);
  return res.type === 'boolean' && res.value;
}

describe('#1609 — SWM snapshot-root memo (finalization reconcile)', () => {
  it('stamps every recomputed op with the exact computeFlatKCRoot value on an absent-KA miss', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);

    // Two KAs whose SWM this node holds (published by others, not yet promoted here).
    const rootA = await seedSwmSnapshot(store, 'urn:fact:a', 'Honey never spoils');
    const rootB = await seedSwmSnapshot(store, 'urn:fact:b', 'Octopuses have three hearts');
    // Chain says ka-903 is registered to the CG, but this node has NO local SWM for it.
    const absent = rootFor('urn:fact:absent', 'A KA published elsewhere');
    chain.__registerKC({ kaId: 903n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(absent), chunks: [] });

    const outcome = await reconcileOne(chain, fh, 903n);
    expect(outcome).toBe('no-swm');

    // The scan it had to run to conclude "not here" memoized both present ops, and the
    // stamped value is byte-identical to the flat-KC root the verify path computes.
    const stamps = await readStamps(store);
    expect(stamps.get('urn:dkg:share:urn:fact:a')).toBe(ethers.hexlify(rootA));
    expect(stamps.get('urn:dkg:share:urn:fact:b')).toBe(ethers.hexlify(rootB));
  });

  it('skips the expensive merkle recompute on a warm absent-KA lookup when content is unchanged', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);

    await seedSwmSnapshot(store, 'urn:fact:a', 'Honey never spoils');
    await seedSwmSnapshot(store, 'urn:fact:b', 'Octopuses have three hearts');
    const absentX = rootFor('urn:fact:x', 'absent one');
    const absentY = rootFor('urn:fact:y', 'absent two');
    chain.__registerKC({ kaId: 991n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(absentX), chunks: [] });
    chain.__registerKC({ kaId: 992n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(absentY), chunks: [] });

    // computeOpMerkleRoot is the expensive flat-KC recompute; the content digest lets
    // the fallback skip it for ops whose content hasn't changed since they were stamped.
    const recompute = vi.spyOn(fh as unknown as { computeOpMerkleRoot: (...a: unknown[]) => unknown }, 'computeOpMerkleRoot');

    // Cold pass: no memo yet → recompute both present ops to conclude "absent".
    expect(await reconcileOne(chain, fh, 991n)).toBe('no-swm');
    expect(recompute.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Warm pass: a *different* absent KA, content unchanged → every op's digest still
    // matches its memo, so NOT ONE op is re-hashed (root reused straight from the memo).
    recompute.mockClear();
    expect(await reconcileOne(chain, fh, 992n)).toBe('no-swm');
    expect(recompute.mock.calls.length).toBe(0);

    recompute.mockRestore();
  });

  it('promotes a present KA resolved via its stamp (fast path is correct end-to-end)', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);

    const value = 'A day on Venus is longer than its year';
    const root = await seedSwmSnapshot(store, 'urn:fact:hit', value);
    // Pre-stamp the op exactly as a prior scan would have.
    await store.insert([{
      subject: 'urn:dkg:share:urn:fact:hit',
      predicate: SWM_SNAPSHOT_MERKLE_ROOT_PREDICATE,
      object: `"${ethers.hexlify(root)}"`,
      graph: wsMetaGraph,
    }]);
    chain.__registerKC({ kaId: 905n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(root), chunks: [] });

    expect(await reconcileOne(chain, fh, 905n)).toBe('promoted');
    expect(await isInVm(store, 'urn:fact:hit', value)).toBe(true);
  });

  it('never mis-promotes on a stale stamp (verify stays authoritative) and self-heals it', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);

    const value = 'Bananas are berries';
    const trueRoot = await seedSwmSnapshot(store, 'urn:fact:heal', value);
    const wrongRoot = rootFor('urn:fact:other', 'a different snapshot');
    expect(ethers.hexlify(trueRoot)).not.toBe(ethers.hexlify(wrongRoot));

    // Corrupt the memo: stamp the op with a root it does NOT hash to.
    await store.insert([{
      subject: 'urn:dkg:share:urn:fact:heal',
      predicate: SWM_SNAPSHOT_MERKLE_ROOT_PREDICATE,
      object: `"${ethers.hexlify(wrongRoot)}"`,
      graph: wsMetaGraph,
    }]);

    // A reconcile searching for wrongRoot must NOT promote this op (verify catches it).
    chain.__registerKC({ kaId: 906n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(wrongRoot), chunks: [] });
    expect(await reconcileOne(chain, fh, 906n)).toBe('no-swm');
    expect(await isInVm(store, 'urn:fact:heal', value)).toBe(false);

    // The stale stamp was self-healed to the op's real root during that pass...
    expect((await readStamps(store)).get('urn:dkg:share:urn:fact:heal')).toBe(ethers.hexlify(trueRoot));
    // ...so a reconcile for the TRUE root now resolves and promotes it.
    chain.__registerKC({ kaId: 907n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(trueRoot), chunks: [] });
    expect(await reconcileOne(chain, fh, 907n)).toBe('promoted');
    expect(await isInVm(store, 'urn:fact:heal', value)).toBe(true);
  });

  it('drops the stamp when the op subject is rewritten (the writer clears it at share/receive)', async () => {
    // Both SWM write paths (dkg-publisher share, workspace-handler gossip-receive) call
    // storeWorkspaceOperationPublicQuads, which deleteByPattern's the whole op subject
    // before rewriting it — so any content change clears the memo for free. Mirror that
    // exact op-subject wipe and assert the stamp is gone.
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);

    await seedSwmSnapshot(store, 'urn:fact:inv', 'Lightning is hotter than the sun');
    const absent = rootFor('urn:fact:none', 'absent');
    chain.__registerKC({ kaId: 908n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(absent), chunks: [] });
    await reconcileOne(chain, fh, 908n); // scan -> stamps the op
    expect((await readStamps(store)).has('urn:dkg:share:urn:fact:inv')).toBe(true);

    // A re-share/gossip-receive rewrites the op subject (storeWorkspaceOperationPublicQuads:101).
    await store.deleteByPattern({ graph: wsMetaGraph, subject: 'urn:dkg:share:urn:fact:inv' });

    expect((await readStamps(store)).has('urn:dkg:share:urn:fact:inv')).toBe(false);
  });
});
