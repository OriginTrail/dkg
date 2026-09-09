import { describe, expect, it, vi } from 'vitest';
import type { PublicSnapshotMetadata } from '../src/sync/requester/shared-memory-sync.js';
import {
  ManifestBoundSnapshotProgress,
  SelectedManifestBoundSnapshotWalk,
  prepareManifestBoundSnapshotWalk,
} from '../src/sync/requester/manifest-bound-snapshot-walk.js';
import { PrivateSwmSnapshotWalkCoordinator } from
  '../src/sync/requester/private-swm-snapshot-walk-registry.js';
import { createSyncWorkAdmission } from '../src/sync/work-admission.js';

const manifest: readonly PublicSnapshotMetadata[] = [
  { ref: 'a', digest: 'digest-a', count: 1 },
  { ref: 'b', digest: 'digest-b', count: 2 },
];

const progress = () => new ManifestBoundSnapshotProgress(manifest, {
  now: () => 100,
  retentionTtlMs: 1_000,
});

describe('manifest-bound snapshot progress core', () => {
  it.each([
    ['ref', [{ ...manifest[0]!, ref: 'changed' }, manifest[1]!]],
    ['digest', [{ ...manifest[0]!, digest: 'changed' }, manifest[1]!]],
    ['count', [{ ...manifest[0]!, count: 99 }, manifest[1]!]],
    ['order', [manifest[1]!, manifest[0]!]],
  ] as const)('rejects retained evidence when %s changes', (_change, changed) => {
    const state = progress();
    state.markResolved('a');
    expect(state.matches(changed)).toBe(false);
    expect(state.resolvedCount()).toBe(1);
  });

  it('owns only immutable manifest identity, progress, invalidation, and expiry', () => {
    const state = progress();
    state.markResolved('a');
    expect(state.isResolved('a')).toBe(true);
    expect(state.incomplete).toBe(true);
    state.invalidateResolved('a');
    expect(state.resolvedRefsSnapshot()).toEqual([]);
    expect(Object.isFrozen(state.orderedManifestSnapshot())).toBe(true);
  });

  it('compares unusual strings without delimiter collisions', () => {
    const state = new ManifestBoundSnapshotProgress([
      { ref: 'a\u0000b', digest: 'c', count: 1 },
    ], { now: () => 100, retentionTtlMs: 1_000 });
    expect(state.matches([
      { ref: 'a', digest: 'b\u0000c', count: 1 },
    ])).toBe(false);
  });

  it.each([0, Infinity])('rejects an unusable retention TTL %s', retentionTtlMs => {
    expect(() => new ManifestBoundSnapshotProgress(manifest, {
      now: () => 100,
      retentionTtlMs,
    })).toThrow(RangeError);
  });
});

describe('selected snapshot-walk adapter', () => {
  it('preserves manifest order and immutable suppressed rows', () => {
    const rows = [{
      subject: 'urn:s', predicate: 'urn:p', object: '"original"', graph: 'urn:g',
    }];
    const walk = new SelectedManifestBoundSnapshotWalk(manifest, {
      now: () => 100,
      retentionTtlMs: 1_000,
    });
    walk.markResolved('a', rows);
    rows[0]!.object = '"changed"';
    const plan = walk.prepare({ order: 'manifest', canReuseResolved: () => true });
    expect(plan.snapshots.map(({ ref }) => ref)).toEqual(['a', 'b']);
    expect(plan.reusableRefs.includes('a')).toBe(true);
    expect(walk.suppressedMetadataRows('a')[0]!.object).toBe('"original"');
    walk.invalidateResolved('a');
    expect(walk.suppressedMetadataRows('a')).toEqual([]);
  });

  it('owns selected mutation fencing and completion release', () => {
    let canMutate = false;
    const onComplete = vi.fn();
    const walk = new SelectedManifestBoundSnapshotWalk(manifest, {
      now: () => 100,
      retentionTtlMs: 1_000,
      canMutate: () => canMutate,
      onComplete,
    });
    walk.markResolved('a');
    expect(walk.resolvedCount()).toBe(0);
    canMutate = true;
    walk.markResolved('a');
    walk.markResolved('b');
    expect(walk.expiresAtMs).toBe(0);
    expect(onComplete).toHaveBeenCalledOnce();
  });
});

describe('private snapshot-walk coordinator', () => {
  it('returns an unresolved-first plan, then revalidates retained refs', async () => {
    const state = progress();
    state.markResolved('a');
    const coordinator = new PrivateSwmSnapshotWalkCoordinator(state);
    const admission = createSyncWorkAdmission(
      () => 1_000,
      { sharing: 'exclusive', owner: 'private-test' },
    );
    const unresolved = await coordinator.prepare({
      workAdmission: admission,
      validateRef: async () => true,
    });
    expect(unresolved.kind).toBe('prepared');
    if (unresolved.kind !== 'prepared') throw new Error('Expected prepared walk');
    expect(unresolved.plan.snapshots.map(({ ref }) => ref)).toEqual(['b', 'a']);
    expect(unresolved.plan.reusableRefs.includes('a')).toBe(false);

    coordinator.markResolved('b');
    const revalidated = await coordinator.prepare({
      workAdmission: admission,
      validateRef: async ref => ref === 'a',
    });
    expect(revalidated.kind).toBe('prepared');
    if (revalidated.kind !== 'prepared') throw new Error('Expected prepared walk');
    expect(revalidated.plan.reusableRefs.includes('a')).toBe(true);
    expect(coordinator.isResolved('b')).toBe(false);
  });

  it('returns local yield and invalidates unvalidated retained evidence', async () => {
    const state = progress();
    state.markResolved('a');
    state.markResolved('b');
    const coordinator = new PrivateSwmSnapshotWalkCoordinator(state);
    let remaining = 1;
    const result = await coordinator.prepare({
      workAdmission: createSyncWorkAdmission(
        () => remaining,
        { sharing: 'exclusive', owner: 'bounded-validation' },
      ),
      validateRef: async () => {
        remaining = 0;
        return true;
      },
    });
    expect(result).toEqual({ kind: 'local-budget-yield', validatedRefs: 1 });
    expect(coordinator.resolvedCount()).toBe(1);
  });
});

it('prepares plans without adding owner policy to the progress core', () => {
  const state = progress();
  state.markResolved('a');
  const plan = prepareManifestBoundSnapshotWalk(state, {
    order: 'unresolved-first',
    canReuseResolved: () => false,
  });
  expect(plan.snapshots.map(({ ref }) => ref)).toEqual(['b', 'a']);
  expect(plan.reusableRefs.includes('a')).toBe(false);
});

it.each(['progress', 'evidence'])('captures reusable decisions before later %s changes', change => {
  const state = progress();
  state.markResolved('a');
  let verified = true;
  const canReuseResolved = vi.fn(() => verified);
  const plan = prepareManifestBoundSnapshotWalk(state, { order: 'unresolved-first', canReuseResolved });
  if (change === 'progress') { state.invalidateResolved('a'); state.markResolved('b'); }
  else verified = false;
  expect(plan.snapshots.map(({ ref }) => ref)).toEqual(['b', 'a']);
  expect(plan.reusableRefs.includes('a')).toBe(true);
  expect(plan.reusableRefs.includes('b')).toBe(false);
  expect(canReuseResolved).toHaveBeenCalledOnce();
  expect(Object.isFrozen(plan.reusableRefs)).toBe(true);
  expect(() => Reflect.set(plan.reusableRefs, 0, "mutated")).not.toThrow();
  expect(plan.reusableRefs).toEqual(["a"]);
});
