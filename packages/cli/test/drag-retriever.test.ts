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
    if (sparql.includes('COUNT(DISTINCT ?s)')) {
      const n = new Set(this.entities.map((e) => e.s)).size;
      return { type: 'bindings', bindings: [{ n: String(n) }] };
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
    await r.retrieve('hello', cg, 10);
    expect(emb.calls).toBe(3);
    expect(await vs.count(cg, emb.model)).toBe(2);

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
});
