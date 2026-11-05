/**
 * GH#3134 — what a supervisor pass costs while its markers wait on a full author catalog. A pass
 * keeps each listed marker's key and decision from pass to pass, reads a graph's authority once
 * between two awaits, and hands the event loop back every few milliseconds of work. It keeps
 * every durable obligation, lane reset and capacity rule it had.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createOperationContext, type ContextGraphIdV1 } from '@origintrail-official/dkg-core';

import { CatalogPlacementTimingV1 } from '../src/internal/catalog-placement-timing.js';
import { FinalizedPrivatePlacementOwnerV1 } from '../src/internal/finalized-private-placement-owner.js';
import { FullCatalogParkingV1 } from '../src/internal/full-catalog-parking.js';
import type { PrivatePlacementFailureStateV1 } from '../src/rfc64/private-placement-failure-state-v1.js';
import {
  BACKLOG_GRAPH,
  backlogV1,
  catalogScopeDigestV1,
  ctx,
  parkedBacklogNodeV1,
  scopeBaseV1,
  v1MarkerV1,
  v2MarkerV1,
  type Marker,
} from './support/parked-private-backlog-fixture.js';

const owners: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { await Promise.all(owners.splice(0).map((owner) => owner.close())); });

function node(...args: Parameters<typeof parkedBacklogNodeV1>) {
  const created = parkedBacklogNodeV1(...args);
  owners.push(created.owner);
  return created;
}

/** A timer set inside the pass, at its first applied-head read: how late it fires. */
function timerDuringPass(n: ReturnType<typeof node>): { delayMs: () => number } {
  let armedAt: number | undefined;
  let firedAt: number | undefined;
  n.state.onHeadRead = () => {
    if (armedAt !== undefined) return;
    armedAt = performance.now();
    setTimeout(() => { firedAt = performance.now(); }, 0);
  };
  return { delayMs: () => (firedAt === undefined || armedAt === undefined ? Number.POSITIVE_INFINITY : firedAt - armedAt) };
}

