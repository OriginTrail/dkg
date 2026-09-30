import { describe, it, expect, vi } from 'vitest';
import * as storageIndex from '../src/index.js';
import {
  createTripleStore,
  loadSharedMemoryQuadsForScope,
  loadSelectedSharedMemoryQuads,
  loadSharedMemorySliceWithKaBoundFallback,
  loadMerkleVerifiedSharedMemorySlice,
  canonicalSharedMemoryScopeWriteGraph,
  resolveSharedMemoryScopeWriteGraph,
  resolveSharedMemoryScopeGraphs,
  resolveSharedMemoryReadGraphs,
  type Quad,
  type SwmKaGraphBound,
  SharedMemoryResultBudgetError,
  SharedMemoryReadConsistencyError,
} from '../src/index.js';
// The unsafe bounded primitives are deliberately NOT re-exported from `src/index.ts`
// (pruning is not part of the package's public surface — see the API-surface test at
// the bottom). Tests that exercise the graph-set behaviour reach into the module
// directly rather than widening that surface.
import {
  loadKaBoundedSharedMemoryQuads,
  resolveKaBoundedSharedMemoryReadGraphs,
} from '../src/graph-manager.js';
import { contextGraphSharedMemoryUri } from '@origintrail-official/dkg-core';

// The bound's `agentAddress` arrives LOWERCASE (it is unpacked from a packed
// kaId), but the URI segment written by the DKG path may be checksum-cased.
// Every fixture below writes the MIXED-case form into the graph URI and bounds
// on the lowercase form, so a case-sensitive address compare would wrongly drop
// the admitted graph and fail the test.
const AUTHOR_A_MIXED = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
const AUTHOR_A = AUTHOR_A_MIXED.toLowerCase();
const AUTHOR_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const key = (quad: Quad) => `${quad.subject}|${quad.predicate}|${quad.object}`;
const keys = (quads: Quad[]) => quads.map(key).sort();

async function seedGraphs(store: Awaited<ReturnType<typeof createTripleStore>>, graphs: string[]): Promise<void> {
  await store.insert(
    graphs.map((graph, i) => ({
      subject: `urn:seed:${i}`,
      predicate: 'urn:p',
      object: '"seed"',
      graph,
    })),
  );
}

describe('resolveSharedMemoryReadGraphs — SwmKaGraphBound (fail-open per-KA slice)', () => {
  it('T1: admits bucket + matching per-KA graph + non-parsing graph; excludes off-range, off-author, staging', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('bound-t1');
    const gAdmit = `${swm}/${AUTHOR_A_MIXED}/7`;
    const gRangeOut = `${swm}/${AUTHOR_A_MIXED}/12`;
    const gAuthorOut = `${swm}/${AUTHOR_B}/7`;
    const gNonLayer = `${swm}/not-a-layer`;
    const gStaging = `${swm}/staging/tmp`;
    try {
      await seedGraphs(store, [swm, gAdmit, gRangeOut, gAuthorOut, gNonLayer, gStaging]);

      const bound: SwmKaGraphBound = { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n };
      const resolved = await resolveKaBoundedSharedMemoryReadGraphs(store, swm, bound);

      // Kills: author-blind range (would admit gAuthorOut), range off-by-one
      // (would admit gRangeOut), fail-CLOSED parse (would drop gNonLayer), and a
      // dropped bucket seed. The packed-vs-low96 trap lives one layer up in
      // `deriveSwmKaGraphBound` (the bound arrives here already unpacked); it is
      // killed by T4 and by the bounded-only finalization case in
      // packages/agent/test/swm-slice-ka-bound.test.ts.
      expect(resolved.slice().sort()).toEqual([swm, gAdmit, gNonLayer].sort());
      expect(resolved).not.toContain(gRangeOut);
      expect(resolved).not.toContain(gAuthorOut);
      expect(resolved).not.toContain(gStaging);
    } finally {
      await store.close();
    }
  });

  it('T2: admits a 5-segment sub-graph per-KA URI', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('bound-t2', 'mysub');
    const gSub = `${swm}/${AUTHOR_A_MIXED}/7`;
    try {
      await seedGraphs(store, [swm, gSub]);

      const bound: SwmKaGraphBound = { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n };
      const resolved = await resolveKaBoundedSharedMemoryReadGraphs(store, swm, bound);

      expect(resolved).toContain(gSub);
      expect(resolved.slice().sort()).toEqual([swm, gSub].sort());
    } finally {
      await store.close();
    }
  });

  // The public resolver has no bound parameter at all: it is COMPLETE by construction
  // and therefore safe on the merkle-defining and ACK lanes. Pruning requires the
  // separately-named `resolveKaBoundedSharedMemoryReadGraphs`.
  it('T3: the public resolver is complete — every non-staging child, regardless of author or number', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('bound-t3');
    const gA = `${swm}/${AUTHOR_A_MIXED}/7`;
    const gB = `${swm}/${AUTHOR_B}/9`;
    try {
      await seedGraphs(store, [swm, gA, gB, `${swm}/staging/tmp`]);

      const resolved = await resolveSharedMemoryReadGraphs(store, swm);

      expect(resolved.slice().sort()).toEqual([swm, gA, gB].sort());
    } finally {
      await store.close();
    }
  });
});

