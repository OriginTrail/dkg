import { describe, it, expect } from 'vitest';
import {
  createTripleStore,
  loadSelectedSharedMemoryQuads,
  loadKaBoundedSharedMemoryQuads,
  resolveSharedMemoryReadGraphs,
  type Quad,
  type SwmKaGraphBound,
} from '../src/index.js';
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
      const resolved = await resolveSharedMemoryReadGraphs(store, swm, undefined, bound);

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
      const resolved = await resolveSharedMemoryReadGraphs(store, swm, undefined, bound);

      expect(resolved).toContain(gSub);
      expect(resolved.slice().sort()).toEqual([swm, gSub].sort());
    } finally {
      await store.close();
    }
  });

  it('T3: absent bound is a no-op — resolve(store, swm) deep-equals resolve(store, swm, undefined, undefined)', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('bound-t3');
    try {
      await seedGraphs(store, [swm, `${swm}/${AUTHOR_A_MIXED}/7`, `${swm}/${AUTHOR_B}/9`, `${swm}/staging/tmp`]);

      const implicit = await resolveSharedMemoryReadGraphs(store, swm);
      const explicit = await resolveSharedMemoryReadGraphs(store, swm, undefined, undefined);
      expect(implicit).toEqual(explicit);
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
      const resolved = await resolveSharedMemoryReadGraphs(store, swm, undefined, bound);

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
  it('keeps a shared-memory child that reconstructs to a DIFFERENT bucket', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('bound-t2b2');
    const gAdmit = `${swm}/${AUTHOR_A_MIXED}/7`;
    const gOtherBucketChild = `${swm}/_shared_memory/${AUTHOR_B}/12`;
    try {
      await seedGraphs(store, [swm, gAdmit, gOtherBucketChild]);

      const bound: SwmKaGraphBound = { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n };
      const resolved = await resolveSharedMemoryReadGraphs(store, swm, undefined, bound);

      expect(resolved.slice().sort()).toEqual([swm, gAdmit, gOtherBucketChild].sort());
    } finally {
      await store.close();
    }
  });
});

describe('the generic SWM loader cannot be pruned (bound is not an option)', () => {
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
});
