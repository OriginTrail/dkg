import { describe, it, expect } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { MockChainAdapter, buildKnowledgeAssetUal } from '@origintrail-official/dkg-chain';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import {
  createGraphKnowledgeAssetScope,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { FinalizationHandler } from '../src/finalization-handler.js';
import {
  reconcileContextGraph,
  type ChainReconcilerDeps,
  type OrdinalOutcome,
} from '../src/chain-reconciler.js';
import { createCursorState } from '../src/reconcile-cursor.js';
import {
  buildReconciledKnowledgeAssetUal,
  packKnowledgeAssetIdFromIdentity,
} from '../src/ka-identity.js';
import {
  graphHoldsTriple,
  knowledgeAssetVerifiedMemoryGraph,
  stageKnowledgeAssetInSharedMemory,
} from './_helpers/staged-knowledge-asset.js';

/**
 * Phase B end-to-end: drive the real sweep orchestrator (`reconcileContextGraph`)
 * with a `reconcileOrdinal` that mirrors the agent's `reconcileChainOrdinal`
 * (chain ordinal read -> merkle/publisher reads -> `handleChainReconciledKC`)
 * against a `MockChainAdapter` + a real `FinalizationHandler` over an Oxigraph
 * store. This pins the contract seams the pure unit tests can't: the per-CG
 * registration-ordinal indexing, the chain merkle-root byte format vs the
 * recompute match, the chain CG-binding verification, and the KA's own
 * Verified Memory graph the shared-memory copy is promoted into.
 */

const LOCAL_CG = 'fun-facts';
const AUTHOR = '0x9277a1a194fcadbb60d8df0c472e7909ead50e33';
const NAME = 'http://schema.org/name';

const fact = (entity: string, value: string) => ({ subject: entity, predicate: NAME, object: `"${value}"` });

function rootFor(entity: string, value: string): Uint8Array {
  return computeFlatKCRootV10([{ ...fact(entity, value), graph: '' }], []);
}

function scopeOf(chain: MockChainAdapter, kaNumber: bigint) {
  return createGraphKnowledgeAssetScope(buildKnowledgeAssetUal(chain.chainId, AUTHOR, kaNumber), '1');
}

/** Stage one KA's shared-memory copy in its own graph, with its workspace head. */
function stageSharedMemory(
  store: OxigraphStore,
  chain: MockChainAdapter,
  kaNumber: bigint,
  entity: string,
  value: string,
): Promise<void> {
  return stageKnowledgeAssetInSharedMemory({
    store,
    contextGraphId: LOCAL_CG,
    scope: scopeOf(chain, kaNumber),
    triples: [fact(entity, value)],
    shareOperationId: `e2e-share-${kaNumber}`,
    publisherPeerId: '12D3KooWE2ePublisher',
  });
}

function registerOnChain(chain: TestChain, kaNumber: bigint, root: Uint8Array): void {
  chain.__registerKC({
    kaId: packKnowledgeAssetIdFromIdentity({ agentAddress: AUTHOR, kaNumber }),
    contextGraphId: chain.onChainCg,
    merkleRootHex: ethers.hexlify(root),
    chunks: [],
  });
}

type TestChain = MockChainAdapter & { onChainCg: bigint };

/** A chain with one public context graph: promotion needs its live authority. */
async function makeChain(): Promise<TestChain> {
  const chain = new MockChainAdapter();
  chain.getLatestMerkleRootAuthor = async () => AUTHOR;
  const { contextGraphId } = await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1 });
  return Object.assign(chain, { onChainCg: contextGraphId });
}

