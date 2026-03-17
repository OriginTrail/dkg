import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  PermanentEmbeddingError,
  TransientEmbeddingError,
  type EmbeddingProvider,
} from '../src/embedding-provider.js';
import { VectorJobQueue } from '../src/job-queue.js';
import type { VectorStore } from '../src/vector-store.js';

describe('VectorJobQueue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('processes store jobs in FIFO order', async () => {
    const db = new Database(':memory:');
    const processed: string[] = [];
    const provider: EmbeddingProvider = {
      async embed(texts) {
        return texts.map((text) => {
          processed.push(text);
          return { embedding: [1, 0, 0], tokenCount: 1 };
        });
      },
      dimensions: () => 3,
      modelName: () => 'test-model',
    };
    const vectorStore = createMockVectorStore();
    const queue = new VectorJobQueue(db, provider, vectorStore, createMockTripleStore());

    queue.enqueueStore([
      {
        subject: 'urn:alice',
        predicate: 'http://schema.org/name',
        object: '"Alice"',
        graph: 'did:dkg:paranet:test',
      },
    ], 'test', 'did:dkg:paranet:test');
    queue.enqueueStore([
      {
        subject: 'urn:bob',
        predicate: 'http://schema.org/name',
        object: '"Bob"',
        graph: 'did:dkg:paranet:test',
      },
    ], 'test', 'did:dkg:paranet:test');

    await queue.processNext();
    await queue.processNext();

    expect(processed[0]).toContain('Alice');
    expect(processed[1]).toContain('Bob');
    db.close();
  });

  it('retries transient embedding failures with backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-17T00:00:00Z'));

    const db = new Database(':memory:');
    let attempts = 0;
    const provider: EmbeddingProvider = {
      async embed() {
        attempts++;
        if (attempts === 1) throw new TransientEmbeddingError('temporary outage');
        return [{ embedding: [1, 0, 0], tokenCount: 1 }];
      },
      dimensions: () => 3,
      modelName: () => 'test-model',
    };
    const vectorStore = createMockVectorStore();
    const queue = new VectorJobQueue(db, provider, vectorStore, createMockTripleStore());

    queue.enqueueStore([
      {
        subject: 'urn:alice',
        predicate: 'http://schema.org/name',
        object: '"Alice"',
        graph: 'did:dkg:paranet:test',
      },
    ], 'test', 'did:dkg:paranet:test');

    await queue.processNext();
    expect(queue.stats().pending).toBe(1);
    expect(queue.stats().failed).toBe(0);

    await vi.advanceTimersByTimeAsync(30_000);
    await queue.processNext();
    expect((vectorStore.upsert as any).mock.calls).toHaveLength(1);
    expect(queue.stats().pending).toBe(0);
    db.close();
  });

  it('uses the configured retry interval for backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-17T00:00:00Z'));

    const db = new Database(':memory:');
    let attempts = 0;
    const provider: EmbeddingProvider = {
      async embed() {
        attempts++;
        if (attempts === 1) throw new TransientEmbeddingError('temporary outage');
        return [{ embedding: [1, 0, 0], tokenCount: 1 }];
      },
      dimensions: () => 3,
      modelName: () => 'test-model',
    };
    const vectorStore = createMockVectorStore();
    const queue = new VectorJobQueue(db, provider, vectorStore, createMockTripleStore(), {
      retryIntervalMs: 5_000,
    });

    queue.enqueueStore([
      {
        subject: 'urn:alice',
        predicate: 'http://schema.org/name',
        object: '"Alice"',
        graph: 'did:dkg:paranet:test',
      },
    ], 'test', 'did:dkg:paranet:test');

    await queue.processNext();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await queue.processNext()).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1_000);
    await queue.processNext();
    expect((vectorStore.upsert as any).mock.calls).toHaveLength(1);
    db.close();
  });

  it('drops permanent failures immediately', async () => {
    const db = new Database(':memory:');
    const provider: EmbeddingProvider = {
      async embed() {
        throw new PermanentEmbeddingError('bad api key');
      },
      dimensions: () => 3,
      modelName: () => 'test-model',
    };
    const vectorStore = createMockVectorStore();
    const queue = new VectorJobQueue(db, provider, vectorStore, createMockTripleStore());

    queue.enqueueStore([
      {
        subject: 'urn:alice',
        predicate: 'http://schema.org/name',
        object: '"Alice"',
        graph: 'did:dkg:paranet:test',
      },
    ], 'test', 'did:dkg:paranet:test');

    await queue.processNext();
    expect(queue.stats().pending).toBe(0);
    db.close();
  });
});

function createMockVectorStore(): VectorStore {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteByGraph: vi.fn().mockResolvedValue(0),
    deleteByParanet: vi.fn().mockResolvedValue(0),
    deleteByRootEntity: vi.fn().mockResolvedValue(0),
    count: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockTripleStore(): TripleStore {
  return {
    insert: async () => {},
    delete: async () => {},
    deleteByPattern: async () => 0,
    query: async () => ({ type: 'bindings', bindings: [] }),
    hasGraph: async () => false,
    createGraph: async () => {},
    dropGraph: async () => {},
    listGraphs: async () => [],
    deleteBySubjectPrefix: async () => 0,
    countQuads: async () => 0,
    close: async () => {},
  };
}
