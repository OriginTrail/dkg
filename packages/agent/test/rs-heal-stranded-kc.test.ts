/**
 * RS-heal content-binding GATE.
 *
 * The bug: a KC finalized BEFORE its on-chain cgId is locally resolvable lands
 * in the LEGACY label graphs (`<cg>/_meta` + `<cg>` root data) instead of the
 * SCOPED `<cg>/context/<onChainId>/_meta` + `.../context/<onChainId>` graphs the
 * Random Sampling prover (`extractV10KCFromStore`) reads — so it reports
 * `kc-not-synced` forever even though the node holds it.
 *
 * `healStrandedScopedKCs` RELOCATES (copies, never moves/deletes) such stranded
 * KCs legacy→scoped. The ABSOLUTE rule: the copy must be a server-side
 * `store.update(INSERT…WHERE)` so terms never leave the store. A
 * `query()`/CONSTRUCT → `insert(quads)` round-trip doubles backslashes in
 * escape-bearing literals and changes the leaf bytes the on-chain
 * `challengeRoot` was committed over — making the proof permanently unprovable.
 *
 * THE LOAD-BEARING ASSERTION (Approach B): a CONTROL CG is seeded by a single
 * direct `store.insert` of the SAME raw triples DIRECTLY into its SCOPED graphs.
 * `expected = extract(control).leaves → V10MerkleTree.root`. After the heal,
 * `actual = extract(test).leaves → V10MerkleTree.root`. Both flow through the
 * identical `extractV10KCFromStore` recipe, so oxigraph's literal-normalization
 * cancels and the test isolates COPY FIDELITY. Root equality is what proves
 * byte-stability survived the relocation — NOT merely "the batchId edge exists".
 *
 * The seed includes an escape-bearing literal (raw backslash + raw newline); an
 * ASCII-only seed false-passes this gate. We assert (via STRLEN) that the stored
 * value really is a single-byte newline + single backslash, and a NEGATIVE
 * CONTROL (escapes-stripped object) must produce a DIFFERENT V10 root — proving
 * the root is byte-sensitive and the equality check isn't trivially always-true.
 *
 * NOTE on the RED-flip: on the embedded OxigraphStore the forbidden
 * `query()`/CONSTRUCT → `insert(quads)` round-trip is LOSSLESS (its insert
 * decodes N-Triples escapes symmetrically with `termToString`'s re-encode), so
 * flipping the heal to that path does NOT corrupt and the gate stays green. The
 * `store.update(INSERT…WHERE)` mandate is correctness-by-construction here and a
 * hard requirement on NON-symmetric backends (e.g. sparql-http). The negative
 * control below is the honest substitute that proves byte-sensitivity.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  V10MerkleTree,
  contextGraphDataUri,
  contextGraphMetaUri,
  contextGraphLayerUri,
  MemoryLayer,
} from '@origintrail-official/dkg-core';
import { extractV10KCFromStore } from '@origintrail-official/dkg-random-sampling';
import { writeMaterializedVersion, readMaterializedVersion } from '@origintrail-official/dkg-publisher';
import { SwmHostModeMethods } from '../src/dkg-agent-swm-host.js';

const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const ONTOLOGY_GRAPH = 'did:dkg:context-graph:ontology';
const CONTEXT_GRAPH_ON_CHAIN_ID = 'https://dkg.network/ontology#ContextGraphOnChainId';

// CRITICAL: an escape-bearing literal — value carries BOTH a raw backslash and
// a raw newline. This is the byte-pattern a lossy query→insert(quads)
// round-trip corrupts (double-backslash). An ASCII-only seed would false-pass.
const ESCAPE_BEARING_VALUE = 'line1\nline2\\x';
const ROOT = 'urn:entity:strand-root';
const GENID = `${ROOT}/.well-known/genid/blank-1`;
const KA_ID = 42n;

/** Public data triples of the stranded KC. One object carries the escape literal. */
function publicTriples(): { subject: string; predicate: string; object: string }[] {
  return [
    { subject: ROOT, predicate: 'urn:p:name', object: '"strand"' },
    // escape-bearing object — N-Triples-escaped on the wire (raw \n -> \\n, raw \ -> \\\\).
    { subject: ROOT, predicate: 'urn:p:payload', object: `"${ESCAPE_BEARING_VALUE.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}"` },
    { subject: ROOT, predicate: 'urn:p:has', object: GENID },
    { subject: GENID, predicate: 'urn:p:value', object: '"42"' },
  ];
}

