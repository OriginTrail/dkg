import { overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1 } from '@origintrail-official/dkg-publisher';
import { describe, expect, it, vi } from 'vitest';
import type { ContextGraphSub } from '../src/dkg-agent-types.js';
import { getSyncCheckpointKey, MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { createGraphScopedDurableManifestPlan } from '../src/sync/durable-integrity.js';
import { classifyDurableProgress } from '../src/sync/durable-progress.js';
import { readHeldGraphScopedAssets } from '../src/sync/requester/stored-graph-assets.js';
import { CG, PEER, SECOND_PEER, asset, servingPeer, node, generation, rowsOf } from './_helpers/durable-recovery-store.js';

import { deleteSyncPageCheckpoint } from '../src/sync/requester/page-fetch.js';
import type { AssetFixture } from './_helpers/durable-recovery-store.js';

describe('cross-peer recovery keeps the actually stored prefix', () => {
  it.each(['clean', 'deleted', 'corrupted', 'metadata', 'during-verification', 'during-store'].flatMap(change => [false, true].map(samePeer => ({ change, samePeer }))))('checks a live checkpoint after $change (same peer: $samePeer)', async ({ change, samePeer }) => {
    const fixtures = generation();
    const a = servingPeer(fixtures), b = servingPeer(fixtures);
    let running = true, first = true, activePeer = PEER, changed = false;
    let prefix: AssetFixture;
    const mutate = async () => {
      if (first || changed) return;
      changed = true;
      await core.store.dropGraph(prefix.graph);
    };
    const core = node({ [PEER]: a, [SECOND_PEER]: b }, { holdingsShortcut: false,
      beforeVerify: change === 'during-verification' ? mutate : undefined,
      afterAssetStore: change === 'during-store' ? mutate : undefined,
    });
    const lifetime = core.start({ exactRequests: false, sliceSpent: () => first,
      isRunning: () => running, peerIds: () => [activePeer],
      afterSlice: () => { if (first) running = false; },
    });
    const partial = await lifetime.recover();
    expect(partial.outcome).toBe('no-progress');
    const sourceKey = getSyncCheckpointKey(PEER, CG, false, 'data');
    const checkpoint = lifetime.checkpointStore.get(sourceKey)!;
    expect(checkpoint.offset).toBeGreaterThan(0);
    expect(checkpoint.offset).toBeLessThan(rowsOf(fixtures));
    expect(checkpoint.terminal).not.toBe(true);
    prefix = fixtures.find(fixture => core.writes.includes(fixture.ual))!;
    expect(await core.store.countQuads(prefix.graph)).toBe(prefix.payload.length);
    if (change === 'deleted') await core.store.dropGraph(prefix.graph);
    if (change === 'corrupted') {
      await core.store.delete([prefix.payload[0]!]);
      await core.store.insert([{ ...prefix.payload[0]!, object: '"tampered"' }]);
    }
    if (change === 'metadata') {
      const root = prefix.meta.find(q => q.predicate === 'http://dkg.io/ontology/merkleRoot')!;
      const wrong = { ...root, object: root.object.replace(/[a-f0-9]{64}/i, 'f'.repeat(64)) };
      expect(wrong.object).not.toBe(root.object);
      await core.store.delete([root]); await core.store.insert([wrong]);
      expect(await core.store.countQuads(prefix.graph)).toBe(prefix.payload.length);
      const held = await readHeldGraphScopedAssets(core.store, { contextGraphId: CG,
        descriptors: createGraphScopedDurableManifestPlan(fixtures.flatMap(f => f.meta), CG)!.descriptors });
      expect(held.has(prefix.ual)).toBe(false);
    }
    // Keep the original checkpoint and owner alive; only the serving peer changes.
    expect(lifetime.checkpointStore.get(sourceKey)).toEqual(checkpoint);
    first = false; running = true; activePeer = samePeer ? PEER : SECOND_PEER;
    const recovered = await lifetime.recover();
    expect(recovered.outcome).toBe('terminal');
    expect(recovered.result.complete).toBe(true);
    expect(classifyDurableProgress(recovered.result, { complete: recovered.result.complete }).completedReadinessCleanly).toBe(true);
    const held = await readHeldGraphScopedAssets(core.store, {
      contextGraphId: CG, descriptors: createGraphScopedDurableManifestPlan(fixtures.flatMap(fixture => fixture.meta), CG)!.descriptors,
    });
    expect(held).toEqual(new Set(fixtures.map(fixture => fixture.ual)));
    expect(lifetime.checkpointStore.get(getSyncCheckpointKey(activePeer, CG, false, 'data'))?.terminal).toBe(true);
    // A new peer primes its generation at offset zero, then resumes. The stored
    // prefix must not be materialized again unless its actual content is invalid.
    expect(core.writes.filter(ual => ual === prefix.ual)).toHaveLength(change === 'clean' ? 1 : 2);
    const root = prefix.meta.find(q => q.predicate === 'http://dkg.io/ontology/merkleRoot')!;
    expect(await core.store.query(`ASK { GRAPH <${root.graph}> { <${root.subject}> <${root.predicate}> ${root.object} } }`))
      .toEqual({ type: 'boolean', value: true });
  });
});



describe('resumed-prefix edge cases', () => {
  it('settles mixed public/private manifests without rewriting the proven private prefix', async () => {
    const fixtures = [asset(1), asset(2, '1', true), asset(3), asset(4)];
    const core = node(servingPeer(fixtures), { holdingsShortcut: false });
    let rounds = 0;
    const recovered = await core.start({ exactRequests: false, sliceSpent: true, isRunning: () => rounds < 12, afterSlice: () => { rounds++; } }).recover();
    expect(recovered.outcome).toBe('terminal');
    expect(core.writes).toEqual(fixtures.map(f => f.ual));
    expect(await readHeldGraphScopedAssets(core.store, { contextGraphId: CG,
      descriptors: createGraphScopedDurableManifestPlan(fixtures.flatMap(f => f.meta), CG)!.descriptors }))
      .toEqual(new Set(fixtures.map(f => f.ual)));
  });

  it.each([false, true])('repairs ordinary tokenless resumes (proof unavailable: %s)', async unavailable => {
    const fixtures = generation(); let disableProof = false;
    const core = node(servingPeer(fixtures), { disablePrefixProof: () => disableProof });
    const checkpoints = new MemorySyncCheckpointStore();
    const first = await core.round(checkpoints, PEER, { settlementSliceDeadline: Date.now() });
    expect(first.result.complete).toBe(false);
    const key = getSyncCheckpointKey(PEER, CG, false, 'data');
    const saved = checkpoints.get(key)!;
    expect(saved.offset).toBeGreaterThan(0);
    const prefix = fixtures.find(f => core.writes.includes(f.ual))!;
    await core.store.dropGraph(prefix.graph);
    deleteSyncPageCheckpoint(checkpoints, key);
    checkpoints.setManifestBoundOffset(key, saved.offset, saved.manifestDigest!, saved.updatedAtMs, saved.manifestPrefixDigest);
    disableProof = unavailable;
    let next = await core.round(checkpoints, PEER, {});
    if (!next.result.complete) {
      expect(checkpoints.get(key)?.terminal).not.toBe(true);
      next = await core.round(checkpoints, PEER, {});
    }
    expect(next.result.complete).toBe(true);
    expect(await readHeldGraphScopedAssets(core.store, { contextGraphId: CG,
      descriptors: createGraphScopedDurableManifestPlan(fixtures.flatMap(f => f.meta), CG)!.descriptors }))
      .toEqual(new Set(fixtures.map(f => f.ual)));
  });

  it.each(['generation', 'subscription'])('refuses prefix reuse after %s ownership changes', async change => {
    const fixtures = generation(); let first = true, running = true, bindingGeneration = 0;
    let subscription: ContextGraphSub = { syncMode: 'always-on', subscribed: true, synced: true, onChainId: '323' };
    const core = node(servingPeer(fixtures), { holdingsShortcut: false,
      bindingGeneration: () => bindingGeneration, subscription: () => subscription,
      beforeVerify: async () => {
        if (first) return;
        if (change === 'generation') bindingGeneration++;
        else subscription = { ...subscription };
        running = false;
      },
    });
    const lifetime = core.start({ exactRequests: false, sliceSpent: () => first, isRunning: () => running,
      afterSlice: () => { if (first) running = false; } });
    await lifetime.recover();
    const before = core.writes.length;
    expect(before).toBeGreaterThan(0);
    first = false; running = true;
    const next = await lifetime.recover();
    expect(next.result.complete).toBe(false);
    expect(next.outcome).not.toBe('terminal');
    expect(core.writes).toHaveLength(before);
    expect(lifetime.checkpointStore.get(getSyncCheckpointKey(PEER, CG, false, 'data'))?.terminal).not.toBe(true);
    expect(classifyDurableProgress(next.result, { complete: next.result.complete }).completedReadinessCleanly).toBe(false);
  });
});

it.each(['other-graph', 'other-metadata-subject'])('completes bounded recovery after an unrelated indeterminate write (%s)', async scope => {
  const fixtures = generation();
  const core = node(servingPeer(fixtures), { holdingsShortcut: false });
  if (scope === 'other-graph') {
    vi.spyOn(core.rawStore, 'dropGraph').mockRejectedValueOnce(new Error('lost response'));
    await expect(core.store.dropGraph('urn:unrelated-failed-write')).rejects.toThrow('lost response');
  } else {
    vi.spyOn(core.rawStore, 'insert').mockRejectedValueOnce(new Error('lost response'));
    await expect(core.store.insert([{ ...fixtures[0]!.meta[0]!, subject: 'urn:unrelated-asset' }])).rejects.toThrow('lost response');
  }
  let rounds = 0;
  const result = await core.start({ exactRequests: false, sliceSpent: true, isRunning: () => rounds < 20,
    afterSlice: () => { rounds++; } }).recover();
  expect(result.outcome).toBe('terminal');
  expect(rounds).toBeGreaterThan(1);
  expect(core.writes).toEqual(fixtures.map(f => f.ual));
  expect(await readHeldGraphScopedAssets(core.store, { contextGraphId: CG,
    descriptors: createGraphScopedDurableManifestPlan(fixtures.flatMap(f => f.meta), CG)!.descriptors }))
    .toEqual(new Set(fixtures.map(f => f.ual)));
});

it('continues the prefix between independently materialized replicas', async () => {
  const fixtures = generation();
  const replica = (receivedAt: Date) => fixtures.map(f => ({ ...f,
    meta: overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1(f.meta,
      { ual: f.ual, metaGraph: f.meta[0]!.graph, receivedAt },
      { status: 'confirmed', materializedVersion: { blockNumber: 1, txIndex: 0 },
        confirmation: { kind: 'finalized-materialization' } }),
  }));
  const left = replica(new Date('2026-01-01T00:00:00Z'));
  const right = replica(new Date('2026-02-01T00:00:00Z'));
  expect(left[0]!.meta).not.toEqual(right[0]!.meta);
  const core = node({ [PEER]: servingPeer(left), [SECOND_PEER]: servingPeer(right) }, { holdingsShortcut: false });
  let first = true, running = true, activePeer = PEER;
  const lifetime = core.start({ exactRequests: false, sliceSpent: () => first, isRunning: () => running,
    peerIds: () => [activePeer], afterSlice: () => { if (first) running = false; } });
  await lifetime.recover();
  const prefix = core.writes[0]!;
  expect(lifetime.checkpointStore.get(getSyncCheckpointKey(PEER, CG, false, 'data'))?.offset).toBeGreaterThan(0);
  first = false; running = true; activePeer = SECOND_PEER;
  expect((await lifetime.recover()).outcome).toBe('terminal');
  expect(core.writes.filter(ual => ual === prefix)).toHaveLength(1);
  expect(core.writes).toEqual(fixtures.map(f => f.ual));
});


it.each(['overlapping', 'unknown'])('recovers bounded DATA after confirmed backend replacement (%s uncertain write)', async scope => {
  const fixtures = generation(); let epoch: number | undefined = 0;
  const core = node(servingPeer(fixtures), { recoveryGeneration: () => epoch, holdingsShortcut: false });
  if (scope === 'overlapping') {
    vi.spyOn(core.rawStore, 'dropGraph').mockRejectedValueOnce(new Error('lost response'));
    await expect(core.store.dropGraph(fixtures[0]!.graph)).rejects.toThrow('lost response');
  } else {
    vi.spyOn(core.rawStore, 'update').mockRejectedValueOnce(new Error('lost response'));
    await expect(core.store.update('DELETE WHERE { GRAPH ?g { ?s ?p ?o } }')).rejects.toThrow('lost response');
  }
  let rounds = 0;
  const lifetime = core.start({ exactRequests: false, sliceSpent: true, isRunning: () => rounds < 8, afterSlice: () => { rounds++; } });
  const unsafe = await lifetime.recover();
  expect(unsafe.outcome).not.toBe('terminal');
  expect(unsafe.result.complete).toBe(false);
  epoch = undefined; rounds = 0; // A restart request is still not completion.
  expect((await lifetime.recover()).outcome).not.toBe('terminal');
  // The abandoned old operation can still corrupt the stored prefix before termination.
  await core.rawStore.delete(fixtures[0]!.payload);
  epoch = 1; rounds = 0; // Supervisor confirms old process death and replacement readiness.
  const recovered = await lifetime.recover();
  expect(recovered.outcome).toBe('terminal');
  expect(rounds).toBeGreaterThan(1);
  expect(await readHeldGraphScopedAssets(core.store, { contextGraphId: CG,
    descriptors: createGraphScopedDurableManifestPlan(fixtures.flatMap(f => f.meta), CG)!.descriptors }))
    .toEqual(new Set(fixtures.map(f => f.ual)));
});