describe('loadSelectedSharedMemoryQuads — bounded read equivalence', () => {
  it('T5a: a bounded root read returns a quad set key-identical to the unbounded read', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('bound-t5a');
    const r = 'urn:t5a:root';
    const c1 = `${r}/.well-known/genid/c1`;
    const c2 = `${r}/.well-known/genid/c2`;
    const c3 = `${r}/.well-known/genid/c3`;
    const other = 'urn:t5a:other';
    const gKa = `${swm}/${AUTHOR_A_MIXED}/7`;
    const gRangeOut = `${swm}/${AUTHOR_A_MIXED}/12`;
    const gAuthorOut = `${swm}/${AUTHOR_B}/7`;
    const gNonLayer = `${swm}/not-a-layer`;
    const gStaging = `${swm}/staging/tmp`;
    try {
      await store.insert([
        // All of root r's quads live in bucket ∪ gKa ∪ the fail-open non-layer
        // graph — the clean single-KA case the bound is meant to accelerate.
        { subject: r, predicate: 'urn:p', object: '"root-bucket"', graph: swm },
        { subject: c1, predicate: 'urn:p', object: '"child-bucket"', graph: swm },
        { subject: r, predicate: 'urn:p', object: '"root-ka"', graph: gKa },
        { subject: c2, predicate: 'urn:p', object: '"child-ka"', graph: gKa },
        { subject: c3, predicate: 'urn:p', object: '"child-nonlayer"', graph: gNonLayer },
        // Decoys the bound skips: off-range / off-author graphs holding only a
        // DIFFERENT root, so neither read attributes them to r (equivalence
        // holds) — yet a wrong bound that kept gKa out would lose r's quads.
        { subject: other, predicate: 'urn:p', object: '"decoy-range"', graph: gRangeOut },
        { subject: other, predicate: 'urn:p', object: '"decoy-author"', graph: gAuthorOut },
        // Staging is excluded by BOTH reads even though it carries an r quad.
        { subject: r, predicate: 'urn:p', object: '"staged"', graph: gStaging },
      ]);

      const bound: SwmKaGraphBound = { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n };
      const bounded = await loadKaBoundedSharedMemoryQuads(store, swm, { rootEntities: [r] }, bound);
      const unbounded = await loadSelectedSharedMemoryQuads(store, swm, { rootEntities: [r] });

      expect(keys(bounded)).toEqual(keys(unbounded));
      // Guard against the vacuous both-empty pass: the per-KA graph's quads must
      // actually be in the bounded slice.
      expect(keys(bounded)).toEqual(
        [
          `${r}|urn:p|"root-bucket"`,
          `${c1}|urn:p|"child-bucket"`,
          `${r}|urn:p|"root-ka"`,
          `${c2}|urn:p|"child-ka"`,
          `${c3}|urn:p|"child-nonlayer"`,
        ].sort(),
      );
      expect(keys(bounded)).not.toContain(`${r}|urn:p|"staged"`);
    } finally {
      await store.close();
    }
  });
});

describe('resolveSharedMemoryReadGraphs — bound only prunes real SWM children (T2b)', () => {
  // `parseContextGraphLayerUri` recognises every memory layer, so a child like
  // `<swm>/_verifiable_memory/{addr}/{n}` PARSES — as a 5-segment VM URI whose
  // subGraphName is `_shared_memory`. Gating exclusion on the raw parse would
  // prune it. Only a child that reconstructs to exactly this bucket may be cut.
  it('keeps layer-lookalike children of the bucket that are not per-KA SWM graphs', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('bound-t2b');
    const gAdmit = `${swm}/${AUTHOR_A_MIXED}/7`;
    // Parses as layer=VerifiableMemory, subGraphName='_shared_memory'. Its author
    // and number are BOTH out of the bound, so a raw-parse gate would drop it.
    const gVmLookalike = `${swm}/_verifiable_memory/${AUTHOR_B}/12`;
    const gWmLookalike = `${swm}/_working_memory/${AUTHOR_B}/12`;
    try {
      await seedGraphs(store, [swm, gAdmit, gVmLookalike, gWmLookalike]);

      const bound: SwmKaGraphBound = { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n };
      const resolved = await resolveKaBoundedSharedMemoryReadGraphs(store, swm, bound);

      expect(resolved.slice().sort()).toEqual([swm, gAdmit, gVmLookalike, gWmLookalike].sort());
    } finally {
      await store.close();
    }
  });

  // Isolates the bucket-RECONSTRUCT check specifically: `<swm>/_shared_memory/{addr}/{n}`
  // parses as a 5-segment SHARED-memory URI, so the layer check alone passes. Its
  // subGraphName is `_shared_memory`, so it reconstructs to `<cg>/_shared_memory/_shared_memory`
  // — a different bucket, not ours to prune, even though its author and number both
  // fall outside the bound.
  // A deeper descendant whose FIRST two segments look like `{addr}/{n}` must not be
  // pruned: it is not a per-KA child (it has a trailing segment). Requires an EXACT
  // two-segment match, not a >=2 prefix match.
  it('keeps a deeper descendant even when its leading segments resemble a per-KA child', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('bound-deep');
    const gAdmit = `${swm}/${AUTHOR_A_MIXED}/7`;
    // Leading `${AUTHOR_B}/12` would be out-of-bound if this parsed as a per-KA
    // child, but the trailing `/extra` means it is NOT one.
    const gDeep = `${swm}/${AUTHOR_B}/12/extra`;
    try {
      await seedGraphs(store, [swm, gAdmit, gDeep]);

      const bound: SwmKaGraphBound = { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n };
      const resolved = await resolveKaBoundedSharedMemoryReadGraphs(store, swm, bound);

      expect(resolved.slice().sort()).toEqual([swm, gAdmit, gDeep].sort());
    } finally {
      await store.close();
    }
  });

  it('keeps a shared-memory child that reconstructs to a DIFFERENT bucket', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('bound-t2b2');
    const gAdmit = `${swm}/${AUTHOR_A_MIXED}/7`;
    const gOtherBucketChild = `${swm}/_shared_memory/${AUTHOR_B}/12`;
    try {
      await seedGraphs(store, [swm, gAdmit, gOtherBucketChild]);

      const bound: SwmKaGraphBound = { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n };
      const resolved = await resolveKaBoundedSharedMemoryReadGraphs(store, swm, bound);

      expect(resolved.slice().sort()).toEqual([swm, gAdmit, gOtherBucketChild].sort());
    } finally {
      await store.close();
    }
  });
});

