import { describe, expect, it } from 'vitest';
import type { Quad } from '@origintrail-official/dkg-storage';
import { SyncVerifyWorker } from '../src/sync-verify-worker.js';

describe('durable sync worker result transport', () => {
  it('reuses caller-owned quads instead of structured-cloning verified payloads back', async () => {
    const worker = new SyncVerifyWorker();
    const dataQuads: Quad[] = [
      {
        subject: 'urn:entity:1',
        predicate: 'http://schema.org/name',
        object: '"one"',
        graph: 'did:dkg:context-graph:test/context/1',
      },
      {
        subject: 'urn:entity:2',
        predicate: 'http://schema.org/name',
        object: '"two"',
        graph: 'did:dkg:context-graph:test/context/1',
      },
    ];

    try {
      const result = await worker.processDurableBatch(dataQuads, [], true);

      expect(result.totalFetchedDataQuads).toBe(2);
      expect(result.verifiedData).toEqual(dataQuads);
      expect(result.verifiedData[0]).toBe(dataQuads[0]);
      expect(result.verifiedData[1]).toBe(dataQuads[1]);
      expect(result.verifiedMeta).toEqual([]);
    } finally {
      await worker.close();
    }
  });
});
