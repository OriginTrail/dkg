import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DKGEvent, TypedEventBus, type EventBus, type TriplesRemovedEvent, type TriplesStoredEvent } from '@origintrail-official/dkg-core';
import { createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import type { EmbeddingProvider } from '../src/embedding-provider.js';
import { StreamingScanStore } from '../src/streaming-scan-store.js';
import { VectorSidecar } from '../src/vector-sidecar.js';

describe('VectorSidecar', () => {
  let store: TripleStore | null = null;
  let sidecar: VectorSidecar | null = null;

  afterEach(async () => {
    await sidecar?.stop();
    await store?.close();
    sidecar = null;
    store = null;
  });

  it('indexes and removes triples from TRIPLES_* events', async () => {
    store = await createTripleStore({ backend: 'oxigraph' });
    const eventBus = new TypedEventBus();
    const dataDir = mkdtempSync(join(tmpdir(), 'dkg-vector-sidecar-'));
    const provider = new KeywordEmbeddingProvider();
    sidecar = new VectorSidecar(store, eventBus, {
      dataDir,
      embedding: { apiKey: 'test-key', dimensions: provider.dimensions() },
      embeddingProvider: provider,
      vectorStore: new StreamingScanStore({ dataDir, dimensions: provider.dimensions() }),
      workerIntervalMs: 5,
    });
    await sidecar.start();

    const storedEvent: TriplesStoredEvent = {
      quads: [
        {
          subject: 'urn:machine:washing-machine',
          predicate: 'http://schema.org/name',
          object: '"Washing Machine"',
          graph: 'did:dkg:paranet:agent-memory',
        },
        {
          subject: 'urn:machine:washing-machine',
          predicate: 'http://schema.org/description',
          object: '"Last maintenance 2026-03-01"',
          graph: 'did:dkg:paranet:agent-memory',
        },
      ],
      paranetId: 'agent-memory',
      graph: 'did:dkg:paranet:agent-memory',
      rootEntities: ['urn:machine:washing-machine'],
    };
    await store.insert(storedEvent.quads);
    eventBus.emit(DKGEvent.TRIPLES_STORED, storedEvent);

    await waitFor(async () => {
      const results = await sidecar!.search('when was washing machine maintenance', {
        paranetId: 'agent-memory',
        topK: 5,
      });
      expect(results.some((result) => result.subject === 'urn:machine:washing-machine')).toBe(true);
    });

    const removedEvent: TriplesRemovedEvent = {
      rootEntities: ['urn:machine:washing-machine'],
      paranetId: 'agent-memory',
      graph: 'did:dkg:paranet:agent-memory',
    };
    eventBus.emit(DKGEvent.TRIPLES_REMOVED, removedEvent);

    await waitFor(async () => {
      const results = await sidecar!.search('washing machine maintenance', {
        paranetId: 'agent-memory',
        topK: 5,
      });
      expect(results).toHaveLength(0);
    });
  });

  it('reindexes existing graph data', async () => {
    store = await createTripleStore({ backend: 'oxigraph' });
    await store.insert([
      {
        subject: 'urn:alice',
        predicate: 'http://schema.org/name',
        object: '"Alice Johnson"',
        graph: 'did:dkg:paranet:memory',
      },
      {
        subject: 'urn:alice',
        predicate: 'http://schema.org/worksFor',
        object: '"Acme Corp"',
        graph: 'did:dkg:paranet:memory',
      },
    ]);

    const eventBus = new TypedEventBus();
    const dataDir = mkdtempSync(join(tmpdir(), 'dkg-vector-reindex-'));
    const provider = new KeywordEmbeddingProvider();
    sidecar = new VectorSidecar(store, eventBus, {
      dataDir,
      embedding: { apiKey: 'test-key', dimensions: provider.dimensions() },
      embeddingProvider: provider,
      vectorStore: new StreamingScanStore({ dataDir, dimensions: provider.dimensions() }),
      workerIntervalMs: 5,
    });
    await sidecar.start();

    const result = await sidecar.reindex('memory', { graph: 'did:dkg:paranet:memory' });
    expect(result.count).toBeGreaterThan(0);

    const search = await sidecar.search('who works for acme', { paranetId: 'memory', topK: 5 });
    expect(search.some((entry) => entry.subject === 'urn:alice')).toBe(true);
  });

  it('verifies search hits against the graph and prunes stale vectors', async () => {
    store = await createTripleStore({ backend: 'oxigraph' });
    await store.insert([
      {
        subject: 'urn:machine:washing-machine',
        predicate: 'http://schema.org/description',
        object: '"Last maintenance was on 2026-04-15"',
        graph: 'did:dkg:paranet:agent-memory/_workspace',
      },
    ]);

    const eventBus = new TypedEventBus();
    const dataDir = mkdtempSync(join(tmpdir(), 'dkg-vector-verified-search-'));
    const provider = new KeywordEmbeddingProvider();
    const vectorStore = new StreamingScanStore({ dataDir, dimensions: provider.dimensions() });
    await vectorStore.upsert([
      {
        subject: 'urn:machine:washing-machine',
        predicate: 'http://schema.org/description',
        object: '"Last maintenance was on 2026-04-15"',
        graph: 'did:dkg:paranet:agent-memory/_workspace',
        paranetId: 'agent-memory',
        text: 'Washing Machine, description, Last maintenance was on 2026-04-15',
        embedding: keywordVector('washing machine maintenance 2026-04-15'),
        createdAt: 1,
      },
      {
        subject: 'urn:machine:stale-machine',
        predicate: 'http://schema.org/description',
        object: '"Last maintenance was on 2030-01-01"',
        graph: 'did:dkg:paranet:agent-memory/_workspace',
        paranetId: 'agent-memory',
        text: 'Stale Machine, description, Last maintenance was on 2030-01-01',
        embedding: keywordVector('washing machine maintenance 2030-01-01'),
        createdAt: 2,
      },
    ]);

    sidecar = new VectorSidecar(store, eventBus, {
      dataDir,
      embedding: { apiKey: 'test-key', dimensions: provider.dimensions() },
      embeddingProvider: provider,
      vectorStore,
      workerIntervalMs: 5,
    });
    await sidecar.start();

    const results = await sidecar.search('washing machine maintenance', {
      paranetId: 'agent-memory',
      topK: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.subject).toBe('urn:machine:washing-machine');
    expect(await vectorStore.count({ paranetId: 'agent-memory' })).toBe(1);
  });
});

class KeywordEmbeddingProvider implements EmbeddingProvider {
  dimensions(): number {
    return 4;
  }

  modelName(): string {
    return 'test-keyword-model';
  }

  async embed(texts: string[]) {
    return texts.map((text) => ({
      embedding: keywordVector(text),
      tokenCount: text.length,
    }));
  }
}

function keywordVector(text: string): number[] {
  const lower = text.toLowerCase();
  return [
    includesAny(lower, ['washing', 'machine', 'maintenance']) ? 1 : 0,
    includesAny(lower, ['alice', 'acme', 'works for']) ? 1 : 0,
    includesAny(lower, ['memory', 'workspace']) ? 1 : 0,
    lower.length > 0 ? 1 : 0,
  ];
}

function includesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

async function waitFor(assertion: () => Promise<void>, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  await assertion();
}