describe('the generic SWM loader cannot be pruned (bound is not an option)', () => {
  it('keeps deprecated replacement writes on an existing checksum alias without stale reads', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('named-exact-casing');
    const root = 'urn:test:named:root';
    const exact = `${swm}/${AUTHOR_A_MIXED}/7`;
    const sameAuthorSibling = `${swm}/${AUTHOR_A_MIXED}/8`;
    try {
      await store.insert([
        { subject: root, predicate: 'urn:p', object: '"bucket"', graph: swm },
        { subject: root, predicate: 'urn:p', object: '"exact"', graph: exact },
        { subject: root, predicate: 'urn:p', object: '"same-author-sibling"', graph: sameAuthorSibling },
      ]);

      const scope = {
        kind: 'named-lifecycle',
        identity: { agentAddress: AUTHOR_A, kaNumber: 7n },
      } as const;
      const quads = await loadSharedMemoryQuadsForScope(
        store,
        swm,
        { rootEntities: [root] },
        scope,
      );
      expect(quads.map((quad) => quad.object)).toEqual(['"exact"']);
      expect(canonicalSharedMemoryScopeWriteGraph(swm, scope)).toBe(
        `${swm}/${AUTHOR_A}/7`,
      );
      const replacementGraph = await resolveSharedMemoryScopeWriteGraph(store, swm, scope, {
        source: 'test.deprecated-write-resolver',
      });
      expect(replacementGraph).toBe(exact);

      await store.deleteByPattern({ graph: replacementGraph, subject: root });
      await store.insert([
        { subject: root, predicate: 'urn:p', object: '"replacement"', graph: replacementGraph },
      ]);
      const replaced = await loadSharedMemoryQuadsForScope(
        store,
        swm,
        { rootEntities: [root] },
        scope,
      );
      expect(replaced.map((quad) => quad.object)).toEqual(['"replacement"']);
    } finally {
      await store.close();
    }
  });

  it('reads every legacy casing alias but never chooses a write target from store order', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('named-aliases');
    const root = 'urn:test:named:aliases';
    const upperAlias = `${swm}/${AUTHOR_A_MIXED.toUpperCase().replace('0X', '0x')}/7`;
    const mixedAlias = `${swm}/${AUTHOR_A_MIXED}/7`;
    const canonical = `${swm}/${AUTHOR_A}/7`;
    const scope = {
      kind: 'named-lifecycle',
      identity: { agentAddress: AUTHOR_A_MIXED, kaNumber: 7n },
    } as const;
    try {
      await store.insert([
        { subject: root, predicate: 'urn:p', object: '"upper"', graph: upperAlias },
        { subject: root, predicate: 'urn:p', object: '"mixed"', graph: mixedAlias },
      ]);

      const quads = await loadSharedMemoryQuadsForScope(
        store,
        swm,
        { rootEntities: [root] },
        scope,
      );

      expect(quads.map((quad) => quad.object).sort()).toEqual(['"mixed"', '"upper"']);
      expect(canonicalSharedMemoryScopeWriteGraph(swm, scope)).toBe(canonical);
    } finally {
      await store.close();
    }
  });


  // `kaGraphBound` was removed from `LoadSelectedSharedMemoryQuadsOptions`, so the
  // four production callers — two of them merkle-DEFINING, one the ACK decline lane
  // — get a compile error if they try to prune. This pins the runtime half: even if
  // the field is forced through at a type boundary, the read stays unbounded.
  it('ignores a forced kaGraphBound option and still reads every under-graph', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('bound-nofootgun');
    const root = 'urn:test:footgun:root';
    const inBound = `${swm}/${AUTHOR_A_MIXED}/7`;
    const outOfBound = `${swm}/${AUTHOR_B}/12`;
    try {
      await store.insert([
        { subject: root, predicate: 'urn:p', object: '"bucket"', graph: swm },
        { subject: root, predicate: 'urn:p', object: '"in"', graph: inBound },
        { subject: root, predicate: 'urn:p', object: '"out"', graph: outOfBound },
      ]);

      const forced = {
        querySource: 'test.forced',
        kaGraphBound: { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n },
      } as unknown as Parameters<typeof loadSelectedSharedMemoryQuads>[3];

      const quads = await loadSelectedSharedMemoryQuads(store, swm, { rootEntities: [root] }, forced);

      // All three objects present ⇒ the out-of-bound graph was NOT pruned.
      expect(quads.map((q) => q.object).sort()).toEqual(['"bucket"', '"in"', '"out"']);
    } finally {
      await store.close();
    }
  });

  it('loadKaBoundedSharedMemoryQuads DOES prune, and takes the bound positionally', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('bound-explicit');
    const root = 'urn:test:explicit:root';
    const inBound = `${swm}/${AUTHOR_A_MIXED}/7`;
    const outOfBound = `${swm}/${AUTHOR_B}/12`;
    try {
      await store.insert([
        { subject: root, predicate: 'urn:p', object: '"bucket"', graph: swm },
        { subject: root, predicate: 'urn:p', object: '"in"', graph: inBound },
        { subject: root, predicate: 'urn:p', object: '"out"', graph: outOfBound },
      ]);

      const quads = await loadKaBoundedSharedMemoryQuads(
        store, swm, { rootEntities: [root] },
        { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n },
        { querySource: 'test.bounded' },
      );

      expect(quads.map((q) => q.object).sort()).toEqual(['"bucket"', '"in"']);
    } finally {
      await store.close();
    }
  });

  // The reviewer-requested API-surface regression: a non-finalization lane must not
  // be able to import the unsafe pruning primitives from the package entrypoint.
  it('does not publish the unsafe bounded primitives from the package public API', () => {
    expect(storageIndex).not.toHaveProperty('loadKaBoundedSharedMemoryQuads');
    expect(storageIndex).not.toHaveProperty('resolveKaBoundedSharedMemoryReadGraphs');
    // The safe, fallback-owning primitive IS public.
    expect(typeof storageIndex.loadSharedMemorySliceWithKaBoundFallback).toBe('function');
    expect(typeof storageIndex.loadMerkleVerifiedSharedMemorySlice).toBe('function');
    // Named publish flows get a scoped API, not a second range-shaped loader.
    expect(typeof storageIndex.loadSharedMemoryQuadsForScope).toBe('function');
    expect(storageIndex).not.toHaveProperty('loadGraphQualifiedSharedMemoryQuads');
    expect(storageIndex).not.toHaveProperty('migrateSharedMemoryRootClosureToNamedLifecycle');
    expect(typeof storageIndex.canonicalSharedMemoryScopeWriteGraph).toBe('function');
    expect(typeof storageIndex.resolveSharedMemoryScopeWriteGraph).toBe('function');
    expect(storageIndex).not.toHaveProperty('loadNamedKnowledgeAssetSharedMemoryQuads');
  });
});

