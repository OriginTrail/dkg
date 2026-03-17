import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteVecStore, canLoadSqliteVec } from '../src/sqlite-vec-store.js';
import { runVectorStoreContract } from './store-suite.js';

describe.skipIf(!canLoadSqliteVec())('SqliteVecStore', () => {
  runVectorStoreContract(() => new SqliteVecStore({
    dataDir: mkdtempSync(join(tmpdir(), 'dkg-vector-vec-')),
    dimensions: 3,
  }));

  it('accepts sqlite-vec rowids during upsert', async () => {
    const store = new SqliteVecStore({
      dataDir: mkdtempSync(join(tmpdir(), 'dkg-vector-vec-rowid-')),
      dimensions: 3,
    });

    try {
      await expect(store.upsert([
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
      ])).resolves.toBeUndefined();

      expect(await store.count({ paranetId: 'test' })).toBe(1);
    } finally {
      await store.close();
    }
  });
});
