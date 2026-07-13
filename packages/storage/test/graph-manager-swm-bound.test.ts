import { describe, it, expect } from 'vitest';
import * as storageIndex from '../src/index.js';
import {
  createTripleStore,
  canonicalNamedLifecycleSharedMemoryGraphUri,
  loadSharedMemoryQuadsForScope,
  loadSelectedSharedMemoryQuads,
  loadSharedMemorySliceWithKaBoundFallback,
  resolveSharedMemoryScopeWriteGraph,
  resolveSharedMemoryReadGraphs,
  type Quad,
  type SwmKaGraphBound,
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
  it('reads legacy checksum casing, excludes the bucket, and writes to the canonical lowercase graph', async () => {
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
      expect(canonicalNamedLifecycleSharedMemoryGraphUri(swm, scope.identity)).toBe(
        `${swm}/${AUTHOR_A}/7`,
      );
      expect(await resolveSharedMemoryScopeWriteGraph(store, swm, scope)).toBe(
        `${swm}/${AUTHOR_A}/7`,
      );
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
      expect(await resolveSharedMemoryScopeWriteGraph(store, swm, scope)).toBe(canonical);
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
    // Named publish flows get a scoped API, not a second range-shaped loader.
    expect(typeof storageIndex.loadSharedMemoryQuadsForScope).toBe('function');
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
        SOURCES,
        async () => (qs) => { accepts += 1; return qs; },
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
        SOURCES,
        async () => (qs) => (qs.some((q) => q.object === outObj) ? qs : null),
      );

      expect(accepted).not.toBeNull();
      expect(quads.map((q) => q.object).sort()).toEqual(['"in"', '"out"']);
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
        SOURCES,
        async () => (qs) => { accepts += 1; return qs; },
      );

      // Unbounded ⇒ both authors read; accept applied exactly once.
      expect(quads.map((q) => q.object).sort()).toEqual(['"a"', '"b"']);
      expect(accepts).toBe(1);
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