describe('loadSharedMemorySliceWithKaBoundFallback — the safe bounded read', () => {
  const SOURCES = {
    bounded: 'test.bounded',
    widened: 'test.widened',
    unbounded: 'test.unbounded',
  } as const;

  it('bounded hit: reads the bound and never widens or re-accepts', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('fb-hit');
    const r = 'urn:fb:hit';
    try {
      await store.insert([
        { subject: r, predicate: 'urn:p', object: '"bucket"', graph: swm },
        { subject: r, predicate: 'urn:p', object: '"in"', graph: `${swm}/${AUTHOR_A_MIXED}/7` },
        { subject: r, predicate: 'urn:p', object: '"out"', graph: `${swm}/${AUTHOR_B}/12` },
      ]);

      let accepts = 0;
      const { quads, accepted } = await loadSharedMemorySliceWithKaBoundFallback(
        store, swm, { rootEntities: [r] },
        { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n },
        {
          sources: SOURCES,
          createAccept: async () => (qs) => { accepts += 1; return qs; },
        },
      );

      // Bounded read excluded the out-of-range graph, and the accept predicate
      // approved it, so no widen fired.
      expect(quads.map((q) => q.object).sort()).toEqual(['"bucket"', '"in"']);
      expect(accepted?.map((q) => q.object).sort()).toEqual(['"bucket"', '"in"']);
      expect(accepts).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('bounded mismatch: widens to the complete read and re-accepts', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('fb-miss');
    const r = 'urn:fb:miss';
    const outObj = '"out"';
    try {
      await store.insert([
        { subject: r, predicate: 'urn:p', object: '"in"', graph: `${swm}/${AUTHOR_A_MIXED}/7` },
        { subject: r, predicate: 'urn:p', object: outObj, graph: `${swm}/${AUTHOR_B}/12` },
      ]);

      // accept only when the out-of-range object is present ⇒ the bounded read is
      // rejected and the widen must supply it.
      const { quads, accepted } = await loadSharedMemorySliceWithKaBoundFallback(
        store, swm, { rootEntities: [r] },
        { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n },
        {
          sources: SOURCES,
          createAccept: async () => (qs) => (qs.some((q) => q.object === outObj) ? qs : null),
        },
      );

      expect(accepted).not.toBeNull();
      expect(quads.map((q) => q.object).sort()).toEqual(['"in"', '"out"']);
    } finally {
      await store.close();
    }
  });

  it('finds a recurring exact root in another author graph without a complete-family scan', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('fb-root-indexed');
    const root = 'urn:fb:root-indexed';
    const sources: string[] = [];
    const query = async (...args: Parameters<typeof store.query>) => {
      sources.push(args[1]?.source ?? '');
      return store.query(...args);
    };
    const read = {
      query,
      listGraphs: async () => { throw new Error('snapshot graph enumeration must not run'); },
    };
    const snapshotted = {
      query,
      listGraphs: store.listGraphs.bind(store),
      withReadSnapshot: async (fn: (value: typeof read) => Promise<unknown>) => fn(read),
    } as unknown as Parameters<typeof loadMerkleVerifiedSharedMemorySlice>[0];
    try {
      await store.insert([
        { subject: root, predicate: 'urn:p', object: '"own"', graph: `${swm}/${AUTHOR_A_MIXED}/7` },
        { subject: root, predicate: 'urn:p', object: '"recurred"', graph: `${swm}/${AUTHOR_B}/12` },
        { subject: root, predicate: 'urn:p', object: '"staging"', graph: `${swm}/staging/tmp` },
        { subject: root, predicate: 'urn:p', object: '"other bucket"', graph: `${swm}-other/${AUTHOR_B}/12` },
      ]);
      const expectedMerkleRoot = new Uint8Array(32).fill(7);
      const { quads, accepted } = await loadMerkleVerifiedSharedMemorySlice(
        snapshotted, swm, { rootEntities: [root] },
        { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n },
        {
          sources: { ...SOURCES, rootIndexed: 'test.rootIndexed', cachedGraphSet: 'test.cachedGraphSet' },
          expectedMerkleRoot,
          createMerkleAccept: async (merkleRoot) => {
            expect(merkleRoot).toEqual(expectedMerkleRoot);
            return (candidate) => candidate.some((quad) => quad.object === '"recurred"') ? candidate : null;
          },
          resultBudget: { pageRows: 100, maxRows: 1000, maxBytesEstimate: 1024 * 1024 },
        },
      );
      expect(keys(quads)).toEqual(keys(accepted ?? []));
      expect(quads.map((quad) => quad.object).sort()).toEqual(['"own"', '"recurred"']);
      expect(sources).toContain('test.rootIndexed');
      expect(sources).not.toContain(SOURCES.widened);
    } finally {
      await store.close();
    }
  });

  it('uses a merkle-checked warm graph catalog when exact-root discovery misses a skolem-only graph', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('fb-root-indexed-skolem');
    const root = 'urn:fb:root-indexed-skolem';
    const sources: string[] = [];
    const query = async (...args: Parameters<typeof store.query>) => {
      sources.push(args[1]?.source ?? '');
      return store.query(...args);
    };
    const read = {
      query,
      listGraphs: async () => { throw new Error('snapshot graph enumeration must not run'); },
    };
    const snapshotted = {
      query,
      listGraphs: store.listGraphs.bind(store),
      withReadSnapshot: async (fn: (value: typeof read) => Promise<unknown>) => fn(read),
    } as unknown as Parameters<typeof loadMerkleVerifiedSharedMemorySlice>[0];
    try {
      await store.insert([
        { subject: root, predicate: 'urn:p', object: '"root"', graph: `${swm}/${AUTHOR_A_MIXED}/7` },
        {
          subject: `${root}/.well-known/genid/child`, predicate: 'urn:p',
          object: '"child"', graph: `${swm}/${AUTHOR_B}/12`,
        },
      ]);
      const { quads, accepted } = await loadMerkleVerifiedSharedMemorySlice(
        snapshotted, swm, { rootEntities: [root] },
        { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n },
        {
          sources: { ...SOURCES, rootIndexed: 'test.rootIndexed', cachedGraphSet: 'test.cachedGraphSet' },
          expectedMerkleRoot: new Uint8Array(32),
          createMerkleAccept: async () => (candidate) =>
            candidate.some((quad) => quad.object === '"child"') ? candidate : null,
          resultBudget: { pageRows: 100, maxRows: 1000, maxBytesEstimate: 1024 * 1024 },
        },
      );
      expect(keys(quads)).toEqual(keys(accepted ?? []));
      expect(quads.map((quad) => quad.object).sort()).toEqual(['"child"', '"root"']);
      expect(sources).toContain('test.rootIndexed');
      expect(sources).toContain('test.cachedGraphSet');
      expect(sources).not.toContain(SOURCES.widened);
    } finally {
      await store.close();
    }
  });

  it('never accepts a stale warm catalog that omits a skolem-only graph', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('fb-stale-catalog');
    const root = 'urn:fb:stale-catalog';
    const rootGraph = `${swm}/${AUTHOR_A_MIXED}/7`;
    const childGraph = `${swm}/${AUTHOR_B}/12`;
    const sources: string[] = [];
    const query = async (...args: Parameters<typeof store.query>) => {
      sources.push(args[1]?.source ?? '');
      return store.query(...args);
    };
    const snapshotRead = { query, listGraphs: store.listGraphs.bind(store) };
    const snapshotted = {
      query,
      listGraphs: async () => [rootGraph],
      withReadSnapshot: async (fn: (value: typeof snapshotRead) => Promise<unknown>) => fn(snapshotRead),
    } as unknown as Parameters<typeof loadMerkleVerifiedSharedMemorySlice>[0];
    try {
      await store.insert([
        { subject: root, predicate: 'urn:p', object: '"root"', graph: rootGraph },
        { subject: `${root}/.well-known/genid/child`, predicate: 'urn:p', object: '"child"', graph: childGraph },
      ]);
      const { quads, accepted } = await loadMerkleVerifiedSharedMemorySlice(
        snapshotted, swm, { rootEntities: [root] }, undefined,
        {
          sources: { ...SOURCES, rootIndexed: 'test.rootIndexed', cachedGraphSet: 'test.cachedGraphSet' },
          expectedMerkleRoot: new Uint8Array(32),
          createMerkleAccept: async () => (candidate) =>
            candidate.some((quad) => quad.object === '"child"') ? candidate : null,
          resultBudget: { pageRows: 100, maxRows: 1000, maxBytesEstimate: 1024 * 1024 },
        },
      );
      expect(quads.map((quad) => quad.object)).toEqual(['"root"']);
      expect(accepted).toBeNull();
      expect(sources).toContain('test.cachedGraphSet');
      expect(sources).toContain(SOURCES.unbounded);
    } finally {
      await store.close();
    }
  });

  it('defers an unmatched huge family before issuing hundreds of graph chunks', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('fb-huge-family');
    const root = 'urn:fb:huge-family';
    const rootGraph = `${swm}/${AUTHOR_A_MIXED}/7`;
    const graphs = [rootGraph, ...Array.from({ length: 513 }, (_, i) => `${swm}/decoy-${i}`)];
    const sources: string[] = [];
    const query = async (...args: Parameters<typeof store.query>) => {
      sources.push(args[1]?.source ?? '');
      return store.query(...args);
    };
    const snapshotted = {
      query,
      listGraphs: async () => graphs,
      withReadSnapshot: async (read: (value: typeof store) => Promise<unknown>) => read({
        query, listGraphs: store.listGraphs.bind(store),
      } as typeof store),
    } as unknown as Parameters<typeof loadMerkleVerifiedSharedMemorySlice>[0];
    try {
      await store.insert([{ subject: root, predicate: 'urn:p', object: '"root"', graph: rootGraph }]);
      const { quads, accepted } = await loadMerkleVerifiedSharedMemorySlice(
        snapshotted, swm, { rootEntities: [root] }, undefined,
        {
          sources: { ...SOURCES, rootIndexed: 'test.rootIndexed', cachedGraphSet: 'test.cachedGraphSet' },
          expectedMerkleRoot: new Uint8Array(32),
          createMerkleAccept: async () => () => null,
          resultBudget: { pageRows: 100, maxRows: 1000, maxBytesEstimate: 1024 * 1024 },
          maxCompleteFamilyGraphs: 512,
        },
      );
      expect(quads.map((quad) => quad.object)).toEqual(['"root"']);
      expect(accepted).toBeNull();
      expect(sources).toContain('test.rootIndexed');
      expect(sources).not.toContain(SOURCES.unbounded);
    } finally {
      await store.close();
    }
  });

  it('deprecated positional options preserve bounded widening behavior', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('fb-legacy');
    const root = 'urn:fb:legacy';
    const widenedObject = '"widened"';
    try {
      await store.insert([
        { subject: root, predicate: 'urn:p', object: '"bounded"', graph: `${swm}/${AUTHOR_A_MIXED}/7` },
        { subject: root, predicate: 'urn:p', object: widenedObject, graph: `${swm}/${AUTHOR_B}/12` },
      ]);

      const { quads, accepted } = await loadSharedMemorySliceWithKaBoundFallback(
        store,
        swm,
        { rootEntities: [root] },
        { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n },
        SOURCES,
        async () => (candidate) =>
          candidate.some((quad) => quad.object === widenedObject) ? candidate : null,
      );

      expect(quads.map((quad) => quad.object).sort()).toEqual(['"bounded"', widenedObject]);
      expect(accepted).toEqual(quads);
    } finally {
      await store.close();
    }
  });

  it('no bound: one complete read, accept predicate applied once', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('fb-none');
    const r = 'urn:fb:none';
    try {
      await store.insert([
        { subject: r, predicate: 'urn:p', object: '"a"', graph: `${swm}/${AUTHOR_A_MIXED}/7` },
        { subject: r, predicate: 'urn:p', object: '"b"', graph: `${swm}/${AUTHOR_B}/12` },
      ]);

      let accepts = 0;
      const { quads } = await loadSharedMemorySliceWithKaBoundFallback(
        store, swm, { rootEntities: [r] },
        undefined,
        {
          sources: SOURCES,
          createAccept: async () => (qs) => { accepts += 1; return qs; },
        },
      );

      // Unbounded ⇒ both authors read; accept applied exactly once.
      expect(quads.map((q) => q.object).sort()).toEqual(['"a"', '"b"']);
      expect(accepts).toBe(1);
    } finally {
      await store.close();
    }
  });
});

