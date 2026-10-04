import { describe, expect, it, vi } from 'vitest';
import { commitRecoveredSwmAsset } from '../src/internal/swm-recovery/swm-recovery-commit.js';
import type { SharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import { parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import { swmFixtures } from './swm-descriptor-fixtures.js';

describe('already completed SWM asset', () => {
  it('withholds its settled provider rows without re-entering mutation admission', async () => {
    const fixture = swmFixtures('completed-asset').share({ version: 1, operationId: 'done', marker: 'done',
      ual: 'did:dkg:31337/0x1111111111111111111111111111111111111111/1' });
    const descriptor = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: 'completed-asset', metaQuads: fixture.meta })[0]!;
    const lock = vi.fn(async () => { throw new Error('completed asset requested a mutation lock'); });
    const insertMetadata = vi.fn();
    const result = await commitRecoveredSwmAsset({ contextGraphId: 'completed-asset',
      asset: { kind: 'already-replaced', descriptor },
      materializer: { withKaWriteLock: lock } as unknown as SharedMemorySnapshotMaterializer, insertMetadata });
    expect(result).toEqual({ kind: 'committed', insertedGraphQuads: 0, insertedMetaQuads: 0, withholdRows: descriptor.metadataQuads });
    expect(lock).not.toHaveBeenCalled();
    expect(insertMetadata).not.toHaveBeenCalled();
  });
});