describe('a supervisor pass over a parked backlog', () => {
  it.each([3_500, 10_000])('parks a mixed V1/V2 backlog of %i markers on one refused attempt, then passes over it without work', async (size) => {
    const n = node(backlogV1(size));
    expect(n.state.markers.filter((marker) => marker.version === 2).length).toBe(Math.round((size * 128) / 3534));
    await n.pass();
    expect(n.state.attempts).toHaveLength(1);
    expect(n.calls.failureReads).toHaveBeenCalledTimes(size);
    expect(n.calls.failureWrites).toHaveBeenCalledTimes(1);
    expect(n.capacity()).toEqual({ parkedPlacements: size, scopesAtCap: 1 });

    for (const ask of [() => n.pass(), () => n.request(n.state.markers[size - 1]!)]) {
      n.clear();
      await ask();
      expect(n.state.attempts).toEqual([]);
      expect(n.calls.failureReads).not.toHaveBeenCalled();
      expect(n.calls.failureWrites).not.toHaveBeenCalled();
      expect(n.calls.head).toHaveBeenCalledTimes(1);
      // Once between two awaits of the pass (a slice is at most 32 markers), not once a marker.
      expect(n.calls.authority.mock.calls.length).toBeLessThan(size / 16);
    }
    expect(n.state.markers).toHaveLength(size);
    expect(n.capacity()).toEqual({ parkedPlacements: size, scopesAtCap: 1 });
    expect(n.owner.status()?.finalizedPrivatePlacement).toMatchObject({ depth: size, pending: size, waiters: 0 });
  });

  it('lets a timer set during a pass over 10,000 parked markers fire within a few milliseconds, with no repair or store call', async () => {
    const n = node(backlogV1(10_000));
    await n.pass();
    n.clear();
    const timer = timerDuringPass(n);
    await n.request(n.state.markers[0]!);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(timer.delayMs()).toBeLessThan(50);
    expect(n.state.attempts).toEqual([]);
    expect(n.calls.place).not.toHaveBeenCalled();
    expect(n.calls.failureReads).not.toHaveBeenCalled();
    expect(n.calls.failureWrites).not.toHaveBeenCalled();
    expect(n.calls.head).toHaveBeenCalledTimes(1);
  });

  it('parks the markers a growing backlog adds without an attempt of their own', async () => {
    const n = node(backlogV1(3_500));
    await n.pass();
    expect(n.state.attempts).toHaveLength(1);
    for (let first = 3_501; first <= 10_000; first += 650) {
      const added = backlogV1(650, first);
      n.state.markers = [...n.state.markers, ...added];
      n.clear();
      await n.pass();
      expect(n.state.attempts).toEqual([]);
      // Each new marker's history is read once, when the pass first lists it.
      expect(n.calls.failureReads).toHaveBeenCalledTimes(added.length);
      expect(n.calls.failureWrites).not.toHaveBeenCalled();
      expect(n.calls.head).toHaveBeenCalledTimes(1);
      expect(n.capacity()).toEqual({ parkedPlacements: n.state.markers.length, scopesAtCap: 1 });
    }
    expect(n.state.markers).toHaveLength(10_000);
  });

  it('keeps a sparse backlog over many full scopes parked, one attempt a scope, while other graphs place', async () => {
    const graphs = Array.from({ length: 24 }, (_value, index) => `sparse-${index}` as ContextGraphIdV1);
    const healthy = 'sparse-healthy' as ContextGraphIdV1;
    const markers = [
      ...graphs.flatMap((graph, index) => backlogV1(40, 1 + index * 100, graph)),
      ...backlogV1(10, 50_000, healthy),
    ].sort((a, b) => a.kaUal.localeCompare(b.kaUal) || a.contextGraphId.localeCompare(b.contextGraphId));
    const n = node(markers, { full: graphs.map((graph) => catalogScopeDigestV1(graph)) });
    await n.pass();
    expect(n.state.attempts.filter((marker) => marker.contextGraphId !== healthy)).toHaveLength(graphs.length);
    expect(n.state.markers.filter((marker) => marker.contextGraphId === healthy)).toEqual([]);
    expect(n.capacity()).toEqual({ parkedPlacements: graphs.length * 40, scopesAtCap: graphs.length });
    n.clear();
    await n.pass();
    expect(n.state.attempts).toEqual([]);
    expect(n.calls.head).toHaveBeenCalledTimes(graphs.length);
    expect(n.calls.authority.mock.calls.length).toBeLessThan(markers.length);
  });

  it('moves V2 markers to a new policy scope while V1 markers keep their own, after passes that kept their decisions', async () => {
    const markers = [...backlogV1(100), ...Array.from({ length: 20 }, (_value, index) => v2MarkerV1(20_000 + index))];
    const v2Count = markers.filter((marker) => marker.version === 2).length;
    const n = node(markers);
    await n.pass();
    await n.pass();
    expect(n.state.attempts).toHaveLength(1);
    expect(n.capacity()?.parkedPlacements).toBe(markers.length);
    // A policy transition: the graph's authority names era 2, whose catalog has room.
    n.state.era = '2';
    n.clear();
    await n.pass();
    expect(n.state.attempts.map((marker) => marker.version)).toEqual(Array(v2Count).fill(2));
    expect(n.state.markers.every((marker) => marker.version === 1)).toBe(true);
    // A V1 marker stays pinned to its confirmation-time scope, which is still full.
    expect(n.capacity()).toEqual({ parkedPlacements: n.state.markers.length, scopesAtCap: 1 });
  });

  it('attempts the parked markers again once the applied head shows a free row', async () => {
    const n = node(backlogV1(500));
    await n.pass();
    await n.pass();
    expect(n.state.attempts).toHaveLength(1);
    n.full.clear();
    n.clear();
    await n.pass();
    expect(n.state.attempts).toHaveLength(500);
    expect(n.state.markers).toEqual([]);
  });

  it('resets every parked sibling once when the lane changes between passes', async () => {
    const parked: PrivatePlacementFailureStateV1 = { kind: 'signer_mismatch', consecutiveFailures: 3,
      sameKindFailures: 3, firstFailedAtMs: 1_000, lastFailedAtMs: 16_000, nextAttemptAtMs: null, parked: true };
    const n = node(backlogV1(300), { full: [] });
    for (const marker of n.state.markers) n.failures.set(marker.kaUal, parked);
    await n.pass();
    expect(n.state.attempts).toEqual([]);
    n.state.active = false;
    n.clear();
    await n.pass();
    // One batch for the whole lane, then every marker is attempted under the inactive lane.
    expect(n.calls.failureWrites.mock.calls[0]?.[0]).toHaveLength(300);
    expect(n.state.attempts).toEqual([]);
    expect([...n.failures.values()].every((state) => state.kind === 'lane_inactive' && !state.parked)).toBe(true);
    n.state.active = true;
    n.clear();
    await n.pass();
    expect(n.calls.failureWrites.mock.calls[0]?.[0]).toHaveLength(300);
    expect(n.state.markers).toEqual([]);
  });

  it('decides the marker after a placement on the lane as it reads after that placement', async () => {
    const n = node(backlogV1(3), { full: [] });
    n.calls.place.mockImplementationOnce(async (repair: Marker) => {
      n.state.attempts.push(repair);
      n.state.markers = n.state.markers.filter((candidate) => candidate !== repair);
      // The lane becomes inactive while this placement is in flight; nothing announces it.
      n.state.active = false;
    });
    await n.pass();
    expect(n.state.attempts).toHaveLength(1);
    expect(n.state.markers).toHaveLength(2);
    expect([...n.failures.values()].map((state) => state.kind)).toEqual(['lane_inactive', 'lane_inactive']);
  });

  it('releases the waiters of a lane whose reset waits on an unavailable authority once, not once a sibling', async () => {
    const parked: PrivatePlacementFailureStateV1 = { kind: 'signer_mismatch', consecutiveFailures: 3,
      sameKindFailures: 3, firstFailedAtMs: 1_000, lastFailedAtMs: 16_000, nextAttemptAtMs: null, parked: true };
    const n = node(backlogV1(5_000), { full: [] });
    for (const marker of n.state.markers) n.failures.set(marker.kaUal, parked);
    await n.pass();
    // The lane's edge cannot persist its reset, so the reset stays pending.
    n.calls.failureWrites.mockImplementation(() => { throw new Error('reset storage unavailable'); });
    n.state.active = false;
    n.owner.observeLaneAvailability(BACKLOG_GRAPH);
    n.state.active = true;
    const requests = n.state.markers.map((repair) => n.owner.requestFinalizedPrivate({ repair, ctx }));
    expect(requests.every((request) => request.accepted)).toBe(true);
    n.state.unavailable = new Error('the lane authority is not readable now');
    n.clear();
    const startedAt = performance.now();
    await n.owner.whenIdle();
    await Promise.all(requests.map((request) => request.whenAttempted));
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(n.owner.status()?.finalizedPrivatePlacement.waiters).toBe(0);
    expect(n.state.attempts).toEqual([]);
    expect([...n.failures.values()].every((state) => state.parked)).toBe(true);
  });
});