describe('bounded SWM result materialization', () => {
  it('reads a large graph family in bounded queries without losing a recurring root', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('chunked-root-recurrence');
    const root = 'urn:chunked:root';
    const child = `${root}/.well-known/genid/child`;
    const graphs = Array.from({ length: 130 }, (_, i) => `${swm}/${AUTHOR_A_MIXED}/${String(i + 1).padStart(3, '0')}`);
    try {
      await seedGraphs(store, graphs);
      await store.insert([
        { subject: root, predicate: 'urn:p', object: '"same"', graph: graphs[0]! },
        { subject: root, predicate: 'urn:p', object: '"same"', graph: graphs[129]! },
        { subject: child, predicate: 'urn:p', object: '"child"', graph: graphs[129]! },
      ]);
      const query = store.query.bind(store);
      const spy = vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
        if (sparql.includes('VALUES ?g')) {
          const values = sparql.match(/VALUES \?g \{([^}]*)\}/)?.[1] ?? '';
          expect((values.match(/<[^>]+>/g) ?? []).length).toBeLessThanOrEqual(128);
        }
        return query(sparql, options);
      });

      const paged = await loadSelectedSharedMemoryQuads(
        store, swm, { rootEntities: [root] },
        { resultBudget: { pageRows: 1, maxRows: 2, maxBytesEstimate: 1024 * 1024 } },
      );
      const constructed = await loadSelectedSharedMemoryQuads(store, swm, { rootEntities: [root] });

      expect(keys(paged)).toEqual(keys(constructed));
      expect(keys(paged)).toEqual([
        `${child}|urn:p|"child"`,
        `${root}|urn:p|"same"`,
      ].sort());
      expect(spy.mock.calls.filter(([sparql]) => sparql.includes('VALUES ?g')).length).toBeGreaterThan(2);
      const graphQueries = spy.mock.calls.filter(([sparql]) => sparql.includes('VALUES ?g'));
      expect(graphQueries.some(([sparql]) => sparql.includes(`<${graphs[0]}>`) && !sparql.includes(`<${graphs[129]}>`))).toBe(true);
      expect(graphQueries.some(([sparql]) => sparql.includes(`<${graphs[129]}>`) && !sparql.includes(`<${graphs[0]}>`))).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('enforces row and byte budgets across separate graph chunks', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('chunked-cumulative-budget');
    const root = 'urn:chunked:budget-root';
    const graphs = Array.from({ length: 130 }, (_, i) =>
      `${swm}/${AUTHOR_A_MIXED}/${String(i + 1).padStart(3, '0')}`);
    const first = { subject: root, predicate: 'urn:p:first', object: '"first"', graph: graphs[0]! };
    const second = { subject: root, predicate: 'urn:p:second', object: '"second"', graph: graphs[129]! };
    try {
      await seedGraphs(store, graphs);
      await store.insert([first, second]);
      await expect(loadSelectedSharedMemoryQuads(store, swm, { rootEntities: [root] }, {
        resultBudget: { pageRows: 1, maxRows: 1, maxBytesEstimate: 1024 * 1024 },
      })).rejects.toMatchObject({ reason: 'rows', rows: 2 });
      const keyBytes = 64 + 2 * JSON.stringify([first.subject, first.predicate, first.object]).length;
      const quadBytes = 96 + 2 * (first.subject.length + first.predicate.length + first.object.length);
      await expect(loadSelectedSharedMemoryQuads(store, swm, { rootEntities: [root] }, {
        resultBudget: { pageRows: 1, maxRows: 3, maxBytesEstimate: keyBytes + quadBytes + 1 },
      })).rejects.toMatchObject({ reason: 'bytes', rows: 2 });
    } finally {
      await store.close();
    }
  });

  it('retries a multi-chunk read when an all-writer revision changes between queries', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('chunked-revision-fence');
    const root = 'urn:chunked:revision-root';
    const graphs = Array.from({ length: 130 }, (_, i) => `${swm}/${AUTHOR_A_MIXED}/${String(i + 1).padStart(3, '0')}`);
    const added = { subject: root, predicate: 'urn:p:new', object: '"new"', graph: graphs[0]! };
    try {
      await seedGraphs(store, graphs);
      await store.insert([{ subject: root, predicate: 'urn:p:old', object: '"old"', graph: graphs[0]! }]);
      const query = store.query.bind(store);
      let injected = false;
      vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
        const result = await query(sparql, options);
        if (!injected && sparql.includes('VALUES ?g')) {
          injected = true;
          await store.insert([added]);
        }
        return result;
      });
      const selected = await loadSelectedSharedMemoryQuads(store, swm, { rootEntities: [root] });
      expect(injected).toBe(true);
      expect(keys(selected)).toContain(key(added));
    } finally {
      await store.close();
    }
  });

  it('keeps an unsupported backend on one snapshot-consistent query', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('chunked-no-snapshot-capability');
    const root = 'urn:chunked:fallback-root';
    const graphs = Array.from({ length: 130 }, (_, i) => `${swm}/${AUTHOR_A_MIXED}/${String(i + 1).padStart(3, '0')}`);
    try {
      await seedGraphs(store, graphs);
      await store.insert([
        { subject: root, predicate: 'urn:p', object: '"same"', graph: graphs[0]! },
        { subject: root, predicate: 'urn:p', object: '"same"', graph: graphs[129]! },
      ]);
      // Deliberately expose only ordinary read operations, as with a backend
      // lacking both snapshot and all-writer revision capabilities.
      const query = vi.fn(store.query.bind(store));
      const plain = {
        query,
        listGraphs: store.listGraphs.bind(store),
      } as unknown as Parameters<typeof loadSelectedSharedMemoryQuads>[0];
      const selected = await loadSelectedSharedMemoryQuads(plain, swm, { rootEntities: [root] });
      expect(keys(selected)).toEqual([`${root}|urn:p|"same"`]);
      expect(query.mock.calls.filter(([sparql]) => sparql.includes('VALUES ?g')))
        .toHaveLength(1);
      query.mockClear();
      const budgeted = await loadSelectedSharedMemoryQuads(plain, swm, { rootEntities: [root] }, {
        resultBudget: { pageRows: 1, maxRows: 1, maxBytesEstimate: 1024 * 1024 },
      });
      expect(keys(budgeted)).toEqual(keys(selected));
      const budgetRequests = query.mock.calls.filter(([sparql]) => sparql.includes('VALUES ?g'));
      expect(budgetRequests).toHaveLength(1);
      expect(budgetRequests[0]?.[1]?.maxResponseBytes).toBe(5 * 1024 * 1024);
      query.mockClear();
      await loadSelectedSharedMemoryQuads(plain, swm, { rootEntities: [root] }, {
        queryOptions: { maxResponseBytes: 1_024 },
        resultBudget: { pageRows: 1, maxRows: 1, maxBytesEstimate: 1024 * 1024 },
      });
      const stricter = query.mock.calls.filter(([sparql]) => sparql.includes('VALUES ?g'));
      expect(stricter).toHaveLength(1);
      expect(stricter[0]?.[1]?.maxResponseBytes).toBe(1_024);
    } finally {
      await store.close();
    }
  });

  it('fails retryably after a write revision changes on every multi-chunk attempt', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('chunked-unstable-revision');
    const graphs = Array.from({ length: 130 }, (_, i) => `${swm}/${AUTHOR_A_MIXED}/${String(i + 1).padStart(3, '0')}`);
    try {
      await seedGraphs(store, graphs);
      let generation = 0;
      const unstable = {
        query: store.query.bind(store),
        listGraphs: store.listGraphs.bind(store),
        writeRevisionCoverage: 'all-writers',
        getWriteRevision: () => ({ generation: ++generation, stable: true }),
      } as unknown as Parameters<typeof loadSelectedSharedMemoryQuads>[0];
      await expect(loadSelectedSharedMemoryQuads(unstable, swm, 'all'))
        .rejects.toBeInstanceOf(SharedMemoryReadConsistencyError);
    } finally {
      await store.close();
    }
  });

  it('waits for an in-flight writer before reading a large multi-chunk family', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('chunked-transient-write');
    const graphs = Array.from({ length: 130 }, (_, i) => `${swm}/${AUTHOR_A_MIXED}/${String(i + 1).padStart(3, '0')}`);
    try {
      await seedGraphs(store, graphs);
      let stable = false;
      let scheduled = false;
      const query = vi.fn(store.query.bind(store));
      const fenced = {
        query,
        listGraphs: store.listGraphs.bind(store),
        writeRevisionCoverage: 'all-writers',
        getWriteRevision: () => {
          if (!scheduled) {
            scheduled = true;
            setImmediate(() => { stable = true; });
          }
          return { generation: 1, stable };
        },
      } as unknown as Parameters<typeof loadSelectedSharedMemoryQuads>[0];
      const selected = await loadSelectedSharedMemoryQuads(fenced, swm, 'all');
      expect(selected).toHaveLength(130);
      expect(query.mock.calls.filter(([sparql]) => sparql.includes('VALUES ?g')).length)
        .toBeGreaterThan(1);
    } finally {
      await store.close();
    }
  });

  it('honors cancellation while waiting for an in-flight writer', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('chunked-aborted-write');
    const graphs = Array.from({ length: 130 }, (_, i) => `${swm}/${AUTHOR_A_MIXED}/${String(i + 1).padStart(3, '0')}`);
    try {
      await seedGraphs(store, graphs);
      const controller = new AbortController();
      let scheduled = false;
      const fenced = {
        query: store.query.bind(store),
        listGraphs: store.listGraphs.bind(store),
        writeRevisionCoverage: 'all-writers',
        getWriteRevision: () => {
          if (!scheduled) {
            scheduled = true;
            setImmediate(() => controller.abort(new Error('read cancelled')));
          }
          return { generation: 1, stable: false };
        },
      } as unknown as Parameters<typeof loadSelectedSharedMemoryQuads>[0];
      await expect(loadSelectedSharedMemoryQuads(fenced, swm, 'all', {
        queryOptions: { signal: controller.signal },
      })).rejects.toThrow('read cancelled');
    } finally {
      await store.close();
    }
  });

  it('counts dedupe identities retained for filtered rows in the byte budget', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('result-filter-dedupe-budget');
    try {
      await store.insert(Array.from({ length: 5 }, (_, i) => ({
        subject: `urn:filtered:${i}`, predicate: 'urn:p', object: '"x"', graph: swm,
      })));
      await expect(loadSelectedSharedMemoryQuads(store, swm, 'all', {
        quadFilter: () => false,
        resultBudget: { pageRows: 10, maxRows: 100, maxBytesEstimate: 200 },
      })).rejects.toMatchObject({ name: 'SharedMemoryResultBudgetError', reason: 'bytes' });
    } finally {
      await store.close();
    }
  });

  it('rejects before retaining a result beyond the configured row budget', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('result-budget');
    const root = 'urn:budget:root';
    try {
      await store.insert([
        { subject: root, predicate: 'urn:p:1', object: '"one"', graph: swm },
        { subject: root, predicate: 'urn:p:2', object: '"two"', graph: swm },
      ]);

      await expect(loadSelectedSharedMemoryQuads(
        store,
        swm,
        { rootEntities: [root] },
        { resultBudget: { pageRows: 1, maxRows: 1, maxBytesEstimate: 1024 * 1024 } },
      )).rejects.toBeInstanceOf(SharedMemoryResultBudgetError);
    } finally {
      await store.close();
    }
  });

  it('rejects a large retained result by bytes even while below the row budget', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('result-byte-budget');
    const root = 'urn:budget:large-root';
    try {
      await store.insert([{
        subject: root,
        predicate: 'urn:p:large',
        object: `"${'x'.repeat(2_048)}"`,
        graph: swm,
      }]);

      await expect(loadSelectedSharedMemoryQuads(
        store,
        swm,
        { rootEntities: [root] },
        { resultBudget: { pageRows: 10, maxRows: 100, maxBytesEstimate: 128 } },
      )).rejects.toMatchObject({
        name: 'SharedMemoryResultBudgetError',
        reason: 'bytes',
        limit: 128,
      });
    } finally {
      await store.close();
    }
  });
});

