import { describe, expect, it, vi } from 'vitest';
import { StoreOperationTimeoutError, StoreSchedulerBusyError, type QueryResult } from '@origintrail-official/dkg-storage';
import { probeContextGraphWritePreflight } from '../src/context-graph-write-preflight.js';

const caller = '0x2222222222222222222222222222222222222222';
const timeout = () => new StoreOperationTimeoutError({ backend: 'test', operation: 'query', outcome: 'not_started' });
const sites = ['existence', 'content', 'subscription', 'declaration', 'caller-access'] as const;
function harness(failures: Record<string, unknown> = {}) {
  const read = <T>(site: string, value: T) => vi.fn(async () => {
    if (site in failures) throw failures[site];
    return value;
  });
  return {
    contextGraphExists: read('existence', true),
    contextGraphHasLocalContent: read('content', true),
    subscriptionStore: { load: read('subscription', null) },
    store: { query: read<QueryResult>('declaration', { type: 'bindings', bindings: [
      { kind: 'declared' }, { kind: 'access', value: 'private' },
    ] }) },
    curatorDidMatchesChecksumAgent: () => false,
    callerIsAllowlistedAgentParticipant: read('caller-access', false),
  };
}
const probe = (h: ReturnType<typeof harness>) => probeContextGraphWritePreflight(h,
  { store: h.subscriptionStore, current: () => undefined }, 'owner/graph', { callerAgentAddress: caller });

describe('write preflight failure attribution', () => {
  it.each(sites)('retains the failed %s site without changing read count', async site => {
    const h = harness({ [site]: timeout() });
    const result = await probe(h);
    expect(result.storeAvailable).toBe(false);
    expect(result.failureAttribution).toEqual([{ site, kind: 'store-not-started' }]);
    expect(h.contextGraphExists).toHaveBeenCalledTimes(1);
    expect(h.contextGraphHasLocalContent).toHaveBeenCalledTimes(1);
    expect(h.subscriptionStore.load).toHaveBeenCalledTimes(1);
    expect(h.store.query).toHaveBeenCalledTimes(1);
  });
  it('retains all independent failed sites, with no first-cause claim or raw error', async () => {
    const secret = new Error('https://user:secret@provider/private?token=abc');
    const h = harness({ existence: secret, content: timeout(), subscription: secret, declaration: secret });
    const result = await probe(h);
    expect(result.failureAttribution).toEqual([
      { site: 'existence', kind: 'unknown' }, { site: 'content', kind: 'store-not-started' },
      { site: 'subscription', kind: 'unknown' }, { site: 'declaration', kind: 'unknown' },
    ]);
    expect(JSON.stringify(result.failureAttribution)).not.toContain('secret');
  });
  it('keeps ordinary denied/private evidence and reads unchanged', async () => {
    const h = harness(); const result = await probe(h);
    expect(result).toMatchObject({ storeAvailable: true, accessPolicy: 'private', callerAuthorized: false });
    expect(result.failureAttribution ?? []).toEqual([]);
    expect(h.callerIsAllowlistedAgentParticipant).toHaveBeenCalledTimes(1);
  });
  it('classifies only known typed outcomes, never a message that sounds like a timeout', async () => {
    const h = harness({ existence: new Error('STORE_OPERATION_TIMEOUT not_started'),
      content: new StoreOperationTimeoutError({ backend: 'test', operation: 'query' }),
      subscription: new StoreSchedulerBusyError('queue_full', 'normal', 'test') });
    const result = await probe(h);
    expect(result.failureAttribution).toEqual([
      { site: 'existence', kind: 'unknown' }, { site: 'content', kind: 'deadline' },
      { site: 'subscription', kind: 'store-not-started' },
    ]);
  });
});
