import { describe, expect, it } from 'vitest';

import {
  Rfc64ReceiverTaskLifecycleV1,
  rfc64ReceiverSchedulingPolicyV1,
  type Rfc64ReceiverLifecycleTaskV1,
} from '../src/rfc64/public-catalog-receiver-task-lifecycle-v1.js';

const CG_A = '0x1111111111111111111111111111111111111111/a';
const CG_B = '0x2222222222222222222222222222222222222222/b';

function task(contextGraphId: string, key: string): Rfc64ReceiverLifecycleTaskV1 {
  return {
    key,
    scopeKey: `${contextGraphId}|scope`,
    contextGraphId,
    catalogVersion: 1n,
    schedulingPolicy: rfc64ReceiverSchedulingPolicyV1('ambient'),
    cancellation: new AbortController(),
  };
}

function lifecycle(): Rfc64ReceiverTaskLifecycleV1<Rfc64ReceiverLifecycleTaskV1> {
  return new Rfc64ReceiverTaskLifecycleV1<Rfc64ReceiverLifecycleTaskV1>(() => {});
}

describe('RFC-64 receiver task lifecycle: per-context-graph idleness', () => {
  it('reports one context graph idle while another still has queued work', () => {
    const tasks = lifecycle();
    tasks.schedule(task(CG_B, 'b-1'));

    expect(tasks.isIdle).toBe(false);
    expect(tasks.isIdleForContextGraph(CG_B)).toBe(false);
    // The whole point: A's replay pass must not be held open by B's queue.
    expect(tasks.isIdleForContextGraph(CG_A)).toBe(true);
  });

  it('counts a queued task of its own context graph as busy', () => {
    const tasks = lifecycle();
    tasks.schedule(task(CG_A, 'a-1'));

    expect(tasks.isIdleForContextGraph(CG_A)).toBe(false);
  });

  it('counts an active task of its own context graph as busy', () => {
    const tasks = lifecycle();
    const running = task(CG_A, 'a-1');
    tasks.schedule(running);
    const next = tasks.takeNextRunnable();
    expect(next).toBe(running);
    tasks.begin(running);

    expect(tasks.isIdleForContextGraph(CG_A)).toBe(false);
    expect(tasks.isIdleForContextGraph(CG_B)).toBe(true);
  });

  it('counts a DEFERRED task of its own context graph as busy', () => {
    const tasks = lifecycle();
    const waiting = task(CG_A, 'a-1');
    tasks.schedule(waiting);
    expect(tasks.takeNextRunnable()).toBe(waiting);
    // A task parked on its retry timer is work this graph has not finished.
    // Treating it as idle would let a replay pass declare completion while an
    // admission is still pending — a fail-OPEN reading of the same predicate.
    expect(tasks.defer(waiting, 60_000, () => {})).toBe(true);

    expect(tasks.deferredCount).toBe(1);
    expect(tasks.isIdleForContextGraph(CG_A)).toBe(false);
    expect(tasks.isIdleForContextGraph(CG_B)).toBe(true);

    tasks.clearDeferredTimers();
  });

  it('reports idle for a context graph with no tasks at all', () => {
    expect(lifecycle().isIdleForContextGraph(CG_A)).toBe(true);
  });
});
