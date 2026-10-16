import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizePublicSnapshotSyncOptions } from '../src/public-snapshot-options.js';
import { PublicSnapshotMethods } from '../src/dkg-agent-public-snapshot.js';
afterEach(() => vi.unstubAllEnvs());
const request = { contextGraphId: 'test', onChainId: '1', trustedCorePeerIds: ['core'] };
describe('snapshot domain options', () => {
  it('normalizes default mode and duplicate peers before enforcing the distinct supplier bound', () => {
    expect(normalizePublicSnapshotSyncOptions({ ...request, trustedCorePeerIds: Array(5).fill('core') }))
      .toEqual({ ...request, mode: 'core-cache', transport: 'exact' });
  });
  it('normalizes environment defaults while honoring explicit transport', () => {
    vi.stubEnv('DKG_PUBLIC_SNAPSHOT_BULK', '1');
    expect(normalizePublicSnapshotSyncOptions(request).transport).toBe('bulk');
    expect(normalizePublicSnapshotSyncOptions({...request,transport:'exact'}).transport).toBe('exact');
  });
  it.each([null, [], { mode: 'unknown' }, { transport: 'unknown' }, { contextGraphId: '../bad' }, { onChainId: '0' },
    { trustedCorePeerIds: 'core' }, { trustedCorePeerIds: [] }, { trustedCorePeerIds: [1] },
    { trustedCorePeerIds: ['a', 'b', 'c', 'd', 'e'] }])('rejects malformed options before any job access: %j', async patch => {
    const input = patch === null || Array.isArray(patch) ? patch : { ...request, ...patch };
    expect(() => normalizePublicSnapshotSyncOptions(input)).toThrow();
    await expect(PublicSnapshotMethods.prototype.syncPublicGraphSnapshot.call({} as never, input as never))
      .rejects.toThrow(/Invalid snapshot job|one to four/);
  });
});
