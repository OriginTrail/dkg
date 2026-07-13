import { describe, expect, it } from 'vitest';
import type { Quad } from '@origintrail-official/dkg-storage';
import { SyncVerifyWorker } from '../src/sync-verify-worker.js';
import { processDurableBatchForWire } from '../src/sync-verify-worker-impl.js';

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

  it('reconstructs from the dispatched array order when callers resize or reorder inputs', async () => {
    const worker = new SyncVerifyWorker();
    const first: Quad = {
      subject: 'urn:entity:first',
      predicate: 'http://schema.org/name',
      object: '"first"',
      graph: 'did:dkg:context-graph:test/context/1',
    };
    const second: Quad = {
      subject: 'urn:entity:second',
      predicate: 'http://schema.org/name',
      object: '"second"',
      graph: 'did:dkg:context-graph:test/context/1',
    };
    const dataQuads = [first, second];

    try {
      const pending = worker.processDurableBatch(dataQuads, [], true);
      dataQuads.reverse();
      dataQuads.length = 0;

      const result = await pending;
      expect(result.verifiedData).toEqual([first, second]);
      expect(result.verifiedData[0]).toBe(first);
      expect(result.verifiedData[1]).toBe(second);
    } finally {
      await worker.close();
    }
  });

  it('returns the exact retained data and meta subsets as caller-owned references', async () => {
    const worker = new SyncVerifyWorker();
    const graph = 'did:dkg:context-graph:test/context/1';
    const rejectedData: Quad = {
      subject: 'urn:entity:rejected',
      predicate: 'http://schema.org/name',
      object: '"rejected"',
      graph,
    };
    const retainedData: Quad = {
      subject: 'urn:entity:retained',
      predicate: 'http://schema.org/name',
      object: '"retained"',
      graph,
    };
    const rejectedMerkle: Quad = {
      subject: 'urn:ual:rejected',
      predicate: 'http://dkg.io/ontology/merkleRoot',
      object: `"${'0'.repeat(64)}"`,
      graph,
    };
    const rejectedRoot: Quad = {
      subject: 'urn:ual:rejected',
      predicate: 'http://dkg.io/ontology/rootEntity',
      object: '"urn:entity:rejected"',
      graph,
    };
    const retainedMeta: Quad = {
      subject: 'urn:meta:retained',
      predicate: 'http://schema.org/name',
      object: '"retained"',
      graph,
    };

    try {
      const result = await worker.processDurableBatch(
        [rejectedData, retainedData],
        [rejectedMerkle, rejectedRoot, retainedMeta],
        false,
      );

      expect(result.rejectedKcs).toBe(1);
      expect(result.verifiedData).toEqual([retainedData]);
      expect(result.verifiedMeta).toEqual([retainedMeta]);
      expect(result.verifiedData[0]).toBe(retainedData);
      expect(result.verifiedMeta[0]).toBe(retainedMeta);
    } finally {
      await worker.close();
    }
  });

  it('records every source index when a system graph accepts a Merkle mismatch', async () => {
    const worker = new SyncVerifyWorker();
    const graph = 'did:dkg:context-graph:test/context/1';
    const data: Quad = {
      subject: 'urn:entity:mismatch',
      predicate: 'http://schema.org/name',
      object: '"accepted"',
      graph,
    };
    const merkleRoot: Quad = {
      subject: 'urn:ual:mismatch',
      predicate: 'http://dkg.io/ontology/merkleRoot',
      object: `"${'0'.repeat(64)}"`,
      graph,
    };
    const rootEntity: Quad = {
      subject: 'urn:ual:mismatch',
      predicate: 'http://dkg.io/ontology/rootEntity',
      object: '"urn:entity:mismatch"',
      graph,
    };
    const retainedMeta: Quad = {
      subject: 'urn:meta:retained',
      predicate: 'http://schema.org/name',
      object: '"retained"',
      graph,
    };

    try {
      const result = await worker.processDurableBatch(
        [data],
        [merkleRoot, rootEntity, retainedMeta],
        true,
      );

      expect(result.rejectedKcs).toBe(0);
      expect(result.verifiedData).toEqual([data]);
      expect(result.verifiedMeta).toEqual([merkleRoot, rootEntity, retainedMeta]);
      expect(result.verifiedData[0]).toBe(data);
      expect(result.verifiedMeta[0]).toBe(merkleRoot);
      expect(result.verifiedMeta[1]).toBe(rootEntity);
      expect(result.verifiedMeta[2]).toBe(retainedMeta);
      expect(result.logs.some(({ message }) => message.includes('Accepting 1 unverified KC'))).toBe(true);
    } finally {
      await worker.close();
    }
  });

  it('keeps verified Quad arrays off the raw worker response payload', () => {
    const data: Quad = {
      subject: 'urn:entity:wire',
      predicate: 'http://schema.org/name',
      object: '"wire"',
      graph: 'did:dkg:context-graph:test/context/1',
    };

    const wireResult = processDurableBatchForWire([data], [], true);

    expect(wireResult.verifiedDataIndexes).toEqual([0]);
    expect(wireResult.verifiedMetaIndexes).toEqual([]);
    expect(wireResult).not.toHaveProperty('verifiedData');
    expect(wireResult).not.toHaveProperty('verifiedMeta');
  });
});
