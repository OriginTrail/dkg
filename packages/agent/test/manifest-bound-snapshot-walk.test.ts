import { describe, expect, it } from 'vitest';
import type { PublicSnapshotMetadata } from '../src/sync/requester/shared-memory-sync.js';
import {
  ManifestBoundSnapshotWalk,
  SuppressedMetadataManifestBoundSnapshotWalk,
} from '../src/sync/requester/manifest-bound-snapshot-walk.js';

const manifest: readonly PublicSnapshotMetadata[] = [
  { ref: 'a', digest: 'digest-a', count: 1 },
  { ref: 'b', digest: 'digest-b', count: 2 },
];

const implementations = [
  ['private', ManifestBoundSnapshotWalk],
  ['selected', SuppressedMetadataManifestBoundSnapshotWalk],
] as const;

describe.each(implementations)('%s manifest-bound snapshot walk contract', (_owner, Walk) => {
  const create = () => new Walk(manifest, {
    now: () => 100,
    retentionTtlMs: 1_000,
  });

  it.each([
    ['ref', [{ ...manifest[0]!, ref: 'changed' }, manifest[1]!]],
    ['digest', [{ ...manifest[0]!, digest: 'changed' }, manifest[1]!]],
    ['count', [{ ...manifest[0]!, count: 99 }, manifest[1]!]],
    ['order', [manifest[1]!, manifest[0]!]],
  ] as const)('invalidates retained evidence when %s changes', (_change, changed) => {
    const walk = create();
    walk.markResolved('a');

    expect(walk.matches(changed)).toBe(false);
    expect(walk.resolvedCount()).toBe(1);
  });

  it('shares the same resolution and invalidation state machine', () => {
    const walk = create();
    walk.markResolved('a');
    expect(walk.isResolved('a')).toBe(true);
    expect(walk.incomplete).toBe(true);

    walk.invalidateResolved('a');
    expect(walk.isResolved('a')).toBe(false);
    expect(walk.resolvedCount()).toBe(0);
  });
});