/** Faithful mirror of DKGAgent.reconcileChainOrdinal (minus the active fetch). */
function makeReconcileOrdinal(
  chain: MockChainAdapter,
  fh: FinalizationHandler,
): ChainReconcilerDeps['reconcileOrdinal'] {
  return async (localCgId, onChainCgId, ordinal, headBlock): Promise<OrdinalOutcome> => {
    const versionBlock = headBlock ?? 0;
    const kaId = await chain.getContextGraphKCAt(onChainCgId, BigInt(ordinal));
    const storageAddr = await chain.getDKGKnowledgeAssetsAddress();
    const ual = buildReconciledKnowledgeAssetUal(chain.chainId, storageAddr, kaId);
    const merkleRoot = await chain.getLatestMerkleRoot(kaId);
    const publisherAddress = await chain.getLatestMerkleRootPublisher(kaId);

    const outcome = await fh.handleChainReconciledKC(
      {
        contextGraphId: localCgId,
        onChainCgId: onChainCgId.toString(),
        ual,
        merkleRoot,
        publisherAddress,
        kaId,
        // One packed KA per batch, as the agent passes it.
        batchId: kaId,
        versionBlock,
      },
      createOperationContext('system'),
    );
    switch (outcome) {
      case 'promoted':
        return { status: 'reconciled', blockNumber: versionBlock };
      case 'already-confirmed':
      case 'stale-target':
        return { status: 'already', blockNumber: versionBlock };
      default:
        return { status: 'pending' };
    }
  };
}

function makeDeps(
  chain: MockChainAdapter,
  fh: FinalizationHandler,
  persisted: number[],
): ChainReconcilerDeps {
  return {
    getKCCount: async (cg) => Number(await chain.getContextGraphKCCount!(cg)),
    getHeadBlock: async () => undefined, // mock has no getBlockNumber -> depth gate off
    reconcileOrdinal: makeReconcileOrdinal(chain, fh),
    persistWatermark: (_cg, watermark) => persisted.push(watermark),
    confirmationDepth: 5,
    log: () => undefined,
  };
}

/** Whether the Verified Memory graph of this KA, and no other graph, is asked for the fact. */
function isInVmOf(
  store: OxigraphStore,
  chain: MockChainAdapter,
  kaNumber: bigint,
  entity: string,
  value: string,
): Promise<boolean> {
  return graphHoldsTriple(
    store,
    knowledgeAssetVerifiedMemoryGraph(LOCAL_CG, scopeOf(chain, kaNumber)),
    fact(entity, value),
  );
}

/** Whether any Verified Memory graph holds the fact: for proving nothing was promoted. */
async function isAnywhereInVm(store: OxigraphStore, entity: string, value: string): Promise<boolean> {
  const res = await store.query(
    `ASK { GRAPH ?vm { <${entity}> <${NAME}> "${value}" } FILTER(CONTAINS(STR(?vm), "_verifiable_memory")) }`,
  );
  return res.type === 'boolean' && res.value;
}

