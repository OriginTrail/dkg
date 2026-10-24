import { afterEach, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import * as recoveryGraph from '../src/durable-recovery-graph.js';
import type { runDurableSync } from '../src/sync/requester/durable-sync.js';

const ctx = createOperationContext('sync');
const contextGraphId = 'serialized-graph';
afterEach(() => vi.restoreAllMocks());

it('serializes non-coalesced operations across separately bound recovery hosts', async () => {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let active = 0;
  let maximumActive = 0;
  vi.spyOn(recoveryGraph, 'runAdmittedDurableGraph').mockImplementation(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    entered();
    await held;
    active -= 1;
    return { result: {} as Awaited<ReturnType<typeof runDurableSync>> };
  });
  const agentLike = {
    config: {},
    runContextGraphSyncWithBackpressure: async (
      _ctx: unknown, _graph: string, _lane: string, _label: string,
      work: () => Promise<unknown>,
    ) => work(),
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  } as any;
  const run = () => LifecycleSyncMethods.prototype.runLegacyDurableSyncDetailed.call(
    agentLike, ctx, 'serialized-peer', [contextGraphId], undefined, undefined, undefined,
    { signal: new AbortController().signal },
  );
  const first = run();
  await started;
  const second = run();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(maximumActive).toBe(1);
  } finally {
    release();
    await Promise.all([first, second]);
  }
  expect(maximumActive).toBe(1);
});
