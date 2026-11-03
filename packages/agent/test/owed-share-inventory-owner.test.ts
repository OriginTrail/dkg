// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';

import {
  OWED_SHARE_INVENTORY_FAILURE_PAUSE_MAX_MS,
  Rfc64OwedShareInventoryOwnerV1,
  type OwedShareInventoryDrainOutcomeV1,
  type OwedShareInventoryOwnerDependenciesV1,
} from '../src/internal/owed-share-inventory-owner.js';
import type { Rfc64OwedShareInventoryV1 } from '../src/rfc64/owed-share-inventory-store-v1.js';

const AUTHOR = '0x1111111111111111111111111111111111111111';
function marker(shareOperationId: string): Rfc64OwedShareInventoryV1 {
  return Object.freeze({
    version: 1, contextGraphId: `${AUTHOR}/owed`, subGraphName: null, authorAddress: AUTHOR,
    assertionCoordinate: 'asset', sealDigest: `0x${'ab'.repeat(32)}`, shareOperationId,
  }) as Rfc64OwedShareInventoryV1;
}

function fixture(outcomes: Record<string, Array<OwedShareInventoryDrainOutcomeV1 | Error>>, options: {
  retryIntervalMs?: number; unreadable?: number; removeFails?: boolean;
} = {}) {
  const kept = new Map(Object.keys(outcomes).map((id) => [id, marker(id)]));
  let now = 1_000_000;
  const warnings: string[] = [];
  const drain = vi.fn(async (owed: Readonly<Rfc64OwedShareInventoryV1>) => {
    const next = outcomes[owed.shareOperationId]!.shift() ?? 'waiting';
    if (next instanceof Error) throw next;
    return next;
  });
  const remove = vi.fn(async (owed: Readonly<Rfc64OwedShareInventoryV1>) => {
    if (options.removeFails) throw new Error('disk refused the unlink');
    kept.delete(owed.shareOperationId);
  });
  const dependencies: OwedShareInventoryOwnerDependenciesV1 = {
    list: () => [...kept.values()],
    unreadableAtOpen: () => options.unreadable ?? 0,
    drain,
    remove,
    retryIntervalMs: () => options.retryIntervalMs ?? 0,
    warn: (_ctx, line) => { warnings.push(line); },
    now: () => now,
  };
  const owner = new Rfc64OwedShareInventoryOwnerV1(dependencies);
  return { owner, kept, drain, remove, warnings, advance: (ms: number) => { now += ms; } };
}

