// SPDX-License-Identifier: Apache-2.0
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { RecipientKeyRouteFence } from '../src/internal/recipient-key-route-fence.js';
import { RecipientKeyCollect } from '../src/internal/recipient-key-collect.js';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const graph = 'urn:keys';
const quad = (agent = A, fragment = ''): Quad => ({ subject: `did:dkg:agent:${agent}${fragment}`,
  predicate: DKG_ONTOLOGY.DKG_PEER_ID, object: '"peer"', graph });
const store = new OxigraphStore();
afterAll(() => store.close());
async function ready() { const fence = new RecipientKeyRouteFence(store); await fence.ensureReady(); return fence; }

describe('recipient dependencies stay scoped to the roster', () => {
  it('keeps a member memo through another agent\'s pending and completed writes', async () => {
    const fence = await ready();
    const load = vi.fn(async () => []);
    const collect = new RecipientKeyCollect(fence, load);
    await collect.resolve(A);
    const revision = fence.revision;
    const settle = fence.begin({ quads: [quad(B)] });
    expect(fence.hasPendingWrites).toBe(true);
    expect(fence.isCurrentFor(revision, [A])).toBe(true);
    expect(fence.isCurrentFor(revision, [B])).toBe(false);
    await collect.resolve(A);
    settle('changed');
    expect(fence.isCurrentFor(revision, [A])).toBe(true);
    expect(fence.isCurrentFor(revision, [B])).toBe(false);
    await collect.resolve(A);
    expect(load).toHaveBeenCalledOnce();
  });

  it.each(['', '#x25519-key'])('invalidates a member\'s own subject%s including case variants', async fragment => {
    const fence = await ready(); const revision = fence.revision;
    fence.noteQuads([quad(`0x${'A'.repeat(40)}`, fragment)]);
    expect(fence.isCurrentFor(revision, [A])).toBe(false);
    expect(fence.isCurrentFor(revision, [B])).toBe(true);
  });

  it.each(['changed', 'indeterminate', 'unchanged'] as const)('handles %s settlement of an exact member removal', async outcome => {
    const fence = await ready(); fence.noteQuads([quad()]); const revision = fence.revision;
    const settle = fence.begin({ removals: [{ graph, subject: quad().subject }] });
    expect(fence.isCurrentFor(revision, [A])).toBe(false);
    expect(fence.isCurrentFor(revision, [B])).toBe(true);
    settle(outcome);
    expect(fence.isCurrentFor(revision, [A])).toBe(outcome === 'unchanged');
    if (outcome === 'indeterminate') expect(fence.cacheableFor([A])).toBe(false);
  });

  it.each([
    { everything: true },
    { quads: [{ ...quad(B), subject: '_:unknown' }] },
    { quads: [{ ...quad(B), subject: `<${quad(B).subject}>` }] },
    { quads: [{ ...quad(B), graph: 'invalid graph' }] },
    { quads: [{ ...quad(B), predicate: 'invalid predicate' }] },
  ])('fails closed for an unclassified write: %j', async mutation => {
    const fence = await ready(); const revision = fence.revision;
    const settle = fence.begin(mutation);
    expect(fence.isCurrentFor(revision, [A])).toBe(false);
    settle('changed');
    expect(fence.isCurrentFor(revision, [A])).toBe(false);
  });

  it('keeps graph-wide removal and shared dependency writes global', async () => {
    const fence = await ready(); fence.noteQuads([quad(A), quad(B)]);
    const revision = fence.revision;
    const settle = fence.begin({ removals: [{ graph }] });
    expect(fence.isCurrentFor(revision, [A])).toBe(false);
    settle('changed');
    expect(fence.isCurrentFor(revision, [B])).toBe(false);
  });

  it('invalidates a formerly harmless pending removal when its graph acquires a key', async () => {
    const fence = await ready();
    const settle = fence.begin({ removals: [{ graph }] });
    const revision = fence.revision;
    expect(fence.isCurrentFor(revision, [A])).toBe(true);
    fence.noteQuads([quad(B)]);
    expect(fence.isCurrentFor(revision, [A])).toBe(false);
    settle('changed');
    expect(fence.isCurrentFor(revision, [A])).toBe(false);
  });

  it('bounds invalidation history and refuses snapshots older than retained evidence', async () => {
    const fence = await ready(); const revision = fence.revision;
    for (let i = 0; i < 513; i++) fence.noteQuads([quad(B)]);
    expect(fence.isCurrentFor(revision, [A])).toBe(false);
    expect(fence.isCurrentFor(fence.revision, [A])).toBe(true);
  });

  it.each(['changed', 'unchanged', 'indeterminate'] as const)('tracks overlapping writes until a mixed removal settles %s', async outcome => {
    const fence = await ready();
    const settle = fence.begin({
      quads: [{ ...quad(B), graph: 'urn:other-keys' }],
      removals: [{ graph, subject: quad(A).subject }],
    });
    expect(fence.isCurrentFor(fence.revision, [A])).toBe(true);
    fence.noteQuads([quad(A)]);
    expect(fence.isCurrentFor(fence.revision, [A])).toBe(false);
    const settleOther = fence.begin({ quads: [quad(B)] });
    settle(outcome);
    settle(outcome);
    expect(fence.hasPendingWrites).toBe(true);
    expect(fence.cacheable).toBe(false);
    settleOther('unchanged');
    expect(fence.hasPendingWrites).toBe(false);
    expect(fence.cacheable).toBe(outcome !== 'indeterminate');
    expect(fence.isCurrentFor(fence.revision, [A])).toBe(true);
  });

  it('invalidates every agent named in one mutation but preserves an unrelated agent', async () => {
    const fence = await ready(); const revision = fence.revision;
    const third = `0x${'c'.repeat(40)}`;
    const settle = fence.begin({ quads: [quad(A), quad(B)] });
    for (const agent of [A, B]) expect(fence.isCurrentFor(revision, [agent])).toBe(false);
    expect(fence.isCurrentFor(revision, [third])).toBe(true);
    settle('changed');
    for (const agent of [A, B]) expect(fence.isCurrentFor(revision, [agent])).toBe(false);
    expect(fence.isCurrentFor(revision, [third])).toBe(true);
  });

  it.each([false, true])('blocks a pending removal after an indeterminate opaque write (mixed: %s)', async mixed => {
    const isolated = new OxigraphStore();
    try {
      const fence = new RecipientKeyRouteFence(isolated);
      await fence.ensureReady();
      const removal = fence.begin({ removals: [{ graph }],
        ...(mixed ? { quads: [{ ...quad(A), graph: 'urn:other-keys' }] } : {}) });
      expect(fence.isCurrentFor(fence.revision, [B])).toBe(true);
      const opaque = fence.begin({ everything: true });
      // An UPDATE can commit without reporting a determinate outcome to its caller.
      await isolated.insert([quad(B)]);
      opaque('indeterminate');
      await fence.ensureReady();
      const snapshot = fence.revision;
      expect(await isolated.countQuads(graph)).toBe(1);
      expect(fence.hasPendingWrites).toBe(true);
      expect(fence.isCurrentFor(snapshot, [B])).toBe(false);
      removal('unchanged');
      expect(fence.hasPendingWrites).toBe(false);
      expect(fence.isCurrentFor(fence.revision, [B])).toBe(true);
      expect(fence.cacheableFor([B])).toBe(false);
    } finally { await isolated.close(); }
  });

  it('reuses unrelated snapshots once a fresh scan proves the watched graph harmless again', async () => {
    const fence = await ready();
    const removal = fence.begin({ quads: [{ ...quad(A), graph: 'urn:other-keys' }], removals: [{ graph }] });
    fence.begin({ everything: true })('changed');
    expect(fence.isCurrentFor(fence.revision, [B])).toBe(false);
    await fence.ensureReady();
    expect(fence.isCurrentFor(fence.revision, [B])).toBe(true);
    expect(fence.isCurrentFor(fence.revision, [A])).toBe(false);
    removal('unchanged');
  });

  it('falls back to global invalidation for oversized scopes and unclassified rosters', async () => {
    const fence = await ready(); const revision = fence.revision;
    const settle = fence.begin({ quads: Array.from({ length: 129 }, (_, i) => quad(`0x${i.toString(16).padStart(40, '0')}`)) });
    expect(fence.isCurrentFor(revision, [A])).toBe(false);
    settle('changed');
    expect(fence.isCurrentFor(revision, [A])).toBe(false);
    const after = fence.revision;
    fence.noteQuads([quad(B)]);
    for (const roster of [[], ['unknown']]) expect(fence.isCurrentFor(after, roster)).toBe(false);
  });
});
