/**
 * #2079 — the already-materialized witness, against a REAL OxigraphStore.
 *
 * The witness is a memo of a measurement this node already took. These rows pin
 * the three properties that make that sound, and each is written so that the
 * obvious wrong implementation fails it:
 *
 *   1. a warm second check does NO CONSTRUCT (the win), while still returning true;
 *   2. the count gate still runs FIRST, so a dropped graph is caught even with a
 *      standing witness (the self-healing property the issue's ASK-only design
 *      would have traded away);
 *   3. an equal-count v1 → v2 replace is NOT certified by the v1 witness (the one
 *      case the count cannot catch).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  readSwmMaterializationWitness,
  writeSwmMaterializationWitness,
  invalidateSwmMaterializationWitness,
  SWM_MATERIALIZATION_WITNESS_GRAPH,
} from '@origintrail-official/dkg-storage';
import { createSharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import { workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';

const GRAPH = 'did:dkg:context-graph:witness-cg/ka/1';

const stores: OxigraphStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
});

function newStore(): OxigraphStore {
  const s = new OxigraphStore();
  stores.push(s);
  return s;
}

/** N payload quads with a marker, so two versions can share a quad COUNT. */
function payload(marker: string, count: number): Quad[] {
  return Array.from({ length: count }, (_, i) => ({
    subject: `urn:snap:${marker}:${i}`,
    predicate: 'http://schema.org/status',
    object: `"${marker}"`,
    graph: '',
  }));
}

function descriptorFor(quads: Quad[]) {
  return {
    assertionGraph: GRAPH,
    publicQuadsCount: quads.length,
    publicQuadsDigest: workspacePublicQuadsDigest(quads),
  } as never;
}