describe('a multi-KA range admits the interior, not just the endpoints (T8)', () => {
  // Every other bound test uses a degenerate [n,n] range, so an implementation that
  // admitted only `kaNumber === startNumber` would pass all of them. This drives a
  // real same-author batch range: below/above are pruned, both endpoints AND the
  // interior are kept.
  it('admits [start..end] inclusive and prunes below/above and other authors', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('bound-t8');
    const below = `${swm}/${AUTHOR_A_MIXED}/3`;
    const start = `${swm}/${AUTHOR_A_MIXED}/5`;
    const interior = `${swm}/${AUTHOR_A_MIXED}/7`;
    const end = `${swm}/${AUTHOR_A_MIXED}/9`;
    const above = `${swm}/${AUTHOR_A_MIXED}/12`;
    const otherAuthor = `${swm}/${AUTHOR_B}/7`;
    try {
      await seedGraphs(store, [swm, below, start, interior, end, above, otherAuthor]);

      const bound: SwmKaGraphBound = { agentAddress: AUTHOR_A, startNumber: 5n, endNumber: 9n };
      const resolved = await resolveKaBoundedSharedMemoryReadGraphs(store, swm, bound);

      expect(resolved.slice().sort()).toEqual([swm, start, interior, end].sort());
      expect(resolved).not.toContain(below);
      expect(resolved).not.toContain(above);
      expect(resolved).not.toContain(otherAuthor);
    } finally {
      await store.close();
    }
  });

  it('kaNumbers compare numerically, not lexicographically', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('bound-t8-lex');
    // Lexicographically "10" < "9", so a string compare would wrongly prune g10.
    const g9 = `${swm}/${AUTHOR_A_MIXED}/9`;
    const g10 = `${swm}/${AUTHOR_A_MIXED}/10`;
    try {
      await seedGraphs(store, [swm, g9, g10]);

      const bound: SwmKaGraphBound = { agentAddress: AUTHOR_A, startNumber: 9n, endNumber: 10n };
      const resolved = await resolveKaBoundedSharedMemoryReadGraphs(store, swm, bound);

      expect(resolved.slice().sort()).toEqual([swm, g9, g10].sort());
    } finally {
      await store.close();
    }
  });
});
