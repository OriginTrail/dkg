import { describe, expect, it } from 'vitest';
import { normalizePublicSnapshotSyncOptions } from '../src/public-snapshot-options.js';
import { PublicSnapshotMethods } from '../src/dkg-agent-public-snapshot.js';
const request = { contextGraphId: 'test', onChainId: '1', trustedCorePeerIds: ['core'] };
describe('snapshot domain options', () => {
  it('normalizes default mode and duplicate peers before enforcing the distinct supplier bound', () => {
    expect(normalizePublicSnapshotSyncOptions({ ...request, trustedCorePeerIds: Array(5).fill('core') }))
      .toEqual({ ...request, mode: 'core-cache' });
  });
  it.each([null, [], { mode: 'unknown' }, { contextGraphId: '../bad' }, { onChainId: '0' },
    { trustedCorePeerIds: 'core' }, { trustedCorePeerIds: [] }, { trustedCorePeerIds: [1] },
    { trustedCorePeerIds: ['a', 'b', 'c', 'd', 'e'] }])('rejects malformed options before any job access: %j', async patch => {
    const input = patch === null || Array.isArray(patch) ? patch : { ...request, ...patch };
    expect(() => normalizePublicSnapshotSyncOptions(input)).toThrow();
    await expect(PublicSnapshotMethods.prototype.syncPublicGraphSnapshot.call({} as never, input as never))
      .rejects.toThrow(/Invalid snapshot job|one to four/);
  });
});
