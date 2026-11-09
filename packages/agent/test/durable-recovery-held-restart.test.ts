import { readHeldGraphScopedAssets } from './_helpers/held-asset-membership.js';
import { describe, expect, it } from 'vitest';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { ContextGraphSub } from '../src/dkg-agent-types.js';
import { continueContextGraphSubscriptionLine } from '../src/context-graph-subscription-policy.js';
import { getSyncCheckpointKey } from '../src/sync/checkpoint/state.js';
import { createGraphScopedDurableManifestPlan } from '../src/sync/durable-integrity.js';
import { classifyDurableProgress } from '../src/sync/durable-progress.js';
import { CG, PEER, SECOND_PEER, asset, servingPeer, createRequesterHarness, generation, rowsOf } from './_helpers/durable-recovery-store.js';

describe('a recovery whose rounds outlast their slices', () => {
  it('resumes each round at its settled boundary under a complete manifest', async () => {
    const graph = Array.from({ length: 12 }, (_, index) => asset(index + 1));
    const peer = servingPeer(graph);
    const core = createRequesterHarness(peer);

    // Every round writes past its slice's soft deadline, so it yields at the first settled boundary it can.
    const recovered = await core.start({ sliceSpent: true }).recover();

    expect(recovered.outcome).toBe('terminal');
    expect([...core.writes].sort()).toEqual(graph.map((fixture) => fixture.ual).sort());
    expect(core.info.filter((line) => line.startsWith('Yielding durable recovery')).length).toBeGreaterThan(1);
    expect(await readHeldGraphScopedAssets(core.store, {
      contextGraphId: CG,
      descriptors: createGraphScopedDurableManifestPlan(graph.flatMap((fixture) => fixture.meta), CG)!.descriptors,
    })).toEqual(new Set(graph.map((fixture) => fixture.ual)));
  });
});