describe('a pass that hands the event loop back between markers', () => {
  it('reads the authority again after the pass yields, and resets the lane in the pass that sees it change', async () => {
    const markers = Array.from({ length: 100 }, (_value, index) => v1MarkerV1(index + 1));
    const parked: PrivatePlacementFailureStateV1 = { kind: 'signer_mismatch', consecutiveFailures: 3,
      sameKindFailures: 3, firstFailedAtMs: 1_000, lastFailedAtMs: 16_000, nextAttemptAtMs: null, parked: true };
    const failures = new Map<string, PrivatePlacementFailureStateV1>(markers.map((marker) => [marker.kaUal, parked]));
    const writes: Array<readonly { repair: Marker; state: PrivatePlacementFailureStateV1 }[]> = [];
    let reads = 0;
    let slowed = false;
    const timing = new CatalogPlacementTimingV1();
    const owner = new FinalizedPrivatePlacementOwnerV1({
      listFinalizedPrivateRepairsAsync: async () => markers,
      listFinalizedPrivateRepairs: () => markers,
      // The lane moves to era 2 after its first read: a transition while the pass is between turns.
      readFinalizedPlacementAuthority: (contextGraphId) => ({ status: 'active', lane: { kind: 'private',
        acceptsFinalizedVmRepair: true, scopeBase: scopeBaseV1(contextGraphId as ContextGraphIdV1, ++reads === 1 ? '1' : '2') } }),
      repairFinalizedPrivatePlacement: async () => { throw new Error('the catalog is unreachable'); },
      readPrivateFailure: (repair) => {
        // The tenth marker's history read outlasts a slice, so the pass yields after it.
        if (repair === markers[9] && !slowed) {
          slowed = true;
          const until = performance.now() + 12;
          while (performance.now() < until) { /* hold the slice */ }
        }
        return failures.get(repair.kaUal) ?? null;
      },
      writePrivateFailures: (entries) => {
        writes.push(entries);
        for (const entry of entries) failures.set(entry.repair.kaUal, entry.state);
      },
      warn: () => {},
    }, { retryIntervalMs: 0, timing: () => timing, fullCatalogs: new FullCatalogParkingV1({ warn: () => {} }),
      ctx: createOperationContext('system') });
    owners.push(owner);
    owner.requestPass();
    await owner.whenIdle();
    // The first slice kept its one read; the read after the turn saw era 2 and reset all 100 at once.
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(writes[0]).toHaveLength(100);
    expect(writes[0]!.every(({ state }) => !state.parked && state.consecutiveFailures === 0)).toBe(true);
  });
});
