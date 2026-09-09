import { describe, expect, it, vi } from 'vitest';
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

  it('compares unusual ref and digest strings without delimiter collisions', () => {
    const unusual = new Walk([
      { ref: 'a\u0000b', digest: 'c', count: 1 },
    ], {
      now: () => 100,
      retentionTtlMs: 1_000,
    });

    expect(unusual.matches([
      { ref: 'a', digest: 'b\u0000c', count: 1 },
    ])).toBe(false);
  });
});


describe.each(implementations)('%s prepared snapshot walk', (_owner, Walk) => {
  it('owns unresolved-first ordering without changing selected manifest order', () => {
    const walk = new Walk(manifest, { now: () => 100, retentionTtlMs: 1_000 });
    walk.markResolved('a');
    const selected = walk.prepare({ order: 'manifest', canReuseResolved: () => true });
    const privateRecovery = walk.prepare({ order: 'unresolved-first', canReuseResolved: () => false });
    expect(selected.snapshots.map(({ ref }) => ref)).toEqual(['a', 'b']);
    expect(privateRecovery.snapshots.map(({ ref }) => ref)).toEqual(['b', 'a']);
    expect(walk.orderedManifestSnapshot().map(({ ref }) => ref)).toEqual(['a', 'b']);
    expect(selected.canReuse('a')).toBe(true);
    expect(privateRecovery.canReuse('a')).toBe(false);
    expect(Object.isFrozen(privateRecovery.snapshots)).toBe(true);
  });

  it('requires both owner approval and live resolved evidence before reuse', () => {
    const walk = new Walk(manifest, { now: () => 100, retentionTtlMs: 1_000 });
    walk.markResolved('a');
    const prepared = walk.prepare({ order: 'manifest', canReuseResolved: ref => ref === 'a' || ref === 'unknown' });
    expect(prepared.canReuse('a')).toBe(true);
    expect(prepared.canReuse('b')).toBe(false);
    expect(prepared.canReuse('unknown')).toBe(false);
    walk.invalidateResolved('a');
    expect(prepared.canReuse('a')).toBe(false);
  });
});


describe.each(implementations)('%s walk lifecycle boundaries', (_owner, Walk) => {
  it.each([0, Infinity])('rejects an unusable retention TTL %s', retentionTtlMs => {
    expect(() => new Walk(manifest, { now: () => 100, retentionTtlMs })).toThrow(RangeError);
  });

  it('honors the owner mutation fence and releases a completed walk exactly once', () => {
    let canMutate = false;
    const onComplete = vi.fn();
    const walk = new Walk(manifest, { now: () => 100, retentionTtlMs: 1_000, canMutate: () => canMutate, onComplete });
    walk.markResolved('a');
    expect(walk.resolvedCount()).toBe(0);
    canMutate = true;
    walk.markResolved('a');
    canMutate = false;
    walk.invalidateResolved('a');
    expect(walk.isResolved('a')).toBe(true);
    canMutate = true;
    walk.markResolved('b');
    walk.markResolved('b');
    expect(walk.expiresAtMs).toBe(0);
    expect(onComplete).toHaveBeenCalledOnce();
  });
});

it('keeps selected suppression metadata immutable while private walks retain no rows', () => {
  const rows = [{ subject: 'urn:s', predicate: 'urn:p', object: '"original"', graph: 'urn:g' }];
  const selected = new SuppressedMetadataManifestBoundSnapshotWalk(manifest, { now: () => 100, retentionTtlMs: 1_000 });
  selected.markResolved('a', rows);
  rows[0]!.object = '"changed"';
  expect(selected.suppressedMetadataRows('a')[0]!.object).toBe('"original"');
  selected.invalidateResolved('a');
  expect(selected.suppressedMetadataRows('a')).toEqual([]);
  const privateWalk = new ManifestBoundSnapshotWalk(manifest, { now: () => 100, retentionTtlMs: 1_000 });
  privateWalk.markResolved('a', rows);
  expect(privateWalk.suppressedMetadataRows('a')).toEqual([]);
});
