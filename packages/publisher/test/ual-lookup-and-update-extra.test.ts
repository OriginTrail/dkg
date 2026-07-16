/**
 * Publisher-layer UAL lookup & UPDATE regression tests.
 *
 * Audit findings covered:
 *
 *   P-17 (LOW, dup #150) — UPDATE batch-not-found regression.
 *                           When `resolveUalByBatchId` cannot find the
 *                           given batchId in the `_meta` graph, the
 *                           publisher layer must NOT fabricate a UAL,
 *                           crash, or silently succeed. Spec §15 (KC
 *                           UPDATE pipeline) requires a clean
 *                           `undefined` return so callers decide the
 *                           failure policy. Pin that contract so a
 *                           future refactor that e.g. swaps the
 *                           fallback to `"did:dkg:unknown"` is caught.
 *
 *   P-18 (LOW, dup #79)   — `lookupByUAL` at the publisher layer.
 *                           The existing test surface for
 *                           `resolveUalByBatchId` is thin: no test
 *                           exercises the behavior when multiple
 *                           batchIds are indexed under the same
 *                           `_meta` graph (the lookup MUST use a
 *                           typed-integer literal so string-prefix
 *                           collisions like `1` vs `10` do not
 *                           corrupt the resolution).
 *
 * Per QA policy: no production code is modified. The tests below are
 * pinned against the expected behavior; if the metadata resolver
 * regresses, the failures ARE the bug signal.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { resolveUalByBatchId, updateMetaMerkleRoot } from '../src/index.js';
import { GraphManager } from '@origintrail-official/dkg-storage';

const CG = '42';
const BATCH_1 = 1n;
const BATCH_10 = 10n;
const BATCH_UNKNOWN = 999n;
const UAL_1 = 'did:dkg:hardhat:31337/0xpub/1';
const UAL_10 = 'did:dkg:hardhat:31337/0xpub/10';

describe('P-17: resolveUalByBatchId returns undefined for unknown batchId (no fabrication)', () => {
  let store: OxigraphStore;
  let metaGraph: string;
  beforeEach(async () => {
    store = new OxigraphStore();
    const gm = new GraphManager(store);
    await gm.ensureContextGraph(CG);
    metaGraph = gm.metaGraphUri(CG);
  });

  it('returns undefined when the _meta graph is empty (spec §15 UPDATE error path)', async () => {
    const result = await resolveUalByBatchId(store, metaGraph, BATCH_UNKNOWN);
    expect(result).toBeUndefined();
  });

  it('updateMetaMerkleRoot is a no-op when batchId is unknown (does not throw, does not mutate)', async () => {
    const newRoot = new Uint8Array(32).fill(0x5a);
    // If this ever throws, or inserts a fabricated UAL triple, the
    // regression in issue #150 is back — let the assertion below fail
    // loudly instead of swallowing the mutation.
    await expect(
      updateMetaMerkleRoot(store, new GraphManager(store), CG, BATCH_UNKNOWN, newRoot),
    ).resolves.toBeUndefined();

    const result = await store.query(
      `SELECT (COUNT(*) as ?c) WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings[0]['c']).toMatch(/^"?0"?/);
    }
  });
});

describe('P-18: resolveUalByBatchId uses a typed integer literal (batchId 1 ≠ batchId 10)', () => {
  let store: OxigraphStore;
  let metaGraph: string;
  beforeEach(async () => {
    store = new OxigraphStore();
    const gm = new GraphManager(store);
    await gm.ensureContextGraph(CG);
    metaGraph = gm.metaGraphUri(CG);

    // Seed with TWO batches so a naive string-contains SPARQL filter
    // would collide `"1"` against `"10"` and return the wrong UAL.
    await store.insert([
      {
        subject: UAL_1,
        predicate: 'http://dkg.io/ontology/batchId',
        object: `"1"^^<http://www.w3.org/2001/XMLSchema#integer>`,
        graph: metaGraph,
      },
      {
        subject: UAL_10,
        predicate: 'http://dkg.io/ontology/batchId',
        object: `"10"^^<http://www.w3.org/2001/XMLSchema#integer>`,
        graph: metaGraph,
      },
    ]);
  });

  it('batchId=1 resolves to the "/1" UAL exactly', async () => {
    const result = await resolveUalByBatchId(store, metaGraph, BATCH_1);
    expect(result).toBe(UAL_1);
  });

  it('batchId=10 resolves to the "/10" UAL (no prefix collision with batchId=1)', async () => {
    const result = await resolveUalByBatchId(store, metaGraph, BATCH_10);
    expect(result).toBe(UAL_10);
  });

  it('batchId that would substring-match a real row still returns undefined', async () => {
    // "1" lexicographically starts both "1" and "10"; a non-typed
    // SPARQL filter would return the wrong row here. A typed integer
    // filter (the correct implementation) must NOT match.
    const result = await resolveUalByBatchId(store, metaGraph, 100n);
    expect(result).toBeUndefined();
  });

  it('handles large bigints without Number precision loss (>2^53)', async () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1 — loses precision if coerced to Number
    await store.insert([
      {
        subject: `did:dkg:hardhat:31337/0xpub/${huge}`,
        predicate: 'http://dkg.io/ontology/batchId',
        object: `"${huge}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
        graph: metaGraph,
      },
    ]);
    const result = await resolveUalByBatchId(store, metaGraph, huge);
    expect(result).toBe(`did:dkg:hardhat:31337/0xpub/${huge}`);
  });
});
