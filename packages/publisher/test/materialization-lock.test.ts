/**
 * PR #845 review #7 (@branarakic) — TOCTOU in the materialization version
 * guard. `restateLabelGraphForUpdate` / `restateKaPartition` perform many
 * awaited mutations between `shouldApplyMaterialization` and
 * `writeMaterializedVersion`. Three independent async writers
 * (publishFromSharedMemory, FinalizationHandler, restate*) can all pass the
 * check while NO version is stamped, then one materialises a newer state,
 * then a stale writer resumes mid-sequence and clobbers it.
 *
 * `withMaterializationLock` serialises that whole sequence per-(metaGraph,
 * ual) so the check + work + stamp is effectively atomic on a single node.
 * These tests cover both the lock primitive directly and the
 * concurrent-writer integration behaviour.
 */
import { describe, it, expect } from 'vitest';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  V10MerkleTree, hashTripleV10,
} from '@origintrail-official/dkg-core';
import {
  withMaterializationLock,
  restateLabelGraphForUpdate,
  readMaterializedVersion,
  writeMaterializedVersion,
} from '../src/index.js';

const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

const CG = 'lock-cg';
const UAL = `did:dkg:hardhat/0xabcd/9001`;
const LABEL_META = `did:dkg:context-graph:${CG}/_meta`;
const LABEL_DATA = `did:dkg:context-graph:${CG}`;

function payload(root: string, value: string): Map<string, Quad[]> {
  return new Map([[root, [{ subject: root, predicate: 'urn:p', object: `"${value}"`, graph: '' }]]]);
}

function merkleFor(root: string, value: string): Uint8Array {
  return new V10MerkleTree([hashTripleV10(root, 'urn:p', `"${value}"`)]).root;
}