describe('cross-peer recovery keeps the actually stored prefix', () => {
  it.each(['clean', 'deleted', 'corrupted'])('checks a live source checkpoint after the prefix is %s', async change => {
    const fixtures = generation();
    const a = servingPeer(fixtures), b = servingPeer(fixtures);
    const core = createRequesterHarness({ [PEER]: a, [SECOND_PEER]: b });
    let running = true, first = true, activePeer = PEER;
    const lifetime = core.start({ sliceSpent: () => first, exactRequests: false,
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
    const prefix = fixtures.find(fixture => core.writes.includes(fixture.ual))!;
    expect(await core.store.countQuads(prefix.graph)).toBe(prefix.payload.length);
    if (change === 'deleted') await core.store.dropGraph(prefix.graph);
    if (change === 'corrupted') {
      await core.store.delete([prefix.payload[0]!]);
      await core.store.insert([{ ...prefix.payload[0]!, object: '"tampered"' }]);
    }
    // Keep the original checkpoint and owner alive; only the serving peer changes.
    expect(lifetime.checkpointStore.get(sourceKey)).toEqual(checkpoint);
    first = false; running = true; activePeer = SECOND_PEER;
    const recovered = await lifetime.recover();
    expect(recovered.outcome).toBe('terminal');
    expect(recovered.result.complete).toBe(true);
    expect(classifyDurableProgress(recovered.result, { complete: recovered.result.complete }).completedReadinessCleanly).toBe(true);
    const held = await readHeldGraphScopedAssets(core.store, {
      contextGraphId: CG, descriptors: createGraphScopedDurableManifestPlan(fixtures.flatMap(fixture => fixture.meta), CG)!.descriptors,
    });
    expect(held).toEqual(new Set(fixtures.map(fixture => fixture.ual)));
    expect(lifetime.checkpointStore.get(getSyncCheckpointKey(SECOND_PEER, CG, false, 'data'))?.terminal).toBe(true);
    // A new peer primes its generation at offset zero, then resumes. The stored
    // prefix must not be materialized again unless its actual content is invalid.
    expect(core.writes.filter(ual => ual === prefix.ual)).toHaveLength(change === 'clean' ? 1 : 2);
  });
});

describe('a restarted Core and a graph it has already recovered', () => {
  it('transfers no DATA rows when the graph is unchanged', async () => {
    const peer = servingPeer(generation());
    const core = createRequesterHarness(peer);

    const first = await core.start().recover();
    expect(first.outcome).toBe('terminal');
    expect(peer.served.dataRows).toBe(rowsOf(generation()));
    expect(core.writes).toHaveLength(6);

    // Restart: no owner memory, and the checkpoints are gone (expired after a day, or another peer).
    peer.served.dataRequests = 0;
    peer.served.dataRows = 0;
    core.writes.length = 0;
    const restarted = core.start();
    const second = await restarted.recover();

    expect(second.outcome).toBe('terminal');
    expect(second.result.complete).toBe(true);
    expect(peer.served.dataRequests).toBe(0);
    expect(peer.served.dataRows).toBe(0);
    expect(core.writes).toEqual([]);
    expect(second.result).toMatchObject({
      fetchedDataTriples: 0, insertedDataTriples: 0, completedPhases: 2, verifiedHeldAssets: 6,
    });
    // The held completion is readiness proof, as inserted data or a private-only response is.
    expect(classifyDurableProgress(second.result, { complete: second.result.complete }).completedReadinessCleanly)
      .toBe(true);
    expect(restarted.checkpointStore.get(getSyncCheckpointKey(PEER, CG, false, 'data')))
      .toMatchObject({ offset: rowsOf(generation()), terminal: true });
    expect(core.info).toContainEqual(expect.stringContaining('already held at this META generation'));
  });

  it.each(['chain', 'verification', 'metadata-store'].flatMap(stage =>
    ['deactivate', 'recreate', 'equivalent', 'delete-assertions'].map(change => ({ stage, change }))))(
    'fences held completion across $change during $stage', async ({ stage, change }) => {
      const peer = servingPeer(generation());
      let subscription: ContextGraphSub | undefined = {
        syncMode: 'always-on', subscribed: true, synced: true, onChainId: '323',
      };
      let entered!: () => void;
      let release!: () => void;
      const paused = new Promise<void>(resolve => { entered = resolve; });
      const resumed = new Promise<void>(resolve => { release = resolve; });
      let pause = false;
      const suspend = async (at: string) => { if (pause && stage === at) { entered(); await resumed; } };
      const core = createRequesterHarness(peer, { lifecycle: { subscription: () => subscription }, chain: { beforeRead: () => suspend('chain') }, mutations: { beforeVerify: () => suspend('verification'), beforeMetaStore: () => suspend('metadata-store') } });
      expect((await core.start().recover()).outcome).toBe('terminal');
      peer.current()[0]!.meta.push({ subject: 'urn:held-restart:lifecycle',
        predicate: 'http://dkg.io/ontology/operationId', object: '"new-operation"',
        graph: peer.current()[0]!.meta[0]!.graph });
      pause = true;
      peer.served.dataRows = 0;
      const restarted = core.start();
      const recovering = restarted.recover();
      await paused;
      if (change === 'delete-assertions') await core.store.dropGraph(peer.current()[0]!.graph);
      else {
        const previous = subscription!;
        if (change === 'recreate') subscription = undefined;
        subscription = { ...previous, ...(change === 'deactivate' ? { subscribed: false } : { synced: false }) };
        if (change !== 'recreate') continueContextGraphSubscriptionLine(previous, subscription);
      }
      release();
      const result = await recovering;
      const terminal = restarted.checkpointStore.get(getSyncCheckpointKey(PEER, CG, false, 'data'))?.terminal === true;
      if (change === 'equivalent') {
        expect(result.outcome).toBe('terminal');
        expect(result.result.verifiedHeldAssets).toBe(6);
        expect(terminal).toBe(true);
      } else {
        expect(result.outcome).not.toBe('terminal');
        expect(result.result.verifiedHeldAssets ?? 0).toBe(0);
        expect(terminal).toBe(false);
        expect(classifyDurableProgress(result.result, { complete: result.result.complete }).completedReadinessCleanly).toBe(false);
      }
      expect(peer.served.dataRows).toBe(0);
    },
  );

  it.each([false, true])('stores new admissible META while skipping held DATA (missing asset: %s)', async (missing) => {
    const graph = generation();
    const peer = servingPeer(graph);
    const core = createRequesterHarness(peer);
    expect((await core.start().recover()).outcome).toBe('terminal');
    const metaGraph = graph[0]!.meta[0]!.graph;
    const additions: Quad[] = [
      { subject: 'urn:held-restart:lifecycle', predicate: 'http://dkg.io/ontology/operationId', object: '"later-operation"', graph: metaGraph },
      { subject: 'urn:held-restart:reports', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: metaGraph },
      { subject: 'urn:held-restart:reports', predicate: 'http://dkg.io/ontology/name', object: '"reports"', graph: metaGraph },
    ];
    graph[0]!.meta.push(...additions);
    if (missing) await core.store.dropGraph(graph[1]!.graph);
    peer.served.dataRows = 0;
    const recovered = await core.start().recover();
    expect(recovered.outcome).toBe('terminal');
    expect(peer.served.dataRows).toBe(missing ? graph[1]!.payload.length : 0);
    for (const quad of additions) {
      const object = quad.object.startsWith('"') ? quad.object : `<${quad.object}>`;
      const result = await core.store.query(`ASK { GRAPH <${quad.graph}> { <${quad.subject}> <${quad.predicate}> ${object} } }`);
      expect(result).toEqual({ type: 'boolean', value: true });
    }
  });

  it('cannot use a held copy from another numeric graph slot as terminal proof', async () => {
    const peer = servingPeer(generation());
    let subscriptionId = '323';
    const core = createRequesterHarness(peer, { lifecycle: { subscriptionId: () => subscriptionId } });
    expect((await core.start().recover()).outcome).toBe('terminal');
    // Both slots commit the same name; the chain name-binding proof still succeeds.
    subscriptionId = '582';
    peer.served.dataRows = 0;
    const restarted = core.start();
    const recovered = await restarted.recover();
    expect(recovered.outcome).not.toBe('terminal');
    expect(recovered.result.verifiedHeldAssets).toBe(0);
    expect(restarted.checkpointStore.get(getSyncCheckpointKey(PEER, CG, false, 'data'))?.terminal).not.toBe(true);
    expect(peer.served.dataRows).toBe(0);
  });

  it('fetches an asset again when its rows were removed and its envelope kept', async () => {
    const peer = servingPeer(generation());
    const core = createRequesterHarness(peer);
    expect((await core.start().recover()).outcome).toBe('terminal');

    // A removed sub-graph drops the rows and keeps the confirmed envelope.
    const dropped = asset(2);
    await core.store.dropGraph(dropped.graph);
    peer.served.dataRows = 0;
    core.writes.length = 0;
    const recovered = await core.start().recover();

    expect(recovered.outcome).toBe('terminal');
    expect(peer.served.dataRows).toBe(dropped.payload.length);
    expect(core.writes).toEqual([dropped.ual]);
  });

  it('recovers from a peer with the current version when the first peer is behind the chain', async () => {
    const behind = servingPeer(generation());
    const current = servingPeer(generation());
    let onChain = generation();
    const core = createRequesterHarness({ [PEER]: behind, [SECOND_PEER]: current }, { chain: { assets: () => onChain } });
    expect((await core.start().recover()).outcome).toBe('terminal');

    // Asset 3 is updated on chain; only the second peer serves the new version.
    onChain = generation('2');
    current.publish(generation('2'));
    behind.served.dataRows = 0;
    current.served.dataRows = 0;
    core.writes.length = 0;
    const recovered = await core.start().recover();

    expect(recovered.outcome).toBe('terminal');
    expect(recovered.peerId).toBe(SECOND_PEER);
    expect(behind.served.dataRows).toBe(0);
    expect(current.served.dataRows).toBe(asset(3, '2').payload.length);
    expect(core.writes).toEqual([asset(3, '2').ual]);
    expect(core.info).toContainEqual(expect.stringContaining('is not current on chain'));
  });

  it('transfers only the updated asset when one asset has a new version', async () => {
    const peer = servingPeer(generation());
    const core = createRequesterHarness(peer);
    expect((await core.start().recover()).outcome).toBe('terminal');

    peer.publish(generation('2'));
    peer.served.dataRows = 0;
    peer.served.exactDataRows = 0;
    core.writes.length = 0;
    const updated = await core.start().recover();

    expect(updated.outcome).toBe('terminal');
    const changed = asset(3, '2');
    expect(peer.served.dataRows).toBe(changed.payload.length);
    expect(peer.served.exactDataRows).toBe(changed.payload.length);
    expect(core.writes).toEqual([changed.ual]);
    const current = createGraphScopedDurableManifestPlan(generation('2').flatMap((fixture) => fixture.meta), CG)!;
    expect(await readHeldGraphScopedAssets(core.store, { contextGraphId: CG, descriptors: current.descriptors }))
      .toEqual(new Set(current.descriptors.map((descriptor) => descriptor.ual)));
    expect(core.info).toContainEqual(expect.stringContaining('fetches 1 missing asset(s)'));
    expect(core.info).toContainEqual(expect.stringContaining('reached its terminal verified boundary'));
  });

  it('rejects a stale held asset updated on chain while another asset is fetched exactly', async () => {
    const graph = [asset(1), asset(2)];
    const peer = servingPeer(graph);
    let onChain = graph;
    let updateDuringFetch = false;
    const core = createRequesterHarness(peer, {
      chain: { assets: () => onChain },
      mutations: { afterAssetStore: async () => {
        if (updateDuringFetch) onChain = [asset(1, '2'), graph[1]!];
      } },
    });
    expect((await core.start().recover()).outcome).toBe('terminal');
    await core.store.dropGraph(graph[1]!.graph);
    peer.served.exactDataRows = 0;
    updateDuringFetch = true;

    const restarted = core.start();
    const result = await restarted.recover();

    expect(peer.served.exactDataRows).toBe(graph[1]!.payload.length);
    expect(result.outcome).not.toBe('terminal');
    expect(result.result.complete).toBe(false);
    expect(core.info).toContainEqual(expect.stringContaining('is not current on chain'));
    expect(restarted.checkpointStore.get(getSyncCheckpointKey(PEER, CG, false, 'data'))?.terminal).not.toBe(true);
  });

  it('still recovers a changed generation with full-graph rounds when exact requests are unavailable', async () => {
    const peer = servingPeer(generation());
    const core = createRequesterHarness(peer);
    expect((await core.start().recover()).outcome).toBe('terminal');

    peer.publish(generation('2'));
    peer.served.dataRows = 0;
    core.writes.length = 0;
    const updated = await core.start({ exactRequests: false }).recover();

    expect(updated.outcome).toBe('terminal');
    expect(peer.served.dataRows).toBe(rowsOf(generation('2')));
    expect(core.writes).toContain(asset(3, '2').ual);
  });

  it('falls back to full-graph rounds when the store cannot say what it holds', async () => {
    const peer = servingPeer(generation());
    const core = createRequesterHarness(peer);
    expect((await core.start().recover()).outcome).toBe('terminal');

    core.failHoldingsReads(true);
    peer.served.dataRows = 0;
    const restarted = await core.start().recover();

    expect(restarted.outcome).toBe('terminal');
    expect(peer.served.dataRows).toBe(rowsOf(generation()));
    expect(core.info).toContainEqual(expect.stringContaining('store queue wait timeout'));
  });

  it('uses authenticated DATA rounds when fresh terminal held checks exceed every round budget', async () => {
    const large = Array.from({ length: 12 }, (_, index) => asset(index + 1));
    const peer = servingPeer(large);
    const core = createRequesterHarness(peer);
    expect((await core.start().recover()).outcome).toBe('terminal');

    // No round can prove the whole generation current; old verdicts cannot complete it.
    core.limitChainAnswersPerRound(5);
    peer.served.dataRows = 0;
    const restarted = await core.start({ sliceSpent: true }).recover();

    expect(restarted.outcome).toBe('terminal');
    expect(core.info).toContainEqual(expect.stringContaining("against the chain within the round's budget"));
    expect(restarted.result.verifiedHeldAssets).toBe(0);
    expect(restarted.result.complete).toBe(true);
    expect(restarted.slices).toBeGreaterThan(1);
    // Safety fallback: bounded DATA rounds authenticate their writes instead of using stale verdicts.
    expect(peer.served.dataRows).toBeGreaterThanOrEqual(rowsOf(large));
  });

  it('keeps exact repair but requires fresh evidence before terminal held readiness', async () => {
    const large = (updated = '1') => Array.from({ length: 12 }, (_, index) => asset(index + 1, index === 2 ? updated : '1'));
    const peer = servingPeer(large());
    const core = createRequesterHarness(peer);
    expect((await core.start().recover()).outcome).toBe('terminal');

    peer.publish(large('2'));
    core.limitChainAnswersPerRound(5);
    peer.served.dataRows = 0;
    peer.served.exactDataRows = 0;
    const restarted = await core.start({ sliceSpent: true }).recover();

    expect(restarted.outcome).toBe('terminal');
    expect(core.info).toContainEqual(expect.stringContaining("against the chain within the round's budget"));
    expect(core.info).toContainEqual(expect.stringContaining('fetches 1 missing asset(s)'));
    expect(peer.served.exactDataRows).toBe(asset(3, '2').payload.length);
    expect(restarted.result.verifiedHeldAssets).toBe(0);
    expect(restarted.result.complete).toBe(true);
    expect(peer.served.dataRows).toBeGreaterThanOrEqual(rowsOf(large('2')));
  });

  it('pulls the graph again when the store no longer holds it', async () => {
    const peer = servingPeer(generation());
    expect((await createRequesterHarness(peer).start().recover()).outcome).toBe('terminal');

    // A replaced data directory: nothing records the earlier completion except the store itself.
    const replaced = createRequesterHarness(peer);
    peer.served.dataRows = 0;
    const recovered = await replaced.start().recover();

    expect(recovered.outcome).toBe('terminal');
    expect(peer.served.dataRows).toBe(rowsOf(generation()));
    expect(replaced.writes).toHaveLength(6);
    expect(replaced.info).not.toContainEqual(expect.stringContaining('already held'));
  });
});
