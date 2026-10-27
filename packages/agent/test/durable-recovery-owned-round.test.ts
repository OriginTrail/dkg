import { afterEach, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { runGraphOwnedDurableRecovery, type GraphOwnedDurableRecoveryRequest } from '../src/durable-recovery-owned-round.js';
import { SyncBackpressureBusyError } from '../src/sync/backpressure.js';
import { createIncompleteDurableSyncResult } from '../src/sync/durable-progress.js';
import type { DurableRecoveryRoundDecision } from '../src/sync/durable-recovery-round.js';
import * as graph from '../src/durable-recovery-graph.js';

afterEach(() => vi.restoreAllMocks());
function request(): GraphOwnedDurableRecoveryRequest {
  return { host: { owner: {}, admission: { run: vi.fn(async input => input.work()) },
    log: { info: vi.fn() } } as unknown as GraphOwnedDurableRecoveryRequest['host'],
    authority: {} as GraphOwnedDurableRecoveryRequest['authority'], ctx: createOperationContext('sync'),
    remotePeerId: 'peer', contextGraphId: 'owned-cg', recovery: { meta: {}, holdings: {} } };
}
it.each<DurableRecoveryRoundDecision>([
  { strategy: 'held' }, { strategy: 'exact-missing', batches: [[{ ual: 'asset', assertionVersion: '1' }]] },
  { strategy: 'full', continuation: 'reconsider-holdings' }, { strategy: 'legacy' },
])('returns an explicit $strategy decision from exactly one admitted graph', async decision => {
  const result = createIncompleteDurableSyncResult();
  const physical = vi.spyOn(graph, 'runAdmittedGraphOwnedDurableGraph').mockResolvedValue({ result, decision });
  const input = request();
  expect(await runGraphOwnedDurableRecovery(input)).toEqual({ result, decision });
  expect(physical).toHaveBeenCalledOnce();
  expect(physical.mock.calls[0]![0]).toMatchObject({ contextGraphId: input.contextGraphId, recovery: input.recovery });
});
it.each(['cancelled', 'deferred'] as const)('reports not-started explicitly for %s admission', async state => {
  const physical = vi.spyOn(graph, 'runAdmittedGraphOwnedDurableGraph');
  const input = request();
  const controller = new AbortController();
  if (state === 'cancelled') controller.abort();
  else vi.mocked(input.host.admission.run).mockRejectedValue(new SyncBackpressureBusyError('busy'));
  const outcome = await runGraphOwnedDurableRecovery({ ...input, options: { signal: controller.signal } });
  expect(outcome.decision).toEqual({ strategy: 'not-started' });
  expect(outcome.result.complete).toBe(false);
  expect(outcome.result.deferredBackpressure).toBe(state === 'deferred' ? 1 : 0);
  expect(physical).not.toHaveBeenCalled();
});