/** Meta rows for a KC (UAL + token row carrying rootEntity), graph-parameterised. */
function metaQuads(ual: string, metaGraph: string): Quad[] {
  return [
    { subject: ual, predicate: `${RDF}type`, object: `${DKG}KnowledgeCollection`, graph: metaGraph },
    { subject: ual, predicate: `${DKG}batchId`, object: `"${KA_ID}"^^<${XSD}integer>`, graph: metaGraph },
    { subject: `${ual}/1`, predicate: `${RDF}type`, object: `${DKG}KnowledgeAsset`, graph: metaGraph },
    { subject: `${ual}/1`, predicate: `${DKG}partOf`, object: ual, graph: metaGraph },
    { subject: `${ual}/1`, predicate: `${DKG}rootEntity`, object: ROOT, graph: metaGraph },
  ];
}

async function seedOntology(store: OxigraphStore, localCgId: string, onChainId: string): Promise<void> {
  await store.insert([
    {
      subject: `did:dkg:context-graph:${localCgId}`,
      predicate: CONTEXT_GRAPH_ON_CHAIN_ID,
      object: `"${onChainId}"`,
      graph: ONTOLOGY_GRAPH,
    },
  ]);
}

/** Minimal `this` for the heal — only what the method body touches. */
function makeAgentLike(store: OxigraphStore): unknown {
  return {
    store,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };
}

async function runHeal(store: OxigraphStore, localCgId: string, onChainId: string): Promise<void> {
  await SwmHostModeMethods.prototype.healStrandedScopedKCs.call(
    makeAgentLike(store) as never,
    localCgId,
    { subscribed: true, synced: true, onChainId } as never,
  );
}

async function scopedTripleCount(store: OxigraphStore, localCgId: string, onChainId: string): Promise<number> {
  const dataG = contextGraphDataUri(localCgId, onChainId);
  const metaG = contextGraphMetaUri(localCgId, onChainId);
  const res = await store.query(
    `SELECT (COUNT(*) AS ?c) WHERE {
       { GRAPH <${dataG}> { ?s ?p ?o } } UNION { GRAPH <${metaG}> { ?s ?p ?o } }
     }`,
  );
  if (res.type !== 'bindings') return 0;
  const raw = res.bindings[0]?.['c'] ?? '0';
  const m = /^"?(\d+)/.exec(raw);
  return m ? Number(m[1]) : 0;
}