describe('Phase B e2e — chain registration -> VM via the sweep', () => {
  it('promotes every registered KA the node holds in shared memory and advances the watermark', async () => {
    const store = new OxigraphStore();
    const chain = await makeChain();
    const fh = new FinalizationHandler(store, chain);

    // Two KAs registered to the CG, both with a local shared-memory copy.
    await stageSharedMemory(store, chain, 1n, 'urn:fact:a', 'Honey never spoils');
    await stageSharedMemory(store, chain, 2n, 'urn:fact:b', 'Octopuses have three hearts');
    registerOnChain(chain, 1n, rootFor('urn:fact:a', 'Honey never spoils'));
    registerOnChain(chain, 2n, rootFor('urn:fact:b', 'Octopuses have three hearts'));

    const persisted: number[] = [];
    const deps = makeDeps(chain, fh, persisted);
    const cursor = createCursorState(0);

    const res = await reconcileContextGraph(deps, cursor, LOCAL_CG, chain.onChainCg);

    expect(res.head).toBe(2);
    expect(res.watermark).toBe(2);
    expect(res.reconciled).toBe(2);
    expect(persisted).toEqual([2]);
    expect(await isInVmOf(store, chain, 1n, 'urn:fact:a', 'Honey never spoils')).toBe(true);
    expect(await isInVmOf(store, chain, 2n, 'urn:fact:b', 'Octopuses have three hearts')).toBe(true);
    // Each KA's content is in its own graph and not in the other's.
    expect(await isInVmOf(store, chain, 1n, 'urn:fact:b', 'Octopuses have three hearts')).toBe(false);
    expect(await isInVmOf(store, chain, 2n, 'urn:fact:a', 'Honey never spoils')).toBe(false);
  });

  it('does not materialize a chain-backed reconcile when the head block read fails', async () => {
    const store = new OxigraphStore();
    const chain = await makeChain();
    const fh = new FinalizationHandler(store, chain);

    await stageSharedMemory(store, chain, 3n, 'urn:fact:headfail', 'Chain heads matter');
    registerOnChain(chain, 3n, rootFor('urn:fact:headfail', 'Chain heads matter'));

    const persisted: number[] = [];
    const deps = {
      ...makeDeps(chain, fh, persisted),
      getHeadBlock: async () => {
        throw new Error('RPC down');
      },
    };
    const cursor = createCursorState(0);

    const res = await reconcileContextGraph(deps, cursor, LOCAL_CG, chain.onChainCg);

    expect(res).toMatchObject({ head: 1, watermark: 0, reconciled: 0, pending: 1 });
    expect(persisted).toEqual([]);
    expect(await isAnywhereInVm(store, 'urn:fact:headfail', 'Chain heads matter')).toBe(false);
  });

  it('holds the watermark at a gap and fills it on a later sweep (late shared-memory arrival)', async () => {
    const store = new OxigraphStore();
    const chain = await makeChain();
    const fh = new FinalizationHandler(store, chain);

    // ordinal 0 (KA 1) is held now; ordinal 1 (KA 2) arrives later.
    await stageSharedMemory(store, chain, 1n, 'urn:fact:0', 'A day on Venus is longer than its year');
    registerOnChain(chain, 1n, rootFor('urn:fact:0', 'A day on Venus is longer than its year'));
    registerOnChain(chain, 2n, rootFor('urn:fact:1', 'Bananas are berries'));

    const persisted: number[] = [];
    const deps = makeDeps(chain, fh, persisted);
    const cursor = createCursorState(0);

    // Sweep 1: ordinal 0 promotes (watermark -> 1); ordinal 1 is held nowhere (pending).
    const r1 = await reconcileContextGraph(deps, cursor, LOCAL_CG, chain.onChainCg);
    expect(r1.watermark).toBe(1);
    expect(persisted).toEqual([1]);
    expect(await isInVmOf(store, chain, 1n, 'urn:fact:0', 'A day on Venus is longer than its year')).toBe(true);
    expect(await isAnywhereInVm(store, 'urn:fact:1', 'Bananas are berries')).toBe(false);

    // The missing KA lands locally (simulating the active core-first fetch).
    await stageSharedMemory(store, chain, 2n, 'urn:fact:1', 'Bananas are berries');

    // Sweep 2: only the gap (ordinal 1) is re-attempted; it now fills -> watermark 2.
    const r2 = await reconcileContextGraph(deps, cursor, LOCAL_CG, chain.onChainCg);
    expect(r2.watermark).toBe(2);
    expect(persisted).toEqual([1, 2]);
    expect(await isInVmOf(store, chain, 2n, 'urn:fact:1', 'Bananas are berries')).toBe(true);
    expect(await isInVmOf(store, chain, 1n, 'urn:fact:1', 'Bananas are berries')).toBe(false);
  });

  it('leaves a KA held nowhere pending even when a historical workspace operation matches its root', async () => {
    const store = new OxigraphStore();
    const chain = await makeChain();
    const fh = new FinalizationHandler(store, chain);

    // A root-entity share from before per-KA graphs whose content hashes to
    // the registered root. Chain reconcile does not search these: the KA is
    // fetched from peers instead.
    const entity = 'urn:fact:historical';
    const value = 'Shared before per-KA graphs';
    await store.insert([
      { subject: entity, predicate: NAME, object: `"${value}"`, graph: `did:dkg:context-graph:${LOCAL_CG}/_shared_memory` },
      {
        subject: `urn:dkg:share:${entity}`,
        predicate: 'http://dkg.io/ontology/rootEntity',
        object: entity,
        graph: `did:dkg:context-graph:${LOCAL_CG}/_shared_memory_meta`,
      },
    ]);
    registerOnChain(chain, 4n, rootFor(entity, value));

    const persisted: number[] = [];
    const res = await reconcileContextGraph(makeDeps(chain, fh, persisted), createCursorState(0), LOCAL_CG, chain.onChainCg);

    expect(res).toMatchObject({ head: 1, watermark: 0, reconciled: 0, pending: 1 });
    expect(persisted).toEqual([]);
    expect(await isAnywhereInVm(store, entity, value)).toBe(false);
  });
});
