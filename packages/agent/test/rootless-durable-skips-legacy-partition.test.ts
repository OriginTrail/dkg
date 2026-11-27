import { describe, expect, it, vi } from 'vitest';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';

const { legacyPartition } = vi.hoisted(() => ({
  legacyPartition: vi.fn(() => {
    throw new Error('legacy entity partitioner must not run for a rootless-only batch');
  }),
}));

vi.mock('@origintrail-official/dkg-publisher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-publisher')>();
  return { ...actual, skolemizeByEntity: legacyPartition };
});

import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-publisher';
import { selectVerifiedDurableSyncQuads } from '../src/sync/durable-integrity.js';

describe('rootless durable legacy partition bypass', () => {
  it('does not build the quadratic legacy entity index for a rootless-only batch', () => {
    const contextGraphId = 'rootless-only-bypass';
    const ual = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/1';
    const scope = createGraphKnowledgeAssetScope(ual, '1');
    const graph = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.VerifiableMemory,
      scope,
    );
    const data: Quad[] = Array.from({ length: 64 }, (_, index) => ({
      subject: `urn:rootless:entity:${index}`,
      predicate: 'urn:rootless:value',
      object: `"${index}"`,
      graph,
    }));
    const meta = generateGraphKnowledgeAssetMetadata({
      ual,
      contextGraphId,
      merkleRoot: computeFlatKCRootV10(data, []),
      publisherPeerId: 'peer-a',
      accessPolicy: 'allowList',
      timestamp: new Date(0),
      assertionVersion: '1',
      publicTripleCount: data.length,
      privateTripleCount: 0,
      assertionGraph: graph,
    }, { status: 'tentative' });

    const result = selectVerifiedDurableSyncQuads(data, meta, false, {
      kind: 'changelogPage',
      changedDataGraphs: new Set([graph]),
    });

    expect(result.rejected).toBe(0);
    expect(result.dataIndexes).toHaveLength(data.length);
    expect(result.verifiedGraphScopedDataGraphs).toEqual([graph]);
    expect(legacyPartition).not.toHaveBeenCalled();
  });
});