describe('healStrandedScopedKCs — content-binding gate', () => {
  let store: OxigraphStore;

  const TEST_CG = 'stranded-cg';
  const TEST_ONCHAIN = '7';
  const TEST_UAL = 'did:dkg:hardhat:31337/0xpub/42';

  const CTRL_CG = 'control-cg';
  const CTRL_ONCHAIN = '8';
  const CTRL_UAL = 'did:dkg:hardhat:31337/0xctrl/42';

  beforeEach(async () => {
    store = new OxigraphStore();

    // ── CONTROL CG: same raw triples inserted DIRECTLY into the SCOPED graphs
    //    (single store.insert, never a copy — independence is load-bearing).
    await seedOntology(store, CTRL_CG, CTRL_ONCHAIN);
    const ctrlScopedMeta = contextGraphMetaUri(CTRL_CG, CTRL_ONCHAIN);
    const ctrlScopedData = contextGraphDataUri(CTRL_CG, CTRL_ONCHAIN);
    await store.insert([
      ...metaQuads(CTRL_UAL, ctrlScopedMeta),
      ...publicTriples().map((t) => ({ ...t, graph: ctrlScopedData })),
    ]);

    // ── TEST CG: stranded in the LEGACY label graphs; SCOPED graphs EMPTY.
    await seedOntology(store, TEST_CG, TEST_ONCHAIN);
    const legacyMeta = contextGraphMetaUri(TEST_CG);
    const legacyData = contextGraphDataUri(TEST_CG);
    await store.insert([
      ...metaQuads(TEST_UAL, legacyMeta),
      ...publicTriples().map((t) => ({ ...t, graph: legacyData })),
    ]);
    // A receiver-finalized KC carries a materialized version stamp in legacy
    // meta; the heal preserves it when present. (A publisher's OWN one-shot
    // publish has NO stamp — see the no-stamp test below, which the heal now
    // relocates with a synthesized {0,0} floor version.)
    await writeMaterializedVersion(store, legacyMeta, TEST_UAL, { blockNumber: 100, txIndex: 0 });
  });

  it('relocates a stranded legacy KC into scoped graphs with byte-stable leaves (ROOT EQUALITY)', async () => {
    // Pre-record the challengeRoot from the SAME triples, before the legacy→scoped
    // copy — via the control CG, which holds them directly in its scoped graphs.
    const ctrl = await extractV10KCFromStore(store, BigInt(CTRL_ONCHAIN), KA_ID);
    const expectedRoot = new V10MerkleTree(ctrl.leaves).root;

    // Before the heal the prover cannot find the stranded KC (scoped is empty).
    await expect(extractV10KCFromStore(store, BigInt(TEST_ONCHAIN), KA_ID)).rejects.toBeTruthy();

    await runHeal(store, TEST_CG, TEST_ONCHAIN);

    // THE LOAD-BEARING ASSERTION: recomputed leaf-root over the now-populated
    // scoped graphs EQUALS the pre-recorded challengeRoot. Root equality (not
    // "the edge exists") is what proves byte-stability survived the copy.
    const healed = await extractV10KCFromStore(store, BigInt(TEST_ONCHAIN), KA_ID);
    const actualRoot = new V10MerkleTree(healed.leaves).root;
    expect(actualRoot).toEqual(expectedRoot);

    // Sanity: the escape-bearing literal survived intact (no double-backslash).
    const payload = healed.triples.find((t) => t.predicate === 'urn:p:payload');
    expect(payload).toBeTruthy();
    // The extracted object is the N-Triples-escaped form of the original value.
    expect(payload!.object).toContain('\\n');
    expect(payload!.object).not.toContain('\\\\n'); // a corrupt copy would over-escape

    // Prove the seed is GENUINELY escape-bearing: the stored value in the SCOPED
    // data graph is a single-byte newline + single backslash (STRLEN == raw
    // length 13). A double-escaped corrupt copy would report a larger length.
    const scopedData = contextGraphDataUri(TEST_CG, TEST_ONCHAIN);
    const lenRes = await store.query(
      `SELECT (STRLEN(?o) AS ?len) WHERE {
         GRAPH <${scopedData}> { <${ROOT}> <urn:p:payload> ?o }
       }`,
    );
    expect(lenRes.type).toBe('bindings');
    const lenStr = lenRes.type === 'bindings' ? (lenRes.bindings[0]?.['len'] ?? '') : '';
    expect(/^"?(\d+)/.exec(lenStr)?.[1]).toBe(String(ESCAPE_BEARING_VALUE.length)); // 13

    // (i) the scoped /_meta now has the dkg:batchId edge.
    const scopedMeta = contextGraphMetaUri(TEST_CG, TEST_ONCHAIN);
    const batchEdge = await store.query(
      `ASK { GRAPH <${scopedMeta}> { <${TEST_UAL}> <${DKG}batchId> "${KA_ID}"^^<${XSD}integer> } }`,
    );
    expect(batchEdge.type === 'boolean' && batchEdge.value).toBe(true);

    // (ii) the heal COPIES, never moves/deletes — the label graph still resolves it.
    const legacyMeta = contextGraphMetaUri(TEST_CG);
    const legacyStill = await store.query(
      `ASK { GRAPH <${legacyMeta}> { <${TEST_UAL}> <${DKG}batchId> "${KA_ID}"^^<${XSD}integer> } }`,
    );
    expect(legacyStill.type === 'boolean' && legacyStill.value).toBe(true);
  });

  it('repairs a stranded KC inside the admitted current-watermark reconcile path', async () => {
    await expect(extractV10KCFromStore(store, BigInt(TEST_ONCHAIN), KA_ID)).rejects.toBeTruthy();

    const priorities: string[] = [];
    const ordinalAttempts: number[] = [];
    const agentLike = makeAgentLike(store) as any;
    agentLike.subscribedContextGraphs = new Map([[
      TEST_CG,
      {
        subscribed: true,
        synced: true,
        onChainId: TEST_ONCHAIN,
        lastReconciledOrdinal: 0,
      },
    ]]);
    agentLike.reconcileCursors = new Map();
    agentLike.vmReconcileDispatcher = {
      dispatch: async <T>(_key: string, source: string): Promise<T> => {
        priorities.push(source === 'periodic' ? 'background' : 'foreground');
        return SwmHostModeMethods.prototype.executeVmReconcileForCg.call(
          agentLike,
          TEST_CG,
          source,
        ) as Promise<T>;
      },
    };
    agentLike.vmReconcileEnabled = () => true;
    agentLike.chain = { getContextGraphKCCount: async () => 0n };
    agentLike.ensureVmReconcileDispatcher = SwmHostModeMethods.prototype.ensureVmReconcileDispatcher;
    agentLike.resolveVmReconcileTarget = SwmHostModeMethods.prototype.resolveVmReconcileTarget;
    agentLike.createVmReconcileDeps = SwmHostModeMethods.prototype.createVmReconcileDeps;
    agentLike.toContextGraphReconcileResult = SwmHostModeMethods.prototype.toContextGraphReconcileResult;
    agentLike.emitVmReconcileTelemetry = SwmHostModeMethods.prototype.emitVmReconcileTelemetry;
    agentLike.healStrandedScopedKCs = SwmHostModeMethods.prototype.healStrandedScopedKCs;
    agentLike.reconcileChainOrdinal = async (_lcg: string, _ocg: bigint, ordinal: number) => {
      ordinalAttempts.push(ordinal);
      throw new Error('current watermark must not enter ordinal reconciliation');
    };
    agentLike.persistContextGraphSubscription = () => {
      throw new Error('current watermark must not be persisted again');
    };
    agentLike.emitReplication = () => {
      throw new Error('current watermark must not emit reconcile progress');
    };

    const result = await SwmHostModeMethods.prototype.runVmReconcileForCg.call(
      agentLike,
      TEST_CG,
      'manual',
    );

    expect(result).toMatchObject({
      status: 'current',
      attempted: false,
      headOrdinal: 0,
      watermarkBefore: 0,
      watermarkAfter: 0,
    });
    expect(priorities).toEqual(['foreground']);
    expect(ordinalAttempts).toEqual([]);

    const ctrl = await extractV10KCFromStore(store, BigInt(CTRL_ONCHAIN), KA_ID);
    const healed = await extractV10KCFromStore(store, BigInt(TEST_ONCHAIN), KA_ID);
    expect(new V10MerkleTree(healed.leaves).root).toEqual(new V10MerkleTree(ctrl.leaves).root);
  });

  it('is a version-equal no-op on a second run (no duplication / no throw)', async () => {
    await runHeal(store, TEST_CG, TEST_ONCHAIN);
    const countAfterFirst = await scopedTripleCount(store, TEST_CG, TEST_ONCHAIN);
    expect(countAfterFirst).toBeGreaterThan(0);

    // Second run: the ASK-guard short-circuits (scoped now has batchId), so the
    // scoped triple count is UNCHANGED — no re-copy, no duplication, no throw.
    await runHeal(store, TEST_CG, TEST_ONCHAIN);
    const countAfterSecond = await scopedTripleCount(store, TEST_CG, TEST_ONCHAIN);
    expect(countAfterSecond).toBe(countAfterFirst);

    // And the prover still extracts a stable root.
    const ctrl = await extractV10KCFromStore(store, BigInt(CTRL_ONCHAIN), KA_ID);
    const healed = await extractV10KCFromStore(store, BigInt(TEST_ONCHAIN), KA_ID);
    expect(new V10MerkleTree(healed.leaves).root).toEqual(new V10MerkleTree(ctrl.leaves).root);
  });

  it('relocates a stranded KC that has NO materializedVersion stamp (publisher own-KC strand)', async () => {
    // The publisher's OWN one-shot publish writes the KC into legacy `_meta`
    // WITHOUT a materializedVersion stamp (only the receiver/finalization path
    // stamps one). Such a KC must STILL be relocated, otherwise it strands in
    // legacy forever (kc-not-synced) — chain-reconcile skips it (legacy
    // status=confirmed) and, pre-fix, so did the heal.
    const NS_CG = 'nostamp-cg';
    const NS_ONCHAIN = '13';
    const NS_UAL = 'did:dkg:hardhat:31337/0xnostamp/42';
    await seedOntology(store, NS_CG, NS_ONCHAIN);
    const nsLegacyMeta = contextGraphMetaUri(NS_CG);
    await store.insert([
      ...metaQuads(NS_UAL, nsLegacyMeta),
      ...publicTriples().map((t) => ({ ...t, graph: contextGraphDataUri(NS_CG) })),
    ]);
    // Deliberately NO writeMaterializedVersion — the publisher-own-KC case.
    expect(await readMaterializedVersion(store, nsLegacyMeta, NS_UAL)).toBeNull();

    // Before the heal the prover cannot find it (scoped empty).
    await expect(extractV10KCFromStore(store, BigInt(NS_ONCHAIN), KA_ID)).rejects.toBeTruthy();

    await runHeal(store, NS_CG, NS_ONCHAIN);

    // Relocated byte-stably: recomputed scoped root equals the control root.
    const ctrl = await extractV10KCFromStore(store, BigInt(CTRL_ONCHAIN), KA_ID);
    const healed = await extractV10KCFromStore(store, BigInt(NS_ONCHAIN), KA_ID);
    expect(new V10MerkleTree(healed.leaves).root).toEqual(new V10MerkleTree(ctrl.leaves).root);

    // The heal stamped scoped with the {0,0} floor so any real update (block>0) wins.
    const nsScopedMeta = contextGraphMetaUri(NS_CG, NS_ONCHAIN);
    expect(await readMaterializedVersion(store, nsScopedMeta, NS_UAL)).toEqual({ blockNumber: 0, txIndex: 0 });

    // Idempotent: a second run is a no-op (ASK-guard short-circuits on the now-present batchId).
    const c1 = await scopedTripleCount(store, NS_CG, NS_ONCHAIN);
    await runHeal(store, NS_CG, NS_ONCHAIN);
    expect(await scopedTripleCount(store, NS_CG, NS_ONCHAIN)).toBe(c1);
  });

  it('relocates a publisher one-shot strand whose public data is in the VM graph only (read-both)', async () => {
    // The publisher's OWN one-shot publish() writes confirmed PUBLIC data to the
    // per-KA verifiable-memory graph `<cg>/_verifiable_memory/<author>/<number>`,
    // NOT the legacy root data graph (the receiver/#1259 strand fills root data).
    // If scoped promotion fails, the heal is the stated backstop — but a
    // root-data-only data read finds nothing here and bails at the crash-partial
    // guard, leaving the KC invisible to RS forever. The heal now reads
    // root data UNION the per-KA VM graph, so this strand is recovered too.
    const VM_CG = 'vmstrand-cg';
    const VM_ONCHAIN = '17';
    const VM_UAL = 'did:dkg:hardhat:31337/0xvm/42';
    await seedOntology(store, VM_CG, VM_ONCHAIN);
    // Legacy META present (strand detected + root resolvable) ...
    await store.insert(metaQuads(VM_UAL, contextGraphMetaUri(VM_CG)));
    // ... but the public DATA lives ONLY in the per-KA VM graph (derived from the
    // packed kaId exactly as the publisher does), NOT the legacy root data graph.
    const vmNumber = KA_ID & ((1n << 96n) - 1n);
    const vmAuthor = '0x' + (KA_ID >> 96n).toString(16).padStart(40, '0');
    const vmGraph = contextGraphLayerUri(VM_CG, MemoryLayer.VerifiableMemory, vmAuthor, vmNumber);
    await store.insert([
      ...publicTriples().map((t) => ({ ...t, graph: vmGraph })),
      // Production VM graphs carry a post-confirmation SelfAttested trust stamp
      // (dkg-publisher.ts). The heal's VM-branch trust-predicate exclusion must
      // drop it so the recomputed leaf set stays byte-identical with the chain root.
      { subject: ROOT, predicate: `${DKG}trustLevel`, object: '"SelfAttested"', graph: vmGraph },
    ]);
    // Publisher own-KC strand carries NO materializedVersion stamp.

    // Precondition: scoped empty AND legacy root data genuinely empty — the
    // exact state where a root-data-only heal would bail and write nothing.
    await expect(extractV10KCFromStore(store, BigInt(VM_ONCHAIN), KA_ID)).rejects.toBeTruthy();
    const rootEmpty = await store.query(`ASK { GRAPH <${contextGraphDataUri(VM_CG)}> { ?s ?p ?o } }`);
    expect(rootEmpty.type === 'boolean' && rootEmpty.value).toBe(false);

    await runHeal(store, VM_CG, VM_ONCHAIN);

    // Relocated byte-stably FROM THE VM GRAPH: recomputed scoped leaf-root equals
    // the control root (same leaves, independent direct-to-scoped seed).
    const ctrl = await extractV10KCFromStore(store, BigInt(CTRL_ONCHAIN), KA_ID);
    const healed = await extractV10KCFromStore(store, BigInt(VM_ONCHAIN), KA_ID);
    expect(new V10MerkleTree(healed.leaves).root).toEqual(new V10MerkleTree(ctrl.leaves).root);

    // The VM-branch trust-predicate exclusion dropped the SelfAttested stamp from
    // the scoped copy (root equality above already implies it; assert explicitly).
    const vmScopedData = contextGraphDataUri(VM_CG, VM_ONCHAIN);
    const stampLeak = await store.query(`ASK { GRAPH <${vmScopedData}> { ?s <${DKG}trustLevel> ?o } }`);
    expect(stampLeak.type === 'boolean' && stampLeak.value).toBe(false);
  });

  it('VM read is bound to the stranded KC kaId — never copies a different KA sharing the root IRI', async () => {
    // Two KAs in the same CG can share a root entity IRI (e.g. an entity
    // republished under a new kaId). The stranded KC is kaId 42; a DIFFERENT
    // kaId 99 also holds a VM graph carrying the SAME root with a different value.
    // The heal must copy ONLY kaId 42's VM graph (derived from its batchId) — a
    // prefix scan would mix in kaId 99's triples and make RS prove a wrong leaf set.
    const C_CG = 'vm-contamination-cg';
    const C_ONCHAIN = '19';
    const C_UAL = 'did:dkg:hardhat:31337/0xvmc/42';
    const OTHER_KA_ID = 99n;
    const vmOf = (kaId: bigint): string => contextGraphLayerUri(
      C_CG, MemoryLayer.VerifiableMemory,
      '0x' + (kaId >> 96n).toString(16).padStart(40, '0'),
      kaId & ((1n << 96n) - 1n),
    );
    await seedOntology(store, C_CG, C_ONCHAIN);
    await store.insert(metaQuads(C_UAL, contextGraphMetaUri(C_CG))); // batchId == KA_ID (42) in legacy meta
    // kaId 42 (the stranded KC) — the value RS must prove.
    await store.insert([{ subject: ROOT, predicate: 'urn:p:name', object: '"value-A"', graph: vmOf(KA_ID) }]);
    // kaId 99 — a DIFFERENT KA sharing the same root IRI, different value.
    await store.insert([{ subject: ROOT, predicate: 'urn:p:name', object: '"value-B"', graph: vmOf(OTHER_KA_ID) }]);

    await runHeal(store, C_CG, C_ONCHAIN);

    // The scoped copy must contain ONLY kaId 42's value, never kaId 99's.
    const scopedData = contextGraphDataUri(C_CG, C_ONCHAIN);
    const got = await store.query(`SELECT ?o WHERE { GRAPH <${scopedData}> { <${ROOT}> <urn:p:name> ?o } }`);
    const values = got.type === 'bindings' ? got.bindings.map((b) => b['o'] ?? '') : [];
    expect(values.some((v) => v.includes('value-A')), 'must copy the stranded kaId 42 VM data').toBe(true);
    expect(values.some((v) => v.includes('value-B')), 'must NOT copy a different kaId sharing the root').toBe(false);
  });

  it('writes NOTHING when the legacy root data is absent (crash-partial guard)', async () => {
    // Re-seed a CG whose LEGACY META resolves a root but whose LEGACY ROOT DATA
    // has NO triples under that root — a Factor-B sync gap, NOT a relocation.
    const GAP_CG = 'gap-cg';
    const GAP_ONCHAIN = '9';
    const GAP_UAL = 'did:dkg:hardhat:31337/0xgap/42';
    await seedOntology(store, GAP_CG, GAP_ONCHAIN);
    const gapLegacyMeta = contextGraphMetaUri(GAP_CG);
    await store.insert(metaQuads(GAP_UAL, gapLegacyMeta));
    await writeMaterializedVersion(store, gapLegacyMeta, GAP_UAL, { blockNumber: 100, txIndex: 0 });
    // NB: no legacy ROOT DATA seeded for ROOT.

    await runHeal(store, GAP_CG, GAP_ONCHAIN);

    // The crash-partial guard must trade NOTHING: scoped graphs stay empty so we
    // never turn kc-not-synced into KCDataMissingError.
    expect(await scopedTripleCount(store, GAP_CG, GAP_ONCHAIN)).toBe(0);
  });

  it('negative control: a byte-different escape literal yields a DIFFERENT root (root is byte-sensitive)', async () => {
    // Seed a SECOND control whose only difference is the escape-bearing object:
    // its escapes are STRIPPED (real newline removed). If the V10 root were NOT
    // byte-sensitive, this would still equal the escape-bearing root and the
    // load-bearing equality assertion would be vacuous. It must DIFFER.
    const NEG_CG = 'neg-control-cg';
    const NEG_ONCHAIN = '11';
    const NEG_UAL = 'did:dkg:hardhat:31337/0xneg/42';
    await seedOntology(store, NEG_CG, NEG_ONCHAIN);
    const negScopedMeta = contextGraphMetaUri(NEG_CG, NEG_ONCHAIN);
    const negScopedData = contextGraphDataUri(NEG_CG, NEG_ONCHAIN);
    const negTriples = publicTriples().map((t) =>
      t.predicate === 'urn:p:payload'
        ? { ...t, object: '"line1line2x"' } // escapes stripped — byte-different
        : t,
    );
    await store.insert([
      ...metaQuads(NEG_UAL, negScopedMeta),
      ...negTriples.map((t) => ({ ...t, graph: negScopedData })),
    ]);

    const ctrl = await extractV10KCFromStore(store, BigInt(CTRL_ONCHAIN), KA_ID);
    const neg = await extractV10KCFromStore(store, BigInt(NEG_ONCHAIN), KA_ID);
    expect(new V10MerkleTree(neg.leaves).root).not.toEqual(new V10MerkleTree(ctrl.leaves).root);
  });
});
