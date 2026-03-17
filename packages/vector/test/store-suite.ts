import { afterEach, expect, it } from 'vitest';
import type { VectorStore } from '../src/vector-store.js';

export function runVectorStoreContract(factory: () => Promise<VectorStore> | VectorStore): void {
  let store: VectorStore | null = null;

  afterEach(async () => {
    await store?.close();
    store = null;
  });

  async function useStore(): Promise<VectorStore> {
    store = await factory();
    return store;
  }

  it('upserts and searches vectors', async () => {
    const vectorStore = await useStore();
    await vectorStore.upsert([
      {
        subject: 'urn:alice',
        predicate: 'http://schema.org/worksFor',
        object: '"Acme Corp"',
        graph: 'did:dkg:paranet:memory',
        paranetId: 'memory',
        text: 'Alice Johnson, works for, Acme Corp',
        embedding: [1, 0, 0],
        createdAt: 1,
      },
      {
        subject: 'urn:bob',
        predicate: 'http://schema.org/name',
        object: '"Bob"',
        graph: 'did:dkg:paranet:memory',
        paranetId: 'memory',
        text: 'Bob',
        embedding: [0, 1, 0],
        createdAt: 2,
      },
    ]);

    const results = await vectorStore.search([1, 0, 0], { topK: 2 });
    expect(results).toHaveLength(2);
    expect(results[0].entry.subject).toBe('urn:alice');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('filters by paranet and graph', async () => {
    const vectorStore = await useStore();
    await vectorStore.upsert([
      {
        subject: 'urn:alpha',
        predicate: 'http://schema.org/name',
        object: '"Alpha"',
        graph: 'did:dkg:paranet:alpha',
        paranetId: 'alpha',
        text: 'Alpha',
        embedding: [1, 0, 0],
        createdAt: 1,
      },
      {
        subject: 'urn:beta',
        predicate: 'http://schema.org/name',
        object: '"Beta"',
        graph: 'did:dkg:paranet:beta',
        paranetId: 'beta',
        text: 'Beta',
        embedding: [1, 0, 0],
        createdAt: 2,
      },
    ]);

    const alpha = await vectorStore.search([1, 0, 0], { paranetId: 'alpha' });
    expect(alpha).toHaveLength(1);
    expect(alpha[0].entry.subject).toBe('urn:alpha');

    const beta = await vectorStore.search([1, 0, 0], { graph: 'did:dkg:paranet:beta' });
    expect(beta).toHaveLength(1);
    expect(beta[0].entry.subject).toBe('urn:beta');
  });

  it('deletes a root entity and skolemized descendants together', async () => {
    const vectorStore = await useStore();
    await vectorStore.upsert([
      {
        subject: 'urn:root',
        predicate: 'http://schema.org/name',
        object: '"Root"',
        graph: 'did:dkg:paranet:test',
        paranetId: 'test',
        text: 'Root',
        embedding: [1, 0, 0],
        createdAt: 1,
      },
      {
        subject: 'urn:root/.well-known/genid/child',
        predicate: 'http://schema.org/name',
        object: '"Child"',
        graph: 'did:dkg:paranet:test',
        paranetId: 'test',
        text: 'Child',
        embedding: [0.9, 0, 0],
        createdAt: 2,
      },
      {
        subject: 'urn:other',
        predicate: 'http://schema.org/name',
        object: '"Other"',
        graph: 'did:dkg:paranet:test',
        paranetId: 'test',
        text: 'Other',
        embedding: [0, 1, 0],
        createdAt: 3,
      },
    ]);

    const removed = await vectorStore.deleteByRootEntity('urn:root', { graph: 'did:dkg:paranet:test' });
    expect(removed).toBe(2);
    expect(await vectorStore.count({ graph: 'did:dkg:paranet:test' })).toBe(1);
  });

  it('keeps upserts idempotent for the same triple', async () => {
    const vectorStore = await useStore();
    await vectorStore.upsert([
      {
        subject: 'urn:alice',
        predicate: 'http://schema.org/name',
        object: '"Alice"',
        graph: 'did:dkg:paranet:test',
        paranetId: 'test',
        text: 'Alice',
        embedding: [1, 0, 0],
        createdAt: 1,
      },
    ]);
    await vectorStore.upsert([
      {
        subject: 'urn:alice',
        predicate: 'http://schema.org/name',
        object: '"Alice"',
        graph: 'did:dkg:paranet:test',
        paranetId: 'test',
        text: 'Alice Updated',
        embedding: [1, 0, 0],
        createdAt: 2,
      },
    ]);

    expect(await vectorStore.count({ paranetId: 'test' })).toBe(1);
    const results = await vectorStore.search([1, 0, 0], { paranetId: 'test' });
    expect(results[0].entry.text).toBe('Alice Updated');
  });
}
