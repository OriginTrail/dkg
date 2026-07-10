/**
 * OT-RFC-59 SC3 — readChangelogDeltaPage responder logic.
 * Uses a real Oxigraph store (for content serving + the RFC-49 admission
 * primitives) plus a fake ChangelogReader (to drive head/readChanges precisely).
 */
import { describe, it, expect } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import type { ChangelogReader, ChangeRecord, ChangeOp } from '@origintrail-official/dkg-storage';
import { contextGraphDataUri } from '@origintrail-official/dkg-core';
import { readChangelogDeltaPage } from '../src/sync/responder/graph-plan.js';

const CG = 'delta-test';
const cgPrefix = contextGraphDataUri(CG);           // did:dkg:context-graph:delta-test
const G1 = `${cgPrefix}/1`;
const G2 = `${cgPrefix}/2`;

class FakeReader implements ChangelogReader {
  constructor(
    private readonly headV: { era: string; seq: number },
    private readonly changes: ChangeRecord[],
  ) {}
  async changelogHead() { return this.headV; }
  async readChanges(sinceSeq: number, limit: number) {
    return this.changes.filter((c) => c.seq > sinceSeq).slice(0, limit);
  }
}

function rec(seq: number, graph: string, op: ChangeOp): ChangeRecord {
  return { seq, graph, op };
}

async function storeWith(quads: Array<[string, string, string, string]>) {
  const store = new OxigraphStore();
  await store.insert(quads.map(([s, p, o, g]) => ({ subject: s, predicate: p, object: o, graph: g })));
  return store;
}

describe('readChangelogDeltaPage — resync directives', () => {
  it('resyncs on era mismatch', async () => {
    const store = new OxigraphStore();
    const resp = await readChangelogDeltaPage({
      reader: new FakeReader({ era: 'E2', seq: 10 }, []),
      store, contextGraphId: CG, sinceSeq: 4, requesterEra: 'E1', limit: 100,
    });
    expect(resp).toEqual({ kind: 'resync', era: 'E2', headSeq: 10 });
    await store.close();
  });

  it('resyncs on first contact (era null)', async () => {
    const store = new OxigraphStore();
    const resp = await readChangelogDeltaPage({
      reader: new FakeReader({ era: 'E1', seq: 10 }, []),
      store, contextGraphId: CG, sinceSeq: 0, requesterEra: null, limit: 100,
    });
    expect(resp.kind).toBe('resync');
    await store.close();
  });

  it('resyncs on rollback (head.seq < sinceSeq)', async () => {
    const store = new OxigraphStore();
    const resp = await readChangelogDeltaPage({
      reader: new FakeReader({ era: 'E1', seq: 5 }, []),
      store, contextGraphId: CG, sinceSeq: 8, requesterEra: 'E1', limit: 100,
    });
    expect(resp.kind).toBe('resync');
    await store.close();
  });
});

