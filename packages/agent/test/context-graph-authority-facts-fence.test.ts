// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_CONTEXT_GRAPHS, contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import { captureContextGraphAuthorityFactsFence } from '../src/internal/context-graph-authority/context-graph-authority-facts-fence.js';

function pendingCandidates(projection: ContextGraphMetaProjection) {
  let release!: (ids: ReadonlySet<string>) => void;
  const pending = new Promise<ReadonlySet<string>>((resolve) => { release = resolve; });
  vi.spyOn(projection, 'findContextGraphIdsWithReadAuthorityFacts').mockReturnValue(pending);
  return release;
}

describe('owned context-graph authority facts fences', () => {
  it('keeps unrelated writes retry-free but retires target and unseen shared-source proofs', () => {
    const projection = new ContextGraphMetaProjection({} as TripleStore);
    const target = captureContextGraphAuthorityFactsFence(projection, 'target');
    projection.markDirtyForGraph(contextGraphMetaGraphUri('other'));
    projection.markDirtyForGraph('urn:dkg:local:join-encryption-key-cache');
    expect(target.assertCurrent()).toBe(true);
    projection.markDirtyForGraph(contextGraphMetaGraphUri('target'));
    expect(target.assertCurrent()).toBe(false);

    const unseen = captureContextGraphAuthorityFactsFence(projection, 'unseen');
    projection.markDirtyForGraph(contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS));
    expect(unseen.assertCurrent()).toBe(false);
  });

  it('fences an absence read across its await and owns its captured candidate set', async () => {
    const projection = new ContextGraphMetaProjection({} as TripleStore);
    const release = pendingCandidates(projection);
    const snapshotRead = projection.prepareReadAuthorityFactsSnapshot(['target', 'other']);
    projection.markDirty('other');
    const candidates = new Set(['target']);
    release(candidates);
    const snapshot = await snapshotRead;
    expect(snapshot.assertCurrent()).toBe(false);
    expect(snapshot.isAbsent('target')).toBe(false);
    expect(snapshot.isAbsent('other')).toBe(true);
    candidates.clear();
    candidates.add('other');
    expect(snapshot.isAbsent('target')).toBe(false);
    expect(snapshot.isAbsent('other')).toBe(true);

    const fresh = await projection.prepareReadAuthorityFactsSnapshot(['target', 'other']);
    expect(fresh.assertCurrent()).toBe(true);
    projection.markDirty('target');
    expect(fresh.assertCurrent()).toBe(false);
  });

  it('never returns an absence proof after cancellation during the candidate read', async () => {
    const projection = new ContextGraphMetaProjection({} as TripleStore);
    const release = pendingCandidates(projection);
    const controller = new AbortController();
    const read = projection.prepareReadAuthorityFactsSnapshot(['target'], { signal: controller.signal });
    const retired = new Error('request retired while inventory was loading');
    controller.abort(retired);
    release(new Set());
    await expect(read).rejects.toBe(retired);
  });
});
