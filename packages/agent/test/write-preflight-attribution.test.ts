import { sanitizeWritePreflightFailures } from '../src/write-preflight-attribution.js';
import { describe, expect, it, vi } from 'vitest';
import { StoreOperationTimeoutError, StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';

const caller = '0x2222222222222222222222222222222222222222';
const timeout = () => new StoreOperationTimeoutError({ backend: 'test', operation: 'query', outcome: 'not_started' });
const sites = ['existence', 'content', 'subscription', 'declaration', 'caller-access'] as const;
function harness(failures: Record<string, unknown> = {}) {
  const read = (site: string, value: unknown) => vi.fn(async () => {
    if (site in failures) throw failures[site];
    return value;
  });
  return {
    contextGraphExists: read('existence', true),
    contextGraphHasLocalContent: read('content', true),
    config: { contextGraphSubscriptionStore: { load: read('subscription', null) } },
    store: { query: read('declaration', { type: 'bindings', bindings: [
      { kind: 'declared' }, { kind: 'access', value: 'private' },
    ] }) },
    subscribedContextGraphs: new Map(),
    curatorDidMatchesChecksumAgent: () => false,
    callerIsAllowlistedAgentParticipant: read('caller-access', false),
  };
}
const probe = (h: ReturnType<typeof harness>) => ContextGraphResolveMethods.prototype
  .probeContextGraphWritePreflight.call(h as never, 'owner/graph', { callerAgentAddress: caller });

describe('write preflight failure attribution', () => {
  it.each(sites)('retains the failed %s site without changing read count', async site => {
    const h = harness({ [site]: timeout() });
    const result = await probe(h);
    expect(result.storeAvailable).toBe(false);
    expect((result as any).failureAttribution).toEqual([{ site, kind: 'store-not-started' }]);
    expect(h.contextGraphExists).toHaveBeenCalledTimes(1);
    expect(h.contextGraphHasLocalContent).toHaveBeenCalledTimes(1);
    expect(h.config.contextGraphSubscriptionStore.load).toHaveBeenCalledTimes(1);
    expect(h.store.query).toHaveBeenCalledTimes(1);
  });
  it('retains all independent failed sites, with no first-cause claim or raw error', async () => {
    const secret = new Error('https://user:secret@provider/private?token=abc');
    const h = harness({ existence: secret, content: timeout(), subscription: secret, declaration: secret });
    const result = await probe(h);
    expect((result as any).failureAttribution).toEqual([
      { site: 'existence', kind: 'unknown' }, { site: 'content', kind: 'store-not-started' },
      { site: 'subscription', kind: 'unknown' }, { site: 'declaration', kind: 'unknown' },
    ]);
    expect(JSON.stringify((result as any).failureAttribution)).not.toContain('secret');
  });
  it('keeps ordinary denied/private evidence and reads unchanged', async () => {
    const h = harness(); const result = await probe(h);
    expect(result).toMatchObject({ storeAvailable: true, accessPolicy: 'private', callerAuthorized: false });
    expect((result as any).failureAttribution ?? []).toEqual([]);
    expect(h.callerIsAllowlistedAgentParticipant).toHaveBeenCalledTimes(1);
  });
  it('classifies only known typed outcomes, never a message that sounds like a timeout', async () => {
    const h = harness({ existence: new Error('STORE_OPERATION_TIMEOUT not_started'),
      content: new StoreOperationTimeoutError({ backend: 'test', operation: 'query' }),
      subscription: new StoreSchedulerBusyError('queue_full', 'normal', 'test') });
    const result = await probe(h);
    expect((result as any).failureAttribution).toEqual([
      { site: 'existence', kind: 'unknown' }, { site: 'content', kind: 'deadline' },
      { site: 'subscription', kind: 'store-not-started' },
    ]);
  });
});


it('snapshots diagnostic getters once and bounds malicious input without reflecting it', () => {
  let reads = 0;
  const row = { get site() { return ++reads === 1 ? 'existence' : 'https://secret'; }, kind: 'unknown' };
  expect(sanitizeWritePreflightFailures([row])).toEqual([{ site: 'existence', kind: 'unknown' }]);
  expect(reads).toBe(1);
  expect(sanitizeWritePreflightFailures(new Proxy([], { get() { throw new Error('private'); } })))
    .toEqual([{ site: 'decision', kind: 'unknown' }]);
  expect(sanitizeWritePreflightFailures(Array(1000).fill({ site: 'secret', kind: 'token' })))
    .toEqual([{ site: 'decision', kind: 'unknown' }]);
});
