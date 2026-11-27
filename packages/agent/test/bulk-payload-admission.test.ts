import { expect, it, vi } from 'vitest';
import { StorePriorityScheduler, StoreSchedulerBusyError, DEFAULT_STORE_QUEUE_WAIT_TIMEOUT_MS } from '@origintrail-official/dkg-storage';
import { fixture } from './helpers/bulk-graph-fixture.js';

it('keeps the bulk stream after transient payload admission pressure without replaying a physical read', async () => {
  let releaseNormal!: () => void, releaseRepair!: () => void;
  const timeouts: unknown[] = [];
  const scheduler = new StorePriorityScheduler({ timeoutDiagnosticSink: diagnostic => {
    timeouts.push(diagnostic);
    // Release the occupied slots after the existing queue deadline has rejected
    // the unstarted export. An eventual re-admission must use the same stream.
    setTimeout(() => { releaseNormal(); releaseRepair(); }, 25);
  } });
  const f = await fixture(2, -1, false, { storeScheduler: scheduler, beforeSend: async () => {} });
  const query = f.source.query.bind(f.source);
  const held: Promise<unknown>[] = [];
  let blocked = false;
  const reads = vi.spyOn(f.source, 'query').mockImplementation((sparql, options) => {
    if (!blocked && options?.source === 'sync.responder.exactAssetExport.payload') {
      blocked = true;
      held.push(scheduler.run('normal', 'blazegraph.query', () => new Promise<void>(r => { releaseNormal = r; })));
      held.push(scheduler.run('background', 'agent.durableSync.graphScopedMaterialization',
        () => new Promise<void>(r => { releaseRepair = r; })));
    }
    return query(sparql, options);
  });
  const started = performance.now();
  try {
    const outcome = await f.run().then(result => ({ result }), error => ({
      error: error.message,
      responderErrors: f.responderErrors.map(value => {
        const e = value as { name: string; reason?: string; operation?: string; outcome?: string };
        return { name: e.name, reason: e.reason, operation: e.operation, outcome: e.outcome };
      }),
    }));
    expect(outcome, JSON.stringify(outcome)).toHaveProperty('result');
    if (!('result' in outcome)) throw new Error('Expected completed bulk transfer');
    const result = outcome.result;
    expect(result.committedAssetUals).toEqual(f.uals);
    expect(result.metrics.committedAssets).toBe(2);
    expect(performance.now() - started).toBeGreaterThanOrEqual(DEFAULT_STORE_QUEUE_WAIT_TIMEOUT_MS);
    expect(timeouts).toEqual([expect.objectContaining({
      waiting: { priority: 'normal', operation: 'sync.responder.exactAssetExport.payload' },
    })]);
    expect(reads.mock.calls.filter(([, o]) => o?.source === 'sync.responder.exactAssetExport.payload')).toHaveLength(3);
    expect(f.exports).toEqual([1, 1]);
    expect(f.responderErrors).toEqual([]);
  } finally {
    releaseNormal?.(); releaseRepair?.();
    await Promise.all(held);
    reads.mockRestore();
  }
}, 30_000);

it('reports an exhausted payload admission error and still closes the stream when its observer throws', async () => {
  const diagnostics = vi.fn(() => { throw new Error('observer failed'); });
  const f = await fixture(2, -1, false, { onInboundFailure: diagnostics });
  const query = f.source.query.bind(f.source), operation = 'sync.responder.exactAssetExport.payload';
  const reads = vi.spyOn(f.source, 'query').mockImplementation((sparql, options) => options?.source === operation
    ? Promise.reject(new StoreSchedulerBusyError('queue_wait_timeout', 'normal', operation)) : query(sparql, options));
  try {
    await expect(f.run()).rejects.toThrow('The stream has been reset');
    expect(reads.mock.calls.filter(([, options]) => options?.source === operation)).toHaveLength(3);
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'handler', errorName: 'StoreSchedulerBusyError', errorCode: 'STORE_SCHEDULER_BUSY', signalAborted: false,
    }));
    expect(f.exports).toEqual([]);
  } finally { reads.mockRestore(); }
});
