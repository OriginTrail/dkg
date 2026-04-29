import { describe, expect, it } from 'vitest';
import { batchAssetsByEstimatedBytes, DEFAULT_MAX_SHARE_BATCH_BYTES, groupAssetsByRootEntity } from '../src/share-batching.js';

describe('share batching helpers', () => {
  it('groups assets by root entity before batching', () => {
    const grouped = groupAssetsByRootEntity([
      { rootEntity: 'urn:root:1', quads: [{ subject: 'urn:root:1', predicate: 'urn:p1', object: '"a"' }] },
      { rootEntity: 'urn:root:1', quads: [{ subject: 'urn:child:1', predicate: 'urn:p2', object: '"b"' }] },
    ]);

    expect(grouped).toEqual([
      {
        rootEntity: 'urn:root:1',
        quads: [
          { subject: 'urn:root:1', predicate: 'urn:p1', object: '"a"', graph: '' },
          { subject: 'urn:child:1', predicate: 'urn:p2', object: '"b"', graph: '' },
        ],
      },
    ]);
  });

  it('uses a conservative default below the 512KB SWM gossip cap', () => {
    expect(DEFAULT_MAX_SHARE_BATCH_BYTES).toBe(450 * 1024);
    expect(DEFAULT_MAX_SHARE_BATCH_BYTES).toBeLessThan(512 * 1024);
  });

  it('splits grouped assets when batch byte estimate exceeds threshold', () => {
    const asset = (id: string, size: number) => ({
      rootEntity: id,
      quads: [{ subject: id, predicate: 'urn:test:data', object: JSON.stringify('x'.repeat(size)), graph: '' }],
    });
    const batches = batchAssetsByEstimatedBytes([
      asset('urn:test:1', 200),
      asset('urn:test:2', 200),
      asset('urn:test:3', 200),
    ], 350);
    expect(batches).toHaveLength(3);
  });
});
