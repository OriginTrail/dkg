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

  it('excludes wrong-CG / private / shared-memory / RFC-64 control graphs (no existence leak)', async () => {
    const store = await storeWith([['urn:s', 'urn:p', '"v"', G1]]);
    const other = `${contextGraphDataUri('other-cg')}/9`;
    const priv = `${cgPrefix}/_private`;
    const swm = `${cgPrefix}/_shared_memory`;
    const rfc64Control = `${cgPrefix}/_sync/applied-cg`;
    const resp = await readChangelogDeltaPage({
      reader: new FakeReader({ era: 'E1', seq: 5 }, [
        rec(1, G1, 'upsert'), rec(2, other, 'upsert'), rec(3, priv, 'upsert'), rec(4, swm, 'upsert'), rec(5, rfc64Control, 'upsert'),
      ]),
      store, contextGraphId: CG, sinceSeq: 0, requesterEra: 'E1', limit: 100,
    });
    expect(resp.kind).toBe('delta');
    if (resp.kind !== 'delta') return;
    expect(resp.records.map((r) => r.graph)).toEqual([G1]); // only the in-CG data graph
    expect(resp.nextSeq).toBe(5);              // still advances past the filtered window
    await store.close();
  });

  it('includes top-level meta while keeping join-request moderation curator-local', async () => {
    // OT-RFC-59 review 🔴 3594: the changelog lane serves data AND meta in one stream, so
    // it must emit topMeta — otherwise a changelog-only public CG never syncs its top-level
    // metadata. Join requests are the exception: those are curator-only moderation state.
    const topMeta = `${cgPrefix}/_meta`;
    const delegation = `did:dkg:agent-delegation:${CG}:0x1234`;
    const joinRequest = `did:dkg:join-request:${CG}:0x5678`;
    const store = await storeWith([
      ['urn:s', 'http://dkg.io/ontology/merkleRoot', '"0xabc"', topMeta],
      [cgPrefix, 'https://dkg.network/ontology#allowedAgent', '"0x1234"', topMeta],
      [delegation, 'https://dkg.network/ontology#delegationAgent', '"0x1234"', topMeta],
      [delegation, 'https://dkg.network/ontology#allowedDelegateePeer', '"12D3KooWAuthorized"', topMeta],
      [joinRequest, 'https://dkg.network/ontology#requesterPeerId', '"12D3KooWPrivateApplicant"', topMeta],
      ['urn:ordinary:data', 'urn:p', '"ordinary"', G1],
      ['_:ordinary-blank-node', 'urn:p', '"blank-node-preserved"', G1],
      [joinRequest, 'urn:p', '"misplaced-private-moderation"', G1],
    ]);
    const queries: string[] = [];
    const query = store.query.bind(store);
    store.query = async (sparql, options) => {
      queries.push(sparql);
      return query(sparql, options);
    };
    const resp = await readChangelogDeltaPage({
      reader: new FakeReader({ era: 'E1', seq: 2 }, [rec(1, topMeta, 'upsert'), rec(2, G1, 'upsert')]),
      store, contextGraphId: CG, sinceSeq: 0, requesterEra: 'E1', limit: 100,
    });
    expect(resp.kind).toBe('delta');
    if (resp.kind !== 'delta') return;
    const metaRecord = resp.records.find((record) => record.graph === topMeta);
    expect(metaRecord?.quads).toContain('"0xabc"');
    expect(metaRecord?.quads).toContain(delegation);
    expect(metaRecord?.quads).toContain('12D3KooWAuthorized');
    expect(metaRecord?.quads).not.toContain(joinRequest);
    expect(metaRecord?.quads).not.toContain('12D3KooWPrivateApplicant');

    // The deny is subject-based, so a misplaced moderation resource cannot
    // escape through another admitted graph either; unrelated data remains.
    const dataRecord = resp.records.find((record) => record.graph === G1);
    expect(dataRecord?.quads).toContain('"ordinary"');
    expect(dataRecord?.quads).toContain('"blank-node-preserved"');
    expect(dataRecord?.quads).not.toContain(joinRequest);
    expect(dataRecord?.quads).not.toContain('misplaced-private-moderation');

    // Redaction happens inside the graph read, before any moderation rows are
    // returned to Node. This guards against reintroducing the old read-all then
    // JS-filter path, whose memory cost grew with the full moderation history.
    const graphReads = queries.filter((sparql) =>
      sparql.includes('GRAPH ?g { ?s ?p ?o }') &&
      sparql.includes('VALUES ?g'),
    );
    expect(graphReads).toHaveLength(2);
    for (const sparql of graphReads) {
      expect(sparql).toContain(
        'FILTER(!isIRI(?s) || !STRSTARTS(STR(?s), "did:dkg:join-request:"))',
      );
    }
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
