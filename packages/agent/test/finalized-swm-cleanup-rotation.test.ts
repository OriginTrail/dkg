// SPDX-License-Identifier: Apache-2.0

/**
 * Rotation-cursor behaviour of the idle finalized-SWM GC.
 *
 * A sweep that yields mid-rotation persists its unvisited tail, so the next
 * slice continues instead of re-walking the same prefix forever. That makes
 * `backlogDepth` the delicate part: with a rotating start, a naive per-sweep
 * sum would be a partial number whose meaning changes every sweep. The service
 * instead accumulates per-context-graph contributions and publishes only when
 * the rotation closes, so the metric can be STALE but never PARTIAL.
 *
 * The assertions here are therefore about the published totals and about which
 * context graphs each slice actually entered. Asserting only that the cursor
 * advanced is much weaker: it passes with the accumulator committed in the
 * wrong place, which is the mutation that silently inflates the SLO surface.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  GraphManager,
  OxigraphStore,
  type Quad,
  type QueryOptions,
} from '@origintrail-official/dkg-storage';
import {
  FINALIZED_SWM_CLEANUP_MARKED_AT_PREDICATE,
  FINALIZED_SWM_CLEANUP_ROOT_PREDICATE,
  FINALIZED_SWM_CLEANUP_TASK_TYPE,
} from '../src/dkg-agent-constants.js';
import { FinalizedSwmCleanupService } from '../src/finalized-swm-cleanup-service.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const MARKER_ROOT = JSON.stringify(`0x${'11'.repeat(32)}`);

/**
 * Backlog markers only. The discovery query additionally requires kaUal,
 * assertionVersion, shareOperationId, assertionGraph and headFingerprint, so
 * these rows are counted by `inspectBacklog` and ignored by cleanup — which is
 * what keeps these tests about rotation rather than about deletion.
 */
function markerQuads(label: string, metaGraph: string, count: number): Quad[] {
  const quads: Quad[] = [];
  for (let index = 0; index < count; index += 1) {
    const subject = `urn:dkg:finalized-swm-cleanup:${label}-${index}`;
    quads.push(
      { subject, predicate: RDF_TYPE, object: FINALIZED_SWM_CLEANUP_TASK_TYPE, graph: metaGraph },
      { subject, predicate: FINALIZED_SWM_CLEANUP_ROOT_PREDICATE, object: MARKER_ROOT, graph: metaGraph },
      {
        subject,
        predicate: FINALIZED_SWM_CLEANUP_MARKED_AT_PREDICATE,
        object: `"${new Date(1_700_000_000_000 + index * 1_000).toISOString()}"^^<${XSD_DATE_TIME}>`,
        graph: metaGraph,
      },
    );
  }
  return quads;
}

function installPressureSwitch(store: OxigraphStore): { busy: boolean } {
  const state = { busy: false };
  Object.defineProperty(store, 'getPressureSnapshot', {
    configurable: true,
    value: () => ({
      ackInflight: 0,
      healthInflight: 0,
      normalInflight: state.busy ? 1 : 0,
      backgroundInflight: 0,
      ackQueued: 0,
      healthQueued: 0,
      normalQueued: 0,
      backgroundQueued: 0,
      maxConcurrent: 4,
      ackReservedSlots: 1,
    }),
  });
  return state;
}

