/**
 * RS-heal — runs through the PRODUCTION store decorator stack.
 *
 * Regression for the review finding: `healStrandedScopedKCs` bails unless
 * `this.store.update` is a function, but the agent's store is NOT a bare
 * adapter. `createTripleStore` wraps it in `SharedMemoryLiteralBlobStore` /
 * `GraphSetIndexStore`, and `DKGAgent.create` wraps THAT in
 * `createListContextGraphsCacheInvalidatingStore`. If any layer fails to
 * forward the (optional) `update` method, `this.store.update` is `undefined`
 * in every normal daemon config → the guard silently returns → the heal never
 * runs and RS stays stuck. The bare-adapter gate tests cannot see this.
 *
 * This builds the store the way production does (factory + agent wrapper) and
 * proves: (1) `update` propagates to the top of the stack; (2) the heal
 * actually RELOCATES through it (byte-exact root equality — if `update` were
 * dropped the guard would no-op and scoped would stay empty); (3) the wrapper's
 * cache-invalidation + the GraphSetIndex refresh fire so the new scoped graph
 * is enumerable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTripleStore, type TripleStore, type Quad } from '@origintrail-official/dkg-storage';
import { V10MerkleTree, contextGraphDataUri, contextGraphMetaUri, contextGraphLayerUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { extractV10KCFromStore } from '@origintrail-official/dkg-random-sampling';
import { writeMaterializedVersion } from '@origintrail-official/dkg-publisher';
import { SwmHostModeMethods } from '../src/dkg-agent-swm-host.js';
import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';

const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const ONTOLOGY_GRAPH = 'did:dkg:context-graph:ontology';
const CONTEXT_GRAPH_ON_CHAIN_ID = 'https://dkg.network/ontology#ContextGraphOnChainId';

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
    { subject: `${ual}/1`, predicate: `${DKG}partOf`, object: ual, graph: metaGraph },
    { subject: `${ual}/1`, predicate: `${DKG}rootEntity`, object: ROOT, graph: metaGraph },
  ];
}

describe('healStrandedScopedKCs — through the production store decorator stack', () => {
  let store: TripleStore;
  let invalidateCount: number;

  const TEST_CG = 'stranded-cg';
  const TEST_ONCHAIN = '7';
  const TEST_UAL = 'did:dkg:hardhat:31337/0xpub/42';
  const CTRL_CG = 'control-cg';
  const CTRL_ONCHAIN = '8';
  const CTRL_UAL = 'did:dkg:hardhat:31337/0xctrl/42';

  beforeEach(async () => {
    invalidateCount = 0;
    // Production wrapping: createTripleStore (→ GraphSetIndexStore) then the
    // agent's listContextGraphs cache-invalidating wrapper (DKGAgent.create).
    const inner = await createTripleStore({ backend: 'oxigraph', graphSetIndex: true });
    store = createListContextGraphsCacheInvalidatingStore(
      inner,
      () => { invalidateCount += 1; },
      () => undefined,
    );

    const seedOntology = (cg: string, onChainId: string): Promise<void> => store.insert([{
      subject: `did:dkg:context-graph:${cg}`, predicate: CONTEXT_GRAPH_ON_CHAIN_ID,
      object: `"${onChainId}"`, graph: ONTOLOGY_GRAPH,
    }]);

    await seedOntology(CTRL_CG, CTRL_ONCHAIN);
    await store.insert([
      ...metaQuads(CTRL_UAL, contextGraphMetaUri(CTRL_CG, CTRL_ONCHAIN)),
      ...publicTriples().map((t) => ({ ...t, graph: contextGraphDataUri(CTRL_CG, CTRL_ONCHAIN) })),
    ]);

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

  it('exposes update() at the top of the decorator stack (capability propagation)', () => {
    expect(typeof store.update).toBe('function');
  });

  it('relocates the stranded KC through the full stack (heal does NOT silently no-op)', async () => {
    const ctrl = await extractV10KCFromStore(store, BigInt(CTRL_ONCHAIN), KA_ID);
    const expectedRoot = new V10MerkleTree(ctrl.leaves).root;
    await expect(extractV10KCFromStore(store, BigInt(TEST_ONCHAIN), KA_ID)).rejects.toBeTruthy();

    // Seed the GraphSetIndex BEFORE the heal so we can prove the update-path
    // refresh registers the newly-created scoped graph (not just a lazy scan).
    const graphsBefore = await store.listGraphs();
    expect(graphsBefore).not.toContain(contextGraphMetaUri(TEST_CG, TEST_ONCHAIN));
    const invalidatesBefore = invalidateCount;

    await runHeal(TEST_CG, TEST_ONCHAIN);

    // (1) byte-exact relocation through the stack — if update() were dropped by
    // any layer, the heal's guard would no-op and this would reject/empty.
    const healed = await extractV10KCFromStore(store, BigInt(TEST_ONCHAIN), KA_ID);
    expect(new V10MerkleTree(healed.leaves).root).toEqual(expectedRoot);

    // (2) the cache-invalidating wrapper's update() ran (graph-creating mutation).
    expect(invalidateCount).toBeGreaterThan(invalidatesBefore);

    // (3) GraphSetIndexStore.update() refreshed the index — the new scoped
    //     graph is now enumerable.
    const graphsAfter = await store.listGraphs();
    expect(graphsAfter).toContain(contextGraphMetaUri(TEST_CG, TEST_ONCHAIN));
    expect(graphsAfter).toContain(contextGraphDataUri(TEST_CG, TEST_ONCHAIN));

    // copies, never moves.
    const legacyStill = await store.query(
      `ASK { GRAPH <${contextGraphMetaUri(TEST_CG)}> { <${TEST_UAL}> <${DKG}batchId> "${KA_ID}"^^<${XSD}integer> } }`,
    );
    expect(legacyStill.type === 'boolean' && legacyStill.value).toBe(true);
  });

  it('(#1549) RS-heal INSERTs declare touchedGraphs through the decorator stack', async () => {
    // Guard the #1549 warm-index behaviour at the call site: a regression reverting
    // either INSERT to a plain `store.update(sparql)` would still relocate the KC
    // (the graphsAfter/merkle assertions above stay green) but would re-dirty the
    // graph-set index and force a full rebuild scan. Capture the update() options the
    // heal sends through the top of the production stack and assert each INSERT
    // declares its scoped target graph + source tag.
    const updateCalls: Array<{ sparql: string; options?: { source?: string; touchedGraphs?: readonly string[] } }> = [];
    const capturing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'update') {
          const orig = Reflect.get(target, prop, receiver) as NonNullable<TripleStore['update']>;
          return (sparql: string, options?: { source?: string; touchedGraphs?: readonly string[] }) => {
            updateCalls.push({ sparql, options });
            return orig.call(target, sparql, options);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as TripleStore;

    await SwmHostModeMethods.prototype.healStrandedScopedKCs.call(
      { store: capturing, log: { info: () => undefined, warn: () => undefined, error: () => undefined } } as never,
      TEST_CG,
      { subscribed: true, synced: true, onChainId: TEST_ONCHAIN } as never,
    );

    const scopedData = contextGraphDataUri(TEST_CG, TEST_ONCHAIN);
    const scopedMeta = contextGraphMetaUri(TEST_CG, TEST_ONCHAIN);
    const dataInsert = updateCalls.find((c) => /INSERT/i.test(c.sparql) && c.sparql.includes(scopedData));
    const metaInsert = updateCalls.find((c) => /INSERT/i.test(c.sparql) && c.sparql.includes(scopedMeta));
    expect(dataInsert?.options).toMatchObject({ source: 'agent.swm.rsHeal.materialize', touchedGraphs: [scopedData] });
    expect(metaInsert?.options).toMatchObject({ source: 'agent.swm.rsHeal.materialize', touchedGraphs: [scopedMeta] });
  });

  it('relocates a VM-graph-only one-shot strand through the full stack (read-both)', async () => {
    // The publisher's own one-shot publish() lands public data in the per-KA VM
    // graph, not legacy root data. The read-both heal must recover it through the
    // full production decorator stack (the UNION-in-UPDATE forwarded by every layer).
    const VM_CG = 'vmstrand-cg';
    const VM_ONCHAIN = '17';
    const VM_UAL = 'did:dkg:hardhat:31337/0xvm/42';
    await store.insert([{
      subject: `did:dkg:context-graph:${VM_CG}`, predicate: CONTEXT_GRAPH_ON_CHAIN_ID,
      object: `"${VM_ONCHAIN}"`, graph: ONTOLOGY_GRAPH,
    }]);
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