/** Counts CONSTRUCTs so "did the fast path actually skip the expensive read" is observable. */
function countingStore(inner: TripleStore) {
  let constructs = 0;
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return async (sparql: string, options?: unknown) => {
          if (sparql.trimStart().startsWith('CONSTRUCT')) constructs += 1;
          return (target as TripleStore).query(sparql, options as never);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as TripleStore;
  return { store: proxy, constructs: () => constructs };
}

describe('#2079 witness module', () => {
  it('reads back only for the digest it was written with', async () => {
    const store = newStore();
    expect(await writeSwmMaterializationWitness(store, GRAPH, 'sha256:aaa')).toBe(true);
    expect(await readSwmMaterializationWitness(store, GRAPH, 'sha256:aaa')).toBe(true);
    // A different digest must MISS. This is what makes an equal-count version
    // change safe without relying on anyone remembering to invalidate.
    expect(await readSwmMaterializationWitness(store, GRAPH, 'sha256:bbb')).toBe(false);
  });

  it('EVICTS the previous claim rather than accumulating', async () => {
    const store = newStore();
    await writeSwmMaterializationWitness(store, GRAPH, 'sha256:aaa');
    await writeSwmMaterializationWitness(store, GRAPH, 'sha256:bbb');
    // If the write appended instead of replacing the subject, the OLD digest
    // would still read true — a standing lie about content that is gone.
    expect(await readSwmMaterializationWitness(store, GRAPH, 'sha256:aaa')).toBe(false);
    expect(await readSwmMaterializationWitness(store, GRAPH, 'sha256:bbb')).toBe(true);
  });

  it('invalidate removes the claim', async () => {
    const store = newStore();
    await writeSwmMaterializationWitness(store, GRAPH, 'sha256:aaa');
    await invalidateSwmMaterializationWitness(store, GRAPH);
    expect(await readSwmMaterializationWitness(store, GRAPH, 'sha256:aaa')).toBe(false);
  });

  it('lives outside every context-graph prefix', () => {
    // The chain-reset wipe and the sync responder both scope on the CG prefix;
    // a witness inside it would be served to peers and wiped as CG content.
    expect(SWM_MATERIALIZATION_WITNESS_GRAPH.startsWith('urn:dkg:local:')).toBe(true);
    expect(SWM_MATERIALIZATION_WITNESS_GRAPH.includes('did:dkg:context-graph:')).toBe(false);
  });
});

describe('#2079 isGraphAssetMaterialized fast path', () => {
  it('skips the CONSTRUCT on a warm second check, and still says materialized', async () => {
    const inner = newStore();
    const quads = payload('v1', 6);
    await inner.replaceGraph(GRAPH, quads.map((q) => ({ ...q, graph: GRAPH })));
    const { store, constructs } = countingStore(inner);
    const mat = createSharedMemorySnapshotMaterializer({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });
    const d = descriptorFor(quads);

    expect(await mat.isGraphAssetMaterialized(d)).toBe(true);
    const afterCold = constructs();
    expect(afterCold).toBe(1); // cold: paid the read-back once

    expect(await mat.isGraphAssetMaterialized(d)).toBe(true);
    // THE WIN: warm check performed no further CONSTRUCT.
    expect(constructs()).toBe(afterCold);
  });

  it('still reports NOT materialized when the graph is dropped, despite a standing witness', async () => {
    // The self-healing property. The TTL sweep, VM publish and the chain-reset
    // wipe all remove content outside this lock — and the chain-reset scoped
    // delete deliberately spares `urn:dkg:local:*`, so the witness SURVIVES.
    // The count gate is the only thing standing between that and an empty
    // store certified as parity.
    const store = newStore();
    const quads = payload('v1', 6);
    await store.replaceGraph(GRAPH, quads.map((q) => ({ ...q, graph: GRAPH })));
    const mat = createSharedMemorySnapshotMaterializer({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });
    const d = descriptorFor(quads);
    expect(await mat.isGraphAssetMaterialized(d)).toBe(true);

    // Content removed the way an out-of-band path removes it: the witness is
    // untouched and still asserts this exact digest.
    await store.dropGraph(GRAPH);
    expect(await readSwmMaterializationWitness(store, GRAPH, d.publicQuadsDigest)).toBe(true);

    expect(await mat.isGraphAssetMaterialized(d)).toBe(false);
  });

  it('writes NO witness when the digest does NOT match, and stays false on re-check', async () => {
    // "Only the branch that VERIFIED it writes it" is the entire soundness
    // argument — it is why #2079's head-row proposal was killed — and without
    // this row nothing pins it: making the write unconditional passes every
    // other test in the repo.
    //
    // Under that mutation the damage is sticky, not transient. A mismatch would
    // write a witness for `descriptor.publicQuadsDigest` — exactly the value
    // the NEXT round's ASK binds — so once `replaceGraph` fails (it throws on a
    // missing snapshot, and that throw is caught upstream, so the only
    // invalidator never runs) the check returns true forever.
    const store = newStore();
    const v1 = payload('v1', 6);
    const v2 = payload('v2', 6);
    await store.replaceGraph(GRAPH, v1.map((q) => ({ ...q, graph: GRAPH })));
    const mat = createSharedMemorySnapshotMaterializer({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });
    const d2 = descriptorFor(v2);

    // Store holds v1; ask about v2. Count matches, digest does not.
    expect(await mat.isGraphAssetMaterialized(d2)).toBe(false);

    // No witness may exist for a digest this node never matched.
    expect(await readSwmMaterializationWitness(store, GRAPH, d2.publicQuadsDigest)).toBe(false);

    // The second call is what kills the mutant: an unconditional write would
    // have memoized v2 on the first call, and this would come back true while
    // the store still holds v1.
    expect(await mat.isGraphAssetMaterialized(d2)).toBe(false);
  });

  it('degrades to a miss when the witness ASK itself fails', async () => {
    // The ASK is a pure optimisation, so a transient store error must fall
    // through to the real read-back rather than fail a check that would
    // otherwise have succeeded. Making the read rethrow currently survives the
    // whole agent suite, so this pins the containment.
    const inner = newStore();
    const quads = payload('v1', 6);
    await inner.replaceGraph(GRAPH, quads.map((q) => ({ ...q, graph: GRAPH })));

    let failAsks = false;
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return async (sparql: string, options?: unknown) => {
            if (failAsks && sparql.trimStart().startsWith('ASK')) {
              throw new Error('store unavailable');
            }
            return (target as TripleStore).query(sparql, options as never);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as TripleStore;

    const mat = createSharedMemorySnapshotMaterializer({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });
    const d = descriptorFor(quads);

    // Warm the memo, then break only the ASK.
    expect(await mat.isGraphAssetMaterialized(d)).toBe(true);
    failAsks = true;

    // Still correct — it recomputed instead of throwing.
    expect(await mat.isGraphAssetMaterialized(d)).toBe(true);
  });

  it('issues NO witness ASK when the store cannot hold a witness', async () => {
    // `sparql-http` with `atomicUpdates:false` has no `replaceSubject`, so a
    // witness can never be stored and every ASK would be permanent added cost
    // for a hit rate of zero. The static probe must skip the read entirely —
    // that config should be byte-identical to pre-#2079.
    const inner = newStore();
    const quads = payload('v1', 6);
    await inner.replaceGraph(GRAPH, quads.map((q) => ({ ...q, graph: GRAPH })));

    let asks = 0;
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        // Present the store as lacking atomic subject replace.
        if (prop === 'replaceSubject') return undefined;
        if (prop === 'query') {
          return async (sparql: string, options?: unknown) => {
            if (sparql.trimStart().startsWith('ASK')) asks += 1;
            return (target as TripleStore).query(sparql, options as never);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as TripleStore;

    const mat = createSharedMemorySnapshotMaterializer({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });
    const d = descriptorFor(quads);

    expect(await mat.isGraphAssetMaterialized(d)).toBe(true);
    expect(await mat.isGraphAssetMaterialized(d)).toBe(true);
    expect(asks).toBe(0);
  });

  it('does not certify v2 from a v1 witness when the quad COUNT is unchanged', async () => {
    // The one case the count cannot catch, so the digest binding must.
    const store = newStore();
    const v1 = payload('v1', 6);
    const v2 = payload('v2', 6); // same count, different content
    expect(v1.length).toBe(v2.length);

    await store.replaceGraph(GRAPH, v1.map((q) => ({ ...q, graph: GRAPH })));
    const mat = createSharedMemorySnapshotMaterializer({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });
    expect(await mat.isGraphAssetMaterialized(descriptorFor(v1))).toBe(true);

    // Store now holds v1; ask whether v2 is materialized. Count matches (6 = 6).
    expect(await mat.isGraphAssetMaterialized(descriptorFor(v2))).toBe(false);
  });
});
