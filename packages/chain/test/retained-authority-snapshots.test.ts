// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { retainedAuthorityReaderFixture } from './helpers/retained-authority-reader.js';

const absent = `0x${'12'.repeat(32)}`;

describe('retained-only finalized authority snapshots', () => {
  it('serves present names and bounded proven absence without a provider read', async () => {
    const fixture = retainedAuthorityReaderFixture();
    try {
      await fixture.reader.resolveFinalizedContextGraphIdByNameHash!(fixture.presentNameHash);
      fixture.providerRead.mockClear();
      const served = vi.fn();
      const read = fixture.reader.peekFinalizedContextGraphAuthoritySnapshotsByNameHashes!.bind(fixture.reader);
      expect((await read([fixture.presentNameHash], { onContextGraphAuthorityProjectionServed: served }))?.get(fixture.presentNameHash))
        .toMatchObject({ contextGraphId: '7' });
      expect(await read([absent], { freshness: 'bounded' })).toEqual(new Map());
      expect(await read([absent], { freshness: 'live' })).toBeUndefined();
      expect(await read([])).toEqual(new Map());
      expect(served).toHaveBeenCalledWith(expect.objectContaining({ source: 'log' }));
      expect(fixture.providerRead).not.toHaveBeenCalled();
    } finally { await fixture.reader.snapshots.close(); }
  });

  it.each(['cold', 'expired', 'invalidated', 'cleared'] as const)('returns an unproven miss for %s evidence without refreshing', async (condition) => {
    const fixture = retainedAuthorityReaderFixture();
    try {
      if (condition !== 'cold') {
        await fixture.reader.resolveFinalizedContextGraphIdByNameHash!(fixture.presentNameHash);
        if (condition === 'expired') fixture.advanceTime(30000);
        if (condition === 'invalidated') fixture.invalidateAnchor();
        if (condition === 'cleared') fixture.index.clear();
      }
      fixture.providerRead.mockClear();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await fixture.reader.peekFinalizedContextGraphAuthoritySnapshotsByNameHashes!([absent], { freshness: 'bounded' }))
          .toBeUndefined();
      }
      expect(fixture.providerRead).not.toHaveBeenCalled();
    } finally { await fixture.reader.snapshots.close(); }
  });

  it('honors caller cancellation and a closed reader before reading retained state', async () => {
    const fixture = retainedAuthorityReaderFixture();
    const signal = AbortSignal.abort(new Error('caller cancelled'));
    await expect(fixture.reader.peekFinalizedContextGraphAuthoritySnapshotsByNameHashes!([absent], { signal }))
      .rejects.toThrow('caller cancelled');
    await fixture.reader.snapshots.close();
    await expect(fixture.reader.peekFinalizedContextGraphAuthoritySnapshotsByNameHashes!([absent]))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fixture.providerRead).not.toHaveBeenCalled();
  });
});