describe('owed share inventory owner', () => {
  it('ends markers on a written row, a VM confirmation or a superseded share, and keeps waiting ones', async () => {
    const { owner, kept, drain, remove, warnings } = fixture({
      written: ['written'], confirmed: ['vm-confirmed'], superseded: ['superseded'], fenced: ['waiting', 'written'],
    });
    owner.start(createOperationContext('system'));
    await owner.whenIdle();
    expect(drain).toHaveBeenCalledTimes(4);
    expect([...kept.keys()]).toEqual(['fenced']);
    expect(remove).toHaveBeenCalledTimes(3);
    expect(warnings).toEqual([]);
    // The lane opens: an explicit request (an accepted authority, a new marker) writes it.
    owner.request();
    await owner.whenIdle();
    expect([...kept.keys()]).toEqual([]);
    await owner.close();
    // A closed owner ignores requests.
    owner.request();
    await owner.whenIdle();
    expect(drain).toHaveBeenCalledTimes(5);
  });

  it('drops a marker whose catalog policy no longer takes the share, with a warning', async () => {
    const { owner, kept, warnings } = fixture({ mismatch: ['policy-mismatch'] });
    owner.start(createOperationContext('system'));
    await owner.whenIdle();
    expect(kept.size).toBe(0);
    expect(warnings).toEqual([expect.stringContaining('catalog policy no longer takes the share')]);
    await owner.close();
  });

  it('pauses a failing marker with a growing, bounded pause and warns about each failure', async () => {
    const failure = new Error('signer unavailable');
    const { owner, kept, drain, warnings, advance } = fixture({
      failing: [failure, failure, failure, failure, failure, failure, failure, failure, 'written'],
    }, { retryIntervalMs: 0 });
    owner.start(createOperationContext('system'));
    await owner.whenIdle();
    expect(drain).toHaveBeenCalledTimes(1);
    expect(warnings[0]).toContain('attempt 1, next in 5 s): signer unavailable');
    // Inside the pause nothing is tried.
    owner.request();
    await owner.whenIdle();
    expect(drain).toHaveBeenCalledTimes(1);
    const pauses = [5_000];
    for (let attempt = 2; attempt <= 8; attempt += 1) {
      advance(pauses.at(-1)!);
      owner.request();
      await owner.whenIdle();
      expect(drain).toHaveBeenCalledTimes(attempt);
      pauses.push(Math.min(OWED_SHARE_INVENTORY_FAILURE_PAUSE_MAX_MS, 5_000 * 2 ** (attempt - 1)));
      expect(warnings.at(-1)).toContain(`attempt ${attempt}, next in ${pauses.at(-1)! / 1000} s)`);
    }
    expect(pauses.at(-1)).toBe(OWED_SHARE_INVENTORY_FAILURE_PAUSE_MAX_MS);
    advance(OWED_SHARE_INVENTORY_FAILURE_PAUSE_MAX_MS);
    owner.request();
    await owner.whenIdle();
    expect(kept.size).toBe(0);
    await owner.close();
  });

  it('keeps a marker it could not remove and forgets pauses of markers that are gone', async () => {
    const { owner, kept, warnings } = fixture({ stuck: ['written', 'written'] }, { removeFails: true });
    owner.start(createOperationContext('system'));
    await owner.whenIdle();
    expect(kept.size).toBe(1);
    expect(warnings).toEqual([expect.stringContaining('was not removed: disk refused the unlink')]);
    await owner.close();

    const gone = fixture({ failing: [new Error('busy')] });
    gone.owner.start(createOperationContext('system'));
    await gone.owner.whenIdle();
    gone.kept.clear();
    gone.owner.request();
    await gone.owner.whenIdle();
    expect(gone.drain).toHaveBeenCalledTimes(1);
    // Written again it is a new marker: the old pause does not carry over.
    gone.kept.set('failing', marker('failing'));
    gone.owner.request();
    await gone.owner.whenIdle();
    expect(gone.drain).toHaveBeenCalledTimes(2);
    await gone.owner.close();
  });

  it('counts failures from the start again after an attempt that did not fail', async () => {
    const failure = new Error('busy');
    const { owner, warnings, advance } = fixture({ flaky: [failure, 'waiting', failure] });
    owner.start(createOperationContext('system'));
    await owner.whenIdle();
    advance(5_000);
    owner.request();
    await owner.whenIdle();
    owner.request();
    await owner.whenIdle();
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain('attempt 1, next in 5 s');
    await owner.close();
  });

  it('tries a paused marker at once after a restart of the owner', async () => {
    const { owner, drain } = fixture({ failing: [new Error('busy'), 'waiting'] });
    owner.start(createOperationContext('system'));
    await owner.whenIdle();
    await owner.close();
    expect(drain).toHaveBeenCalledOnce();
    owner.start(createOperationContext('system'));
    await owner.whenIdle();
    expect(drain).toHaveBeenCalledTimes(2);
    await owner.close();
  });

  it('warns about unreadable markers at start and retries kept markers on the retry interval', async () => {
    const { owner, drain, kept, warnings } = fixture({ fenced: ['waiting', 'waiting', 'written'] }, {
      retryIntervalMs: 5, unreadable: 2,
    });
    owner.start(createOperationContext('system'));
    expect(warnings).toEqual([expect.stringContaining('2 owed share inventory marker file(s) could not be read')]);
    await vi.waitFor(() => expect(kept.size).toBe(0));
    expect(drain).toHaveBeenCalledTimes(3);
    // A second start of a running owner is one more pass.
    owner.start(createOperationContext('system'));
    await owner.whenIdle();
    await owner.close();
  });

  it('warns about a pass that failed as a whole and tries again on the next request', async () => {
    const { kept, warnings, drain, remove } = fixture({ listed: ['written'] });
    const list = vi.fn(() => [...kept.values()]).mockImplementationOnce(() => { throw new Error('persistence owner is closed'); });
    const failing = new Rfc64OwedShareInventoryOwnerV1({
      list, unreadableAtOpen: () => 0, drain, remove, retryIntervalMs: () => 0,
      warn: (_ctx, line) => { warnings.push(line); },
    });
    failing.start(createOperationContext('system'));
    await failing.whenIdle();
    expect(warnings).toEqual(['Owed share inventory pass failed: persistence owner is closed']);
    expect(kept.size).toBe(1);
    expect(drain).not.toHaveBeenCalled();
    failing.request();
    await failing.whenIdle();
    expect(list).toHaveBeenCalledTimes(3); // The successful pass rechecks for remaining markers.
    expect(drain).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(kept.size).toBe(0);
    await failing.close();
  });

  it('stops a pass at close without counting the attempt as failed', async () => {
    let release!: () => void;
    const { owner, drain, warnings } = fixture({ first: [], second: [] });
    drain.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      release = () => reject(new Error('aborted by shutdown'));
    }));
    owner.start(createOperationContext('system'));
    await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
    const closing = owner.close();
    release();
    await closing;
    expect(drain).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([]);
  });
});