describe('readChangelogDeltaPage — delta serving', () => {
  it('serves admitted upsert content + drop records, collapses per graph, nextSeq=head when drained', async () => {
    const store = await storeWith([
      ['urn:s1', 'urn:p', '"a"', G2],
      ['urn:s2', 'urn:p', '"b"', G2],
    ]);
    // G1 upsert@1 then drop@3; G2 upsert@2. Collapse: G1→drop(3), G2→upsert(2).
    const resp = await readChangelogDeltaPage({
      reader: new FakeReader({ era: 'E1', seq: 3 }, [
        rec(1, G1, 'upsert'), rec(2, G2, 'upsert'), rec(3, G1, 'drop'),
      ]),
      store, contextGraphId: CG, sinceSeq: 0, requesterEra: 'E1', limit: 100,
    });
    expect(resp.kind).toBe('delta');
    if (resp.kind !== 'delta') return;
    expect(resp.era).toBe('E1');
    expect(resp.headSeq).toBe(3);
    expect(resp.nextSeq).toBe(3);              // drained (3 < limit) ⇒ caught up to head
    // Ascending by seq: G2 upsert (2) then G1 drop (3).
    expect(resp.records.map((r) => [r.seq, r.op])).toEqual([[2, 'upsert'], [3, 'drop']]);
    const g2 = resp.records.find((r) => r.graph === G2)!;
    expect(g2.quads).toContain('urn:s1');
    expect(g2.quads).toContain('urn:s2');
    const g1 = resp.records.find((r) => r.graph === G1)!;
    expect(g1.quads).toBeUndefined();          // drop carries no content
    await store.close();
  });

  it('excludes wrong-CG / private / shared-memory graphs (no existence leak)', async () => {
    const store = await storeWith([['urn:s', 'urn:p', '"v"', G1]]);
    const other = `${contextGraphDataUri('other-cg')}/9`;
    const priv = `${cgPrefix}/_private`;
    const swm = `${cgPrefix}/_shared_memory`;
    const resp = await readChangelogDeltaPage({
      reader: new FakeReader({ era: 'E1', seq: 4 }, [
        rec(1, G1, 'upsert'), rec(2, other, 'upsert'), rec(3, priv, 'upsert'), rec(4, swm, 'upsert'),
      ]),
      store, contextGraphId: CG, sinceSeq: 0, requesterEra: 'E1', limit: 100,
    });
    expect(resp.kind).toBe('delta');
    if (resp.kind !== 'delta') return;
    expect(resp.records.map((r) => r.graph)).toEqual([G1]); // only the in-CG data graph
    expect(resp.nextSeq).toBe(4);              // still advances past the filtered window
    await store.close();
  });

  it('nextSeq is the scanned high-water (not head) when the scan window is full', async () => {
    const store = await storeWith([['urn:s', 'urn:p', '"v"', G1], ['urn:s2', 'urn:p', '"v"', G2]]);
    // limit 1 ⇒ readChanges returns only seq 1; head is 2 ⇒ not drained.
    const resp = await readChangelogDeltaPage({
      reader: new FakeReader({ era: 'E1', seq: 2 }, [rec(1, G1, 'upsert'), rec(2, G2, 'upsert')]),
      store, contextGraphId: CG, sinceSeq: 0, requesterEra: 'E1', limit: 1,
    });
    expect(resp.kind).toBe('delta');
    if (resp.kind !== 'delta') return;
    expect(resp.records.map((r) => r.seq)).toEqual([1]);
    expect(resp.nextSeq).toBe(1);              // scanned-through, < headSeq(2) ⇒ requester loops
    expect(resp.headSeq).toBe(2);
    await store.close();
  });

  it('byte-bounds a page: a tiny budget emits one graph and stops at its seq', async () => {
    const big = '"' + 'x'.repeat(500) + '"';
    const store = await storeWith([
      ['urn:a', 'urn:p', big, G1],
      ['urn:b', 'urn:p', big, G2],
    ]);
    const resp = await readChangelogDeltaPage({
      reader: new FakeReader({ era: 'E1', seq: 2 }, [rec(1, G1, 'upsert'), rec(2, G2, 'upsert')]),
      store, contextGraphId: CG, sinceSeq: 0, requesterEra: 'E1', limit: 100,
      maxResponseBytes: 100,                    // smaller than one graph's serialized quads
    });
    expect(resp.kind).toBe('delta');
    if (resp.kind !== 'delta') return;
    expect(resp.records).toHaveLength(1);       // first graph emitted alone (never split)
    expect(resp.records[0].seq).toBe(1);
    expect(resp.nextSeq).toBe(1);               // budget-truncated ⇒ last emitted seq
    await store.close();
  });

  it('empty in-CG delta still advances nextSeq to head when drained', async () => {
    const store = new OxigraphStore();
    const resp = await readChangelogDeltaPage({
      reader: new FakeReader({ era: 'E1', seq: 7 }, [rec(6, `${contextGraphDataUri('x')}/1`, 'upsert')]),
      store, contextGraphId: CG, sinceSeq: 5, requesterEra: 'E1', limit: 100,
    });
    expect(resp.kind).toBe('delta');
    if (resp.kind !== 'delta') return;
    expect(resp.records).toHaveLength(0);
    expect(resp.nextSeq).toBe(7);
    await store.close();
  });
});