describe('withMaterializationLock — serialises check + write per (metaGraph, ual)', () => {
  it('runs two same-key callers sequentially (never concurrently)', async () => {
    const enters: number[] = [];
    const exits: number[] = [];
    let id = 0;

    async function task(): Promise<void> {
      const myId = ++id;
      await withMaterializationLock(LABEL_META, UAL, async () => {
        enters.push(myId);
        await new Promise((r) => setTimeout(r, 25));
        exits.push(myId);
      });
    }

    await Promise.all([task(), task(), task()]);

    // Each enter is immediately followed by its own exit — never interleaved.
    expect(enters).toHaveLength(3);
    expect(exits).toHaveLength(3);
    for (let i = 0; i < enters.length; i++) {
      expect(enters[i]).toBe(exits[i]);
    }
  });

  it('runs callers on DIFFERENT keys concurrently', async () => {
    const enters: string[] = [];
    let activeA = 0, activeB = 0, maxConcurrent = 0;

    async function task(meta: string, tag: string): Promise<void> {
      await withMaterializationLock(meta, UAL, async () => {
        enters.push(tag);
        if (tag.startsWith('a')) activeA++; else activeB++;
        maxConcurrent = Math.max(maxConcurrent, activeA + activeB);
        await new Promise((r) => setTimeout(r, 20));
        if (tag.startsWith('a')) activeA--; else activeB--;
      });
    }

    await Promise.all([
      task(`${LABEL_META}/a`, 'a1'),
      task(`${LABEL_META}/b`, 'b1'),
      task(`${LABEL_META}/a`, 'a2'),
      task(`${LABEL_META}/b`, 'b2'),
    ]);

    // Two distinct keys should let at least 2 callers run at once.
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it('does NOT poison the next caller when fn throws', async () => {
    let secondRan = false;
    await expect(
      withMaterializationLock(LABEL_META, UAL, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await withMaterializationLock(LABEL_META, UAL, async () => {
      secondRan = true;
    });
    expect(secondRan).toBe(true);
  });
});

/**
 * Integration: two concurrent restates on the same KA, the older one is
 * deliberately slowed via a delaying store wrapper. Without the lock, both
 * `shouldApplyMaterialization` reads see "no version yet" → both proceed
 * past the guard → the slower (stale, older block) one finishes LAST,
 * overwriting the newer one. With the lock, they serialise.
 */
describe('restateLabelGraphForUpdate — TOCTOU lock holds under concurrent writers', () => {
  /**
   * Store wrapper that injects a one-shot delay into the FIRST call into
   * `deleteByPattern`. Targeted enough to widen the lock-vs-no-lock race
   * without breaking other store ops.
   */
  function makeSlowStore(inner: TripleStore, delayMs: number): TripleStore {
    let armed = true;
    return new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'deleteByPattern' && typeof value === 'function') {
          return async function (...args: unknown[]): Promise<void> {
            if (armed) {
              armed = false;
              await new Promise((r) => setTimeout(r, delayMs));
            }
            return (value as (...a: unknown[]) => Promise<void>).apply(target, args);
          };
        }
        return value;
      },
    }) as TripleStore;
  }

  it('serialises two writers — newer always wins, stale becomes a no-op', async () => {
    const store = new OxigraphStore();

    // Seed minimal label _meta so restateLabelGraphForUpdate has rows to repoint.
    await store.insert([
      { subject: UAL, predicate: `${DKG}batchId`, object: `"9001"^^<${XSD}integer>`, graph: LABEL_META },
      { subject: `${UAL}/1`, predicate: `${RDF}type`, object: `${DKG}KnowledgeAsset`, graph: LABEL_META },
      { subject: `${UAL}/1`, predicate: `${DKG}partOf`, object: UAL, graph: LABEL_META },
      { subject: `${UAL}/1`, predicate: `${DKG}rootEntity`, object: 'urn:root:orig', graph: LABEL_META },
    ]);
    await store.insert([
      { subject: 'urn:root:orig', predicate: 'urn:p', object: '"orig"', graph: LABEL_DATA },
    ]);

    const slow = makeSlowStore(store, 50);

    // Start the STALE (older) writer first against the slow proxy — its
    // very first mutation will sleep 50ms inside the lock, giving the
    // newer writer time to queue.
    const stalePromise = restateLabelGraphForUpdate({
      store: slow, dataGraph: LABEL_DATA, metaGraph: LABEL_META, ual: UAL,
      merkleRoot: merkleFor('urn:root:stale', 'stale'),
      payloadByRoot: payload('urn:root:stale', 'stale'),
      version: { blockNumber: 100, txIndex: 0 },
    });

    // Tiny yield so the stale call enters the lock first.
    await new Promise((r) => setTimeout(r, 5));

    // NEWER writer enters next — it MUST wait for the stale one to release.
    const newerPromise = restateLabelGraphForUpdate({
      store, dataGraph: LABEL_DATA, metaGraph: LABEL_META, ual: UAL,
      merkleRoot: merkleFor('urn:root:newer', 'newer'),
      payloadByRoot: payload('urn:root:newer', 'newer'),
      version: { blockNumber: 200, txIndex: 0 },
    });

    const [staleApplied, newerApplied] = await Promise.all([stalePromise, newerPromise]);
    // Stale ran first and applied (no prior version), newer ran after and applied.
    expect(staleApplied).toBe(true);
    expect(newerApplied).toBe(true);

    // The final state must be the NEWER one — the older writer must not
    // have clobbered it.
    expect(await readMaterializedVersion(store, LABEL_META, UAL))
      .toEqual({ blockNumber: 200, txIndex: 0 });
    const dataRes = await store.query(
      `SELECT ?s ?o WHERE { GRAPH <${LABEL_DATA}> { ?s <urn:p> ?o } }`,
    );
    expect(dataRes.type).toBe('bindings');
    if (dataRes.type === 'bindings') {
      // Only the newer payload survives.
      expect(dataRes.bindings.map((b) => b['s'])).toEqual(['urn:root:newer']);
      expect(dataRes.bindings[0]['o']).toBe('"newer"');
    }
  });

  it('reversed order — newer wins even when scheduled first', async () => {
    const store = new OxigraphStore();
    await store.insert([
      { subject: UAL, predicate: `${DKG}batchId`, object: `"9001"^^<${XSD}integer>`, graph: LABEL_META },
      { subject: `${UAL}/1`, predicate: `${RDF}type`, object: `${DKG}KnowledgeAsset`, graph: LABEL_META },
      { subject: `${UAL}/1`, predicate: `${DKG}partOf`, object: UAL, graph: LABEL_META },
      { subject: `${UAL}/1`, predicate: `${DKG}rootEntity`, object: 'urn:root:orig', graph: LABEL_META },
    ]);

    const slow = makeSlowStore(store, 50);

    // Newer writer hits the slow store first.
    const newerPromise = restateLabelGraphForUpdate({
      store: slow, dataGraph: LABEL_DATA, metaGraph: LABEL_META, ual: UAL,
      merkleRoot: merkleFor('urn:root:newer', 'newer'),
      payloadByRoot: payload('urn:root:newer', 'newer'),
      version: { blockNumber: 200, txIndex: 0 },
    });
    await new Promise((r) => setTimeout(r, 5));
    // Stale writer queues behind.
    const stalePromise = restateLabelGraphForUpdate({
      store, dataGraph: LABEL_DATA, metaGraph: LABEL_META, ual: UAL,
      merkleRoot: merkleFor('urn:root:stale', 'stale'),
      payloadByRoot: payload('urn:root:stale', 'stale'),
      version: { blockNumber: 100, txIndex: 0 },
    });

    const [newerApplied, staleApplied] = await Promise.all([newerPromise, stalePromise]);
    expect(newerApplied).toBe(true);
    // Stale waits for the lock, re-reads the materialised version, finds
    // the newer one already stamped, and bows out cleanly.
    expect(staleApplied).toBe(false);

    expect(await readMaterializedVersion(store, LABEL_META, UAL))
      .toEqual({ blockNumber: 200, txIndex: 0 });
  });

  it('seeded prior version — stale concurrent attempt never enters work', async () => {
    const store = new OxigraphStore();
    await store.insert([
      { subject: UAL, predicate: `${DKG}batchId`, object: `"9001"^^<${XSD}integer>`, graph: LABEL_META },
      { subject: `${UAL}/1`, predicate: `${RDF}type`, object: `${DKG}KnowledgeAsset`, graph: LABEL_META },
      { subject: `${UAL}/1`, predicate: `${DKG}partOf`, object: UAL, graph: LABEL_META },
      { subject: `${UAL}/1`, predicate: `${DKG}rootEntity`, object: 'urn:root:current', graph: LABEL_META },
    ]);
    await writeMaterializedVersion(store, LABEL_META, UAL, { blockNumber: 300, txIndex: 7 });

    // Two stale-vs-stale writers, both at lower versions, fire concurrently.
    const a = restateLabelGraphForUpdate({
      store, dataGraph: LABEL_DATA, metaGraph: LABEL_META, ual: UAL,
      merkleRoot: merkleFor('urn:root:a', 'a'),
      payloadByRoot: payload('urn:root:a', 'a'),
      version: { blockNumber: 100, txIndex: 0 },
    });
    const b = restateLabelGraphForUpdate({
      store, dataGraph: LABEL_DATA, metaGraph: LABEL_META, ual: UAL,
      merkleRoot: merkleFor('urn:root:b', 'b'),
      payloadByRoot: payload('urn:root:b', 'b'),
      version: { blockNumber: 200, txIndex: 0 },
    });
    expect(await Promise.all([a, b])).toEqual([false, false]);

    // Materialised version unchanged — neither stale writer clobbered it.
    expect(await readMaterializedVersion(store, LABEL_META, UAL))
      .toEqual({ blockNumber: 300, txIndex: 7 });
  });
});