describe('finalized SWM cleanup rotation cursor', () => {
  /**
   * The property the whole accumulate-across-rotation design exists to hold: a
   * slice that yields part-way through a context graph must discard that
   * context graph's partial contribution, so the re-measure on resume cannot
   * double-count it.
   *
   * 20 markers across two meta graphs of one context graph. The first slice
   * measures one meta graph and then yields, the second measures both. The
   * published total must be 20 — committing each meta graph straight into the
   * rotation accumulator instead of at the context-graph boundary yields 30.
   */
  it('discards a partial context-graph measurement rather than double-counting it on resume', async () => {
    const store = new OxigraphStore();
    const pressure = installPressureSwitch(store);
    const graphManager = new GraphManager(store);
    const rootMeta = graphManager.sharedMemoryMetaUri('cg-partial');
    const subMeta = graphManager.sharedMemoryMetaUri('cg-partial', 'named');
    await store.insert(markerQuads('root', rootMeta, 10));
    await store.insert(markerQuads('sub', subMeta, 10));

    // Pressure appears once the first meta graph has been measured, so the
    // slice yields at the top of the second meta-graph iteration.
    let backlogReads = 0;
    const originalQuery = store.query.bind(store);
    const querySpy = vi.spyOn(store, 'query').mockImplementation(async (query, options) => {
      const result = await originalQuery(query, options);
      if (options?.source === 'agent.finalizedSwmCleanup.backlog') {
        backlogReads += 1;
        if (backlogReads === 1) pressure.busy = true;
      }
      return result;
    });

    const service = new FinalizedSwmCleanupService({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      listContextGraphIds: async () => ['cg-partial'],
      listSharedMemoryMetaGraphs: async () => [rootMeta, subMeta],
    });

    await expect(service.runSweep()).resolves.toMatchObject({
      pressureSkipped: true,
      stale: true,
      // Nothing has ever been published, and the 10 markers measured in this
      // slice are NOT it — that would be a partial sum.
      backlogDepth: 0,
    });
    expect(backlogReads).toBe(1);

    pressure.busy = false;
    await expect(service.runSweep()).resolves.toMatchObject({
      pressureSkipped: false,
      stale: false,
      backlogDepth: 20,
    });
    // Three reads total: one discarded, then both meta graphs re-measured.
    expect(backlogReads).toBe(3);
    querySpy.mockRestore();
  });

  /**
   * A yielding sweep must resume at its unvisited tail. Before the cursor,
   * every retry re-walked the same prefix, so markers in later context graphs
   * were never discovered no matter how many times the worker woke.
   *
   * Four context graphs, 10 markers each, enumeration costing 60ms against a
   * 100ms slice. Context graphs legitimately repeat across slices — a graph
   * entered but not finished is re-measured whole — so the assertion is on the
   * entry sequence and on the single published total, not on disjoint sets.
   */
  it('resumes at the unvisited tail and publishes a whole-node total only when the rotation closes', async () => {
    const store = new OxigraphStore();
    installPressureSwitch(store);
    const graphManager = new GraphManager(store);
    const contextGraphIds = ['cg-a', 'cg-b', 'cg-c', 'cg-d'];
    const metaByContextGraph = new Map<string, string>();
    for (const contextGraphId of contextGraphIds) {
      const meta = graphManager.sharedMemoryMetaUri(contextGraphId);
      metaByContextGraph.set(contextGraphId, meta);
      await store.insert(markerQuads(contextGraphId, meta, 10));
    }

    const clock = { now: 1_000_000 };
    const entered: string[][] = [];
    let currentSweep: string[] = [];
    const service = new FinalizedSwmCleanupService({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      now: () => clock.now,
      wallClockBudgetMs: 100,
      listContextGraphIds: async () => [...contextGraphIds],
      listSharedMemoryMetaGraphs: async (contextGraphId) => {
        currentSweep.push(contextGraphId);
        clock.now += 60;
        return [metaByContextGraph.get(contextGraphId)!];
      },
    });

    const runSlice = async () => {
      currentSweep = [];
      const result = await service.runSweep();
      entered.push(currentSweep);
      return result;
    };

    await expect(runSlice()).resolves.toMatchObject({ budgetExhausted: true, stale: true, backlogDepth: 0 });
    await expect(runSlice()).resolves.toMatchObject({ budgetExhausted: true, stale: true, backlogDepth: 0 });
    await expect(runSlice()).resolves.toMatchObject({ budgetExhausted: true, stale: true, backlogDepth: 0 });
    // The rotation closes here: every context graph has been measured exactly
    // once, so 4 x 10 markers is a whole-node total.
    const closing = await runSlice();
    expect(closing).toMatchObject({ pressureSkipped: false, stale: false, backlogDepth: 40 });
    expect(closing.budgetExhausted).toBeUndefined();

    // Seven context-graph entries produced a total of 40, not 70: the three
    // graphs entered twice contributed once each.
    expect(entered).toEqual([
      ['cg-a', 'cg-b'],
      ['cg-b', 'cg-c'],
      ['cg-c', 'cg-d'],
      ['cg-d'],
    ]);
    expect(entered.flat()).toHaveLength(7);

    // A fresh rotation opens at the head again, republishing the last complete
    // total as stale rather than resetting it to zero.
    await expect(runSlice()).resolves.toMatchObject({ stale: true, backlogDepth: 40 });
    expect(entered[4]).toEqual(['cg-a', 'cg-b']);
  });

  /**
   * Forward progress. A context graph whose enumeration cannot finish inside
   * one slice would otherwise hold the cursor forever and starve every context
   * graph behind it — the same "later graphs are never reached" failure the
   * cursor exists to fix.
   */
  it('rotates a head that repeatedly cannot be finished so the tail is still served', async () => {
    const store = new OxigraphStore();
    installPressureSwitch(store);
    const graphManager = new GraphManager(store);
    const slowMeta = graphManager.sharedMemoryMetaUri('cg-slow');
    const metaB = graphManager.sharedMemoryMetaUri('cg-b');
    const metaC = graphManager.sharedMemoryMetaUri('cg-c');
    await store.insert(markerQuads('slow', slowMeta, 5));
    await store.insert(markerQuads('b', metaB, 5));
    await store.insert(markerQuads('c', metaC, 5));

    const clock = { now: 1_000_000 };
    const entered: string[][] = [];
    let currentSweep: string[] = [];
    const service = new FinalizedSwmCleanupService({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      now: () => clock.now,
      wallClockBudgetMs: 100,
      listContextGraphIds: async () => ['cg-slow', 'cg-b', 'cg-c'],
      listSharedMemoryMetaGraphs: async (contextGraphId) => {
        currentSweep.push(contextGraphId);
        // The head alone costs more than a whole slice, so it can never finish.
        clock.now += contextGraphId === 'cg-slow' ? 200 : 10;
        if (contextGraphId === 'cg-slow') return [slowMeta];
        return [contextGraphId === 'cg-b' ? metaB : metaC];
      },
    });

    for (let slice = 0; slice < 3; slice += 1) {
      currentSweep = [];
      await service.runSweep();
      entered.push(currentSweep);
    }

    expect(entered[0]).toEqual(['cg-slow']);
    expect(entered[1]).toEqual(['cg-slow']);
    // The head steps aside after TWO failed slices and keeps its place in the
    // rotation, so the graphs behind it are finally reached — and it is still
    // retried in the same pass rather than dropped.
    expect(entered[2]).toEqual(['cg-b', 'cg-c', 'cg-slow']);
  });

  /**
   * Owner/name context graphs (`<owner>/<name>`) must stay reachable by GC
   * discovery. Nothing about that is obvious from the code, and it has already
   * survived two independent near-misses: an enumeration source that drops ids
   * containing `/`, and a listing mode that drops context graphs with no
   * explicit privacy policy. Either would have made these graphs invisible to
   * the GC and left their finalized SWM copies forever — #1996 reintroduced by
   * the back door, in the subsystem meant to close it.
   *
   * This pins the service side: an id containing `/` must survive graph-URI
   * derivation, discovery and backlog measurement. Which enumeration source
   * feeds `listContextGraphIds` is production wiring and is covered separately
   * by the agent-level TTL suite.
   */
  it('discovers and measures an owner/name context graph', async () => {
    const store = new OxigraphStore();
    installPressureSwitch(store);
    const graphManager = new GraphManager(store);
    const ownerNameId = `${'0x1111111111111111111111111111111111111111'}/public-finalized-cleanup`;
    const rootMeta = graphManager.sharedMemoryMetaUri(ownerNameId);
    const subMeta = graphManager.sharedMemoryMetaUri(ownerNameId, 'named-slice');
    expect(rootMeta).toContain(ownerNameId);
    await store.insert(markerQuads('owner-root', rootMeta, 4));
    await store.insert(markerQuads('owner-sub', subMeta, 2));

    const enumerated: string[] = [];
    const service = new FinalizedSwmCleanupService({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      listContextGraphIds: async () => [ownerNameId],
      listSharedMemoryMetaGraphs: async (contextGraphId) => {
        enumerated.push(contextGraphId);
        return [rootMeta, subMeta];
      },
    });

    await expect(service.runSweep()).resolves.toMatchObject({
      pressureSkipped: false,
      stale: false,
      // Both the root and the named sub-graph meta graph of the owner/name CG
      // were measured; a `/`-rejecting path anywhere here reports 0.
      backlogDepth: 6,
    });
    expect(enumerated).toEqual([ownerNameId]);
  });

  /**
   * A context graph deleted mid-rotation must not strand the rotation. The
   * pending tail is re-filtered against a fresh enumeration each slice.
   */
  it('drops a context graph that disappears mid-rotation without stranding the rotation', async () => {
    const store = new OxigraphStore();
    installPressureSwitch(store);
    const graphManager = new GraphManager(store);
    const metaA = graphManager.sharedMemoryMetaUri('cg-a');
    const metaB = graphManager.sharedMemoryMetaUri('cg-b');
    await store.insert(markerQuads('a', metaA, 7));
    await store.insert(markerQuads('b', metaB, 3));

    const clock = { now: 1_000_000 };
    let live = ['cg-a', 'cg-b'];
    const service = new FinalizedSwmCleanupService({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      now: () => clock.now,
      wallClockBudgetMs: 100,
      listContextGraphIds: async () => [...live],
      listSharedMemoryMetaGraphs: async (contextGraphId) => {
        clock.now += 60;
        return [contextGraphId === 'cg-a' ? metaA : metaB];
      },
    });

    await expect(service.runSweep()).resolves.toMatchObject({ stale: true, backlogDepth: 0 });

    // cg-b is deleted while it is still the pending tail.
    live = ['cg-a'];
    await expect(service.runSweep()).resolves.toMatchObject({
      stale: false,
      // Only the graphs that still exist contribute; the rotation still closes.
      backlogDepth: 7,
    });
  });

  /**
   * The per-context-graph enumeration is the call that scales with graph count,
   * so it must reach the store on the background lane and carry the slice's
   * deadline. An absent priority defaults to `normal`, which turned the GC's own
   * discovery into a foreground scan on a cold graph-set index.
   */
  it('runs the per-context-graph meta enumeration on the background lane with the slice deadline', async () => {
    const store = new OxigraphStore();
    installPressureSwitch(store);
    const seen: QueryOptions[] = [];
    const service = new FinalizedSwmCleanupService({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      listContextGraphIds: async () => ['cg-lane'],
      listSharedMemoryMetaGraphs: async (_contextGraphId, options) => {
        seen.push(options);
        return [];
      },
    });

    await service.runSweep();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      priority: 'background',
      source: 'agent.finalizedSwmCleanup.discover',
    });
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
  });
});
