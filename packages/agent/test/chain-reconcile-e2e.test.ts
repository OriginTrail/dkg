import { describe, it, expect } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { MockChainAdapter, buildKnowledgeAssetUal } from '@origintrail-official/dkg-chain';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import {
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
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

/**
 * Phase B end-to-end: drive the real sweep orchestrator (`reconcileContextGraph`)
 * with a `reconcileOrdinal` that mirrors the agent's `reconcileChainOrdinal`
 * (chain ordinal read -> merkle/publisher reads -> `handleChainReconciledKC`)
 * against a `MockChainAdapter` + a real `FinalizationHandler` over an Oxigraph
 * store. This pins the contract seams the pure unit tests can't: the per-CG
 * registration-ordinal indexing, the chain merkle-root byte format vs the
 * recompute match, the chain CG-binding verification, and the per-cgId VM graph
 * the snapshot is promoted into.
 */

const LOCAL_CG = 'fun-facts';
const ON_CHAIN_CG = 77n;

/** Seed a local SWM snapshot for one KA and return its flat-KC merkle root. */
async function seedSwmSnapshot(store: OxigraphStore, entity: string, value: string): Promise<Uint8Array> {
  const wsGraph = contextGraphWorkspaceGraphUri(LOCAL_CG);
  const wsMetaGraph = contextGraphWorkspaceMetaGraphUri(LOCAL_CG);
  await store.insert([
    { subject: entity, predicate: 'http://schema.org/name', object: `"${value}"`, graph: wsGraph },
    { subject: `urn:dkg:share:${entity}`, predicate: 'http://dkg.io/ontology/rootEntity', object: entity, graph: wsMetaGraph },
  ]);
  return computeFlatKCRootV10(
    [{ subject: entity, predicate: 'http://schema.org/name', object: `"${value}"`, graph: '' }],
    [],
  );
}

/**
 * Seed the durable per-root `keepRootCopyOnLabel` signal the publisher writes
 * into SWM workspace meta at publish time (the chain-driven path's equivalent
 * of the gossip envelope flag). `FinalizationHandler.getKeepRootCopySignal`
 * reads it back to decide the same-graph dual-write during reconcile.
 */
async function seedKeepRootSignal(
  store: OxigraphStore,
  entity: string,
  keep: boolean,
  form: 'plain' | 'typed' = 'plain',
): Promise<void> {
  const object = form === 'typed'
    ? `"${keep}"^^<http://www.w3.org/2001/XMLSchema#boolean>`
    : `"${keep}"`;
  await store.insert([{
    subject: entity,
    predicate: 'http://dkg.io/ontology/keepRootCopyOnLabel',
    object,
    graph: contextGraphWorkspaceMetaGraphUri(LOCAL_CG),
  }]);
}

/** Faithful mirror of DKGAgent.reconcileChainOrdinal (minus the active fetch). */
function makeReconcileOrdinal(
  store: OxigraphStore,
  chain: MockChainAdapter,
  fh: FinalizationHandler,
): ChainReconcilerDeps['reconcileOrdinal'] {
  return async (localCgId, onChainCgId, ordinal, headBlock): Promise<OrdinalOutcome> => {
    const versionBlock = headBlock ?? 0;
    const kaId = await chain.getContextGraphKCAt(onChainCgId, BigInt(ordinal));
    const storageAddr = await chain.getDKGKnowledgeAssetsAddress();
    const ual = buildKnowledgeAssetUal(chain.chainId, storageAddr, kaId);
    const merkleRoot = await chain.getLatestMerkleRoot(kaId);
    const publisherAddress = await chain.getLatestMerkleRootPublisher(kaId);

    const outcome = await fh.handleChainReconciledKC(
      { contextGraphId: localCgId, onChainCgId: onChainCgId.toString(), ual, merkleRoot, publisherAddress, kaId, versionBlock },
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
  store: OxigraphStore,
  chain: MockChainAdapter,
  fh: FinalizationHandler,
  persisted: number[],
): ChainReconcilerDeps {
  return {
    getKCCount: async (cg) => Number(await chain.getContextGraphKCCount!(cg)),
    getHeadBlock: async () => undefined, // mock has no getBlockNumber -> depth gate off
    reconcileOrdinal: makeReconcileOrdinal(store, chain, fh),
    persistWatermark: (_cg, watermark) => persisted.push(watermark),
    confirmationDepth: 5,
    log: () => undefined,
  };
}

async function isInVm(store: OxigraphStore, entity: string, value: string): Promise<boolean> {
  const perCgGraph = `did:dkg:context-graph:${LOCAL_CG}/context/${ON_CHAIN_CG}`;
  const res = await store.query(
    `ASK { GRAPH <${perCgGraph}> { <${entity}> <http://schema.org/name> "${value}" } }`,
  );
  return res.type === 'boolean' && res.value;
}

/** True when the quad landed in the root LABEL data graph (`did:dkg:context-graph:<cg>`), i.e. the same-graph dual-write fired. */
async function isInRootLabel(store: OxigraphStore, entity: string, value: string): Promise<boolean> {
  const rootGraph = `did:dkg:context-graph:${LOCAL_CG}`;
  const res = await store.query(
    `ASK { GRAPH <${rootGraph}> { <${entity}> <http://schema.org/name> "${value}" } }`,
  );
  return res.type === 'boolean' && res.value;
}

describe('Phase B e2e — chain registration -> VM via the sweep', () => {
  it('promotes every registered KC the node has SWM for and advances the watermark', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);

    // Two KAs registered to the CG, both with a local SWM snapshot.
    const rootA = await seedSwmSnapshot(store, 'urn:fact:a', 'Honey never spoils');
    const rootB = await seedSwmSnapshot(store, 'urn:fact:b', 'Octopuses have three hearts');
    chain.__registerKC({ kaId: 101n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(rootA), chunks: [] });
    chain.__registerKC({ kaId: 102n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(rootB), chunks: [] });

    const persisted: number[] = [];
    const deps = makeDeps(store, chain, fh, persisted);
    const cursor = createCursorState(0);

    const res = await reconcileContextGraph(deps, cursor, LOCAL_CG, ON_CHAIN_CG);

    expect(res.head).toBe(2);
    expect(res.watermark).toBe(2);
    expect(res.reconciled).toBe(2);
    expect(persisted).toEqual([2]);
    expect(await isInVm(store, 'urn:fact:a', 'Honey never spoils')).toBe(true);
    expect(await isInVm(store, 'urn:fact:b', 'Octopuses have three hearts')).toBe(true);
  });

  it('holds the watermark at a gap and fills it on a later sweep (late SWM arrival)', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);

    // ordinal 0 (ka 201) has SWM now; ordinal 1 (ka 202) arrives later.
    const root0 = await seedSwmSnapshot(store, 'urn:fact:0', 'A day on Venus is longer than its year');
    const root1 = computeFlatKCRootV10(
      [{ subject: 'urn:fact:1', predicate: 'http://schema.org/name', object: '"Bananas are berries"', graph: '' }],
      [],
    );
    chain.__registerKC({ kaId: 201n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(root0), chunks: [] });
    chain.__registerKC({ kaId: 202n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(root1), chunks: [] });

    const persisted: number[] = [];
    const deps = makeDeps(store, chain, fh, persisted);
    const cursor = createCursorState(0);

    // Sweep 1: ordinal 0 promotes (watermark -> 1); ordinal 1 has no SWM (pending).
    const r1 = await reconcileContextGraph(deps, cursor, LOCAL_CG, ON_CHAIN_CG);
    expect(r1.watermark).toBe(1);
    expect(persisted).toEqual([1]);
    expect(await isInVm(store, 'urn:fact:0', 'A day on Venus is longer than its year')).toBe(true);

    // The missing snapshot lands locally (simulating the active core-first fetch).
    await seedSwmSnapshot(store, 'urn:fact:1', 'Bananas are berries');

    // Sweep 2: only the gap (ordinal 1) is re-attempted; it now fills -> watermark 2.
    const r2 = await reconcileContextGraph(deps, cursor, LOCAL_CG, ON_CHAIN_CG);
    expect(r2.watermark).toBe(2);
    expect(persisted).toEqual([1, 2]);
    expect(await isInVm(store, 'urn:fact:1', 'Bananas are berries')).toBe(true);
  });

  it('dual-writes a same-graph reconcile to the root label graph when keepRootCopyOnLabel is persisted', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);

    // A plain same-graph publish (no subGraphName) that persisted the durable
    // `keepRootCopyOnLabel=true` signal into SWM workspace meta. The reconcile
    // sweep recovers that signal and mirrors the gossip path's dual-write —
    // landing the quad in BOTH the per-cgId VM graph and the root
    // `did:dkg:context-graph:<cg>` label graph so label-scoped
    // (`agent.query(label)`) reads resolve on a node that only ever recovered
    // via chain reconcile.
    const value = 'A bolt of lightning is hotter than the sun';
    const root = await seedSwmSnapshot(store, 'urn:fact:dw', value);
    await seedKeepRootSignal(store, 'urn:fact:dw', true);
    chain.__registerKC({ kaId: 301n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(root), chunks: [] });

    const persisted: number[] = [];
    const deps = makeDeps(store, chain, fh, persisted);
    const cursor = createCursorState(0);

    const res = await reconcileContextGraph(deps, cursor, LOCAL_CG, ON_CHAIN_CG);

    expect(res.reconciled).toBe(1);
    expect(await isInVm(store, 'urn:fact:dw', value)).toBe(true);
    expect(await isInRootLabel(store, 'urn:fact:dw', value)).toBe(true);
  });

  it('recovers a typed boolean keepRootCopyOnLabel literal and dual-writes', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);

    const value = 'Honey never spoils';
    const root = await seedSwmSnapshot(store, 'urn:fact:dwtyped', value);
    await seedKeepRootSignal(store, 'urn:fact:dwtyped', true, 'typed');
    chain.__registerKC({ kaId: 303n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(root), chunks: [] });

    const persisted: number[] = [];
    const deps = makeDeps(store, chain, fh, persisted);
    const cursor = createCursorState(0);

    const res = await reconcileContextGraph(deps, cursor, LOCAL_CG, ON_CHAIN_CG);

    expect(res.reconciled).toBe(1);
    expect(await isInVm(store, 'urn:fact:dwtyped', value)).toBe(true);
    expect(await isInRootLabel(store, 'urn:fact:dwtyped', value)).toBe(true);
  });

  it('does NOT dual-write to the root label graph when no keep-root signal is persisted', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const fh = new FinalizationHandler(store, chain);

    // Same shape as above but WITHOUT the persisted signal (legacy publish /
    // remap). The reconcile path must stay per-cgId only — never re-add a root
    // copy a remap deliberately dropped — so the VM graph holds the KA while
    // the root label graph does not.
    const value = 'Octopuses have three hearts';
    const root = await seedSwmSnapshot(store, 'urn:fact:nodw', value);
    chain.__registerKC({ kaId: 302n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(root), chunks: [] });

    const persisted: number[] = [];
    const deps = makeDeps(store, chain, fh, persisted);
    const cursor = createCursorState(0);

    const res = await reconcileContextGraph(deps, cursor, LOCAL_CG, ON_CHAIN_CG);

    expect(res.reconciled).toBe(1);
    expect(await isInVm(store, 'urn:fact:nodw', value)).toBe(true);
    expect(await isInRootLabel(store, 'urn:fact:nodw', value)).toBe(false);
  });
});
