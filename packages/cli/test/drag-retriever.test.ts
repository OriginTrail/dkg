import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VectorStore, type EmbeddingProvider } from '../src/vector-store.js';
import { VectorEntityRetriever, type QueryableStore } from '../src/daemon/drag-retriever.js';

// Counts embed() calls so we can prove indexing only embeds the delta.
class CountingEmbedder implements EmbeddingProvider {
  readonly model = 'fake-embedder';
  readonly dimensions = 4;
  calls = 0;
  async embed(text: string): Promise<number[]> {
    this.calls++;
    return [1, (text.charCodeAt(0) || 0) % 7, text.length % 5, 0.5];
  }
}

// Growable fake triple store: one prop per entity in a per-KA VM graph.
class FakeStore implements QueryableStore {
  entities: Array<{ g: string; s: string; p: string; o: string }> = [];
  async query(sparql: string) {
    if (sparql.includes('COUNT')) {
      // distinct (graph, subject) pairs — matches the indexer's insert granularity
      const pairs = new Set(this.entities.map((e) => `${e.g}|${e.s}`));
      return { type: 'bindings', bindings: [{ n: String(pairs.size) }] };
    }
    return { type: 'bindings', bindings: this.entities.map((e) => ({ ...e })) };
  }
}

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('VectorEntityRetriever — incremental indexing', () => {
  it('embeds only newly-published entities on a re-scan, not the whole graph', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drag-vs-'));
    dirs.push(dir);
    const vs = new VectorStore(dir);
    const emb = new CountingEmbedder();
    const store = new FakeStore();
    const cg = 'cg1';
    const vm1 = `did:dkg:context-graph:${cg}/_verifiable_memory/0xabc/1`;
    store.entities.push({ g: vm1, s: 'urn:a', p: 'http://ex/name', o: '"Alice"' });
    store.entities.push({ g: vm1, s: 'urn:b', p: 'http://ex/name', o: '"Bob"' });

    const r = new VectorEntityRetriever(vs, emb, store);

    // First query: cold index → embed both entities (2) + the question (1).
    const first = await r.retrieve('hello', cg, 10);
    expect(emb.calls).toBe(3);
    expect(await vs.count(cg, emb.model)).toBe(2);
    expect(first.degraded).toBe(false); // working embedder → NOT degraded (the "no matches" ≠ "no model" half)

    // Publish a third entity, then query again.
    store.entities.push({
      g: `did:dkg:context-graph:${cg}/_verifiable_memory/0xabc/2`,
      s: 'urn:c',
      p: 'http://ex/name',
      o: '"Carol"',
    });
    const before = emb.calls;
    await r.retrieve('hello again', cg, 10);
    // Only the one NEW entity is embedded (1) + the question (1) — not a,b again.
    expect(emb.calls - before).toBe(2);
    expect(await vs.count(cg, emb.model)).toBe(3);

    // Nothing new → re-scan embeds nothing but the question.
    const before2 = emb.calls;
    await r.retrieve('third', cg, 10);
    expect(emb.calls - before2).toBe(1);

    vs.close();
  });

  it('warm() with an injection-bearing context graph id never reaches the SPARQL sink', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drag-vs-'));
    dirs.push(dir);
    const vs = new VectorStore(dir);
    const emb = new CountingEmbedder();
    let queried = false;
    const store: QueryableStore = {
      query: async () => {
        queried = true;
        return { type: 'bindings', bindings: [] };
      },
    };
    const r = new VectorEntityRetriever(vs, emb, store);
    // A '"' would close the SPARQL string literal vmPrefix is interpolated into.
    await r.warm('cg" } INSERT DATA { <urn:a> <urn:b> <urn:c> } #');
    expect(queried).toBe(false); // validateContextGraphId rejected it before any SPARQL ran
  });

  it('returns degraded=true and no anchors when the embedder cannot run (no model)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drag-vs-'));
    dirs.push(dir);
    const vs = new VectorStore(dir);
    const broken: EmbeddingProvider = {
      model: 'broken-model',
      dimensions: 4,
      embed: async () => {
        throw new Error('optional model dependency not installed');
      },
    };
    const store = new FakeStore();
    store.entities.push({ g: `did:dkg:context-graph:cgd/_verifiable_memory/0x/1`, s: 'urn:a', p: 'http://ex/name', o: '"A"' });
    const r = new VectorEntityRetriever(vs, broken, store);
    const result = await r.retrieve('anything', 'cgd', 10);
    expect(result.anchors).toEqual([]); // no silent crash
    expect(result.degraded).toBe(true); // the actionable "no model" signal, distinct from "no matches"
  });

  it('keeps overlapping calls isolated when one embed fails and the other succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drag-vs-'));
    dirs.push(dir);
    const vs = new VectorStore(dir);
    let rejectFailed!: (reason?: unknown) => void;
    let resolveSuccessful!: (embedding: number[]) => void;
    const failedEmbedding = new Promise<number[]>((_, reject) => {
      rejectFailed = reject;
    });
    const successfulEmbedding = new Promise<number[]>((resolve) => {
      resolveSuccessful = resolve;
    });
    let started = 0;
    let bothStarted!: () => void;
    const bothCallsStarted = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const embedder: EmbeddingProvider = {
      model: 'overlap-model',
      dimensions: 4,
      embed: (text) => {
        started++;
        if (started === 2) bothStarted();
        return text === 'fails' ? failedEmbedding : successfulEmbedding;
      },
    };
    const r = new VectorEntityRetriever(vs, embedder, new FakeStore());

    const failedCall = r.retrieve('fails', 'cgoverlap', 10);
    const successfulCall = r.retrieve('succeeds', 'cgoverlap', 10);
    await bothCallsStarted;

    // Complete the failed call first. A shared last-call flag would now taint
    // the still-running successful call and misreport its genuine empty result.
    rejectFailed(new Error('model request failed'));
    expect(await failedCall).toEqual({ anchors: [], degraded: true });
    resolveSuccessful([1, 0, 0, 0]);
    expect(await successfulCall).toEqual({ anchors: [], degraded: false });

    vs.close();
  });

  it('re-indexes a new entity even when a subject recurs across VM graphs (gate counts pairs, not subjects)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drag-vs-'));
    dirs.push(dir);
    const vs = new VectorStore(dir);
    const emb = new CountingEmbedder();
    const store = new FakeStore();
    const cg = 'cg2';
    // urn:shared is a subject in THREE VM graphs → 3 (g,s) pairs but 1 distinct subject.
    for (const n of [1, 2, 3]) {
      store.entities.push({
        g: `did:dkg:context-graph:${cg}/_verifiable_memory/0xabc/${n}`,
        s: 'urn:shared',
        p: 'http://ex/name',
        o: `"v${n}"`,
      });
    }
    const r = new VectorEntityRetriever(vs, emb, store);
    await r.retrieve('x', cg, 10);
    expect(await vs.count(cg, emb.model)).toBe(3); // 3 pairs embedded

    // Publish a brand-new entity: distinct subjects 1→2, but pairs 3→4. The old
    // subject-count gate (2 <= 3) would SKIP this; the pair-count gate (4 > 3) indexes it.
    store.entities.push({
      g: `did:dkg:context-graph:${cg}/_verifiable_memory/0xabc/4`,
      s: 'urn:fresh',
      p: 'http://ex/name',
      o: '"Fresh"',
    });
    await r.retrieve('y', cg, 10);
    expect(await vs.count(cg, emb.model)).toBe(4); // urn:fresh got embedded
  });

  it('does not let WM/SWM rows on the same CG+model satisfy the VM freshness gate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drag-vs-'));
    dirs.push(dir);
    const vs = new VectorStore(dir);
    const emb = new CountingEmbedder();
    const store = new FakeStore();
    const cg = 'cg3';
    // Pre-seed a WM (agent-memory) embedding under the SAME cg + model — an
    // assertion graph, NOT a verifiable-memory graph.
    await vs.insert({
      id: `${emb.model}:wm:urn:wm`,
      embedding: [1, 2, 3, 0.5],
      sourceUri: `did:dkg:context-graph:${cg}/assertion/x`,
      entityUri: 'urn:wm',
      contextGraphId: cg,
      memoryLayer: 'wm',
      model: emb.model,
    });
    // Publish one VM entity.
    store.entities.push({ g: `did:dkg:context-graph:${cg}/_verifiable_memory/0x/1`, s: 'urn:v', p: 'http://ex/name', o: '"V"' });
    const r = new VectorEntityRetriever(vs, emb, store);
    await r.retrieve('q', cg, 10);
    // The WM row must NOT count toward the VM gate, so the VM entity IS embedded.
    expect(await vs.count(cg, emb.model, 'vm')).toBe(1);
    expect(await vs.count(cg, emb.model)).toBe(2); // 1 wm + 1 vm overall
  });
});