describe('owed share inventory owner over a parked backlog', () => {
  function inLane(shareOperationId: string, lane: string): Rfc64OwedShareInventoryV1 {
    return Object.freeze({ ...marker(shareOperationId), contextGraphId: `${AUTHOR}/${lane}` }) as Rfc64OwedShareInventoryV1;
  }

  function backlog(markers: readonly Rfc64OwedShareInventoryV1[], drain: OwedShareInventoryOwnerDependenciesV1['drain']) {
    const kept = new Set(markers);
    const warnings: string[] = [];
    const requestGraphSettlement = vi.fn();
    const owner = new Rfc64OwedShareInventoryOwnerV1({
      list: () => [...kept], unreadableAtOpen: () => 0, retryIntervalMs: () => 0, drain, requestGraphSettlement,
      remove: async (owed) => { kept.delete(owed); },
      warn: (_ctx, line) => { warnings.push(line); },
    });
    return { owner, kept, warnings, requestGraphSettlement };
  }

  /** An attempt that never reaches real I/O, as one over a closed lane, holds the main thread like this. */
  function holdMainThread(ms: number): void {
    const until = performance.now() + ms;
    while (performance.now() < until) { /* no event-loop turn here */ }
  }

  it('spends one attempt a pass on a closed lane and tries its whole backlog once it opens', async () => {
    const parked = Array.from({ length: 500 }, (_, index) => marker(`parked-${index}`));
    const subGraph = Object.freeze({ ...marker('sub-graph'), subGraphName: 'notes' }) as Rfc64OwedShareInventoryV1;
    const otherGraph = inLane('other-graph', 'other');
    let open = false;
    const drain = vi.fn(async (owed: Readonly<Rfc64OwedShareInventoryV1>) => {
      if (owed === otherGraph) return 'written' as const;
      return open ? 'written' as const : 'lane-closed' as const;
    });
    const { owner, kept, requestGraphSettlement } = backlog([...parked, subGraph, otherGraph], drain);
    owner.start(createOperationContext('system'));
    await owner.whenIdle();
    // A sub-graph of the same graph is a lane of its own, and another graph is not held up.
    expect(drain.mock.calls.map(([owed]) => owed)).toEqual([parked[0], subGraph, otherGraph]);
    expect(kept.size).toBe(501);
    expect(requestGraphSettlement.mock.calls).toEqual([[parked[0]!.contextGraphId]]);
    owner.request();
    await owner.whenIdle();
    expect(drain).toHaveBeenCalledTimes(5);
    open = true;
    owner.request();
    await owner.whenIdle();
    expect(kept.size).toBe(0);
    expect(drain).toHaveBeenCalledTimes(5 + 501);
    await owner.close();
  });

  it('follows a lane that opens during a pass with a pass over its whole backlog', async () => {
    const parked = Array.from({ length: 3 }, (_, index) => marker(`parked-${index}`));
    let open = false;
    const drain = vi.fn(async () => {
      if (open) return 'written' as const;
      // The authority is accepted while this pass still counts the lane as closed.
      open = true;
      fixture.owner.request();
      return 'lane-closed' as const;
    });
    const fixture = backlog(parked, drain);
    fixture.owner.start(createOperationContext('system'));
    await fixture.owner.whenIdle();
    expect(fixture.kept.size).toBe(0);
    expect(drain).toHaveBeenCalledTimes(4);
    await fixture.owner.close();
  });

  it('gives timers a turn between slices of a pass whose attempts never reach real I/O', async () => {
    // Each marker is a lane of its own, so each one gets an attempt.
    const lanes = Array.from({ length: 40 }, (_, index) => inLane(`marker-${index}`, `lane-${index}`));
    let attempts = 0;
    const drain = vi.fn(async () => {
      attempts += 1;
      holdMainThread(1);
      return 'lane-closed' as const;
    });
    const { owner } = backlog(lanes, drain);
    let attemptsWhenTimerRan: number | undefined;
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        attemptsWhenTimerRan = attempts;
        resolve();
      }, 0);
    });
    owner.start(createOperationContext('system'));
    await owner.whenIdle();
    await timer;
    expect(drain).toHaveBeenCalledTimes(lanes.length);
    expect(attemptsWhenTimerRan).toBeLessThan(lanes.length);
    await owner.close();
  });

  it('starts no attempt after a close that arrives while the pass waits for its turn', async () => {
    const lanes = Array.from({ length: 3 }, (_, index) => inLane(`marker-${index}`, `lane-${index}`));
    const drain = vi.fn(async () => {
      // Longer than a slice: the next marker waits for one event-loop turn.
      holdMainThread(12);
      return 'lane-closed' as const;
    });
    const { owner, warnings } = backlog(lanes, drain);
    const closed = new Promise<void>((resolve) => {
      setTimeout(() => { void owner.close().then(resolve); }, 0);
    });
    owner.start(createOperationContext('system'));
    await closed;
    expect(drain).toHaveBeenCalledOnce();
    expect(warnings).toEqual([]);
  });
});

it('coalesces marker notifications per graph and lets the canonical owner deduplicate active work', async () => {
  const requestGraphSettlement = vi.fn();
  const drain = vi.fn(async () => 'waiting' as const);
  const owner = new Rfc64OwedShareInventoryOwnerV1({ list: () => [marker('one'), marker('two')],
    unreadableAtOpen: () => 0, retryIntervalMs: () => 0, drain, requestGraphSettlement,
    remove: async () => { throw new Error('waiting markers must be retained'); }, warn: vi.fn() });
  owner.start(createOperationContext('system'));
  await owner.whenIdle();
  owner.request(); await owner.whenIdle();
  expect(requestGraphSettlement).toHaveBeenCalledTimes(2);
  expect(drain).toHaveBeenCalledTimes(4);
  owner.request(); await owner.whenIdle();
  expect(requestGraphSettlement).toHaveBeenCalledTimes(3);
  await owner.close();
  owner.request(); await owner.whenIdle();
  expect(requestGraphSettlement).toHaveBeenCalledTimes(3);
});
