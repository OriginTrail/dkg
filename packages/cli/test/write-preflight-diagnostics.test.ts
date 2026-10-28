import { sanitizeWritePreflightFailures } from '../src/daemon/write-preflight-attribution.js';
import { WRITE_PREFLIGHT_SITES } from '@origintrail-official/dkg-agent/write-preflight-attribution';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OxigraphWorkerStore } from '@origintrail-official/dkg-storage';
import { ContextGraphResolveMethods } from '../../agent/src/dkg-agent-cg-resolve.js';
import { describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { resolveRequiredWriteContextGraphId } from '../src/daemon/http-utils.js';
import { createWritePreflightDiagnostics, recordWritePreflightUnavailable } from '../src/daemon/write-preflight-diagnostics.js';

const qualified = '0x1111111111111111111111111111111111111111/diagnostics';
function response() {
  const out: { status?: number; body?: any; headers?: Record<string, string> } = {};
  const res = {
    writeHead(status: number, headers: Record<string, string>) { out.status = status; out.headers = headers; },
    end(body: string) { out.body = JSON.parse(body); },
  } as unknown as ServerResponse;
  return { res, out };
}
function provider(probe: unknown) {
  return { probeContextGraphWritePreflight: vi.fn(async () => probe as any),
    listContextGraphs: vi.fn(async () => [] as any[]),
  };
}
const opts = (record = vi.fn()) => ({ writePreflightDiagnostics: { record }, chainRescueTimeoutMs: 5 });

it('composes agent and daemon sites while retaining the nine-entry diagnostic limit', () => {
  expect(WRITE_PREFLIGHT_SITES).toEqual(['existence', 'content', 'subscription', 'declaration', 'caller-access']);
  const sites = [...WRITE_PREFLIGHT_SITES, 'exact-probe', 'metadata', 'list', 'decision'];
  const failures = sites.map(site => ({ site, kind: 'unknown' }));
  expect(sanitizeWritePreflightFailures([...failures, { site: 'decision', kind: 'deadline' }])).toEqual(failures);
});

describe('write preflight response diagnostics', () => {
  it.each(['existence', 'content', 'subscription', 'declaration', 'caller-access'])('carries %s failure through the exact decision to one correlated 503', async site => {
    const agent = provider({ storeAvailable: false, storeUnavailable: true, storeErrorMessage: 'existing error',
      failureAttribution: [{ site, kind: 'store-not-started' }] });
    const { res, out } = response(); const options = opts();
    expect(await resolveRequiredWriteContextGraphId(agent, qualified, res, options)).toBeNull();
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ code: 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE',
      error: 'Failed to validate contextGraphId against known context graphs: exact preflight failed: existing error' });
    expect(agent.probeContextGraphWritePreflight).toHaveBeenCalledTimes(1);
    expect(agent.listContextGraphs).not.toHaveBeenCalled();
    expect(options.writePreflightDiagnostics.record).toHaveBeenCalledTimes(1);
    const [ctx, diagnostic] = options.writePreflightDiagnostics.record.mock.calls[0];
    expect(out.headers?.['x-dkg-operation-id']).toBe(ctx.operationId);
    expect(diagnostic).toEqual({ failures: [{ site, kind: 'store-not-started' }], rescue: 'unsupported' });
  });
  it.each([
    [{ storeAvailable: true }, 'existence'],
    [{ storeAvailable: true, exists: true, hasLocalContent: true, declarationFound: false }, 'metadata'],
  ])('attributes incomplete evidence without a rescue or extra read', async (probe, site) => {
    const agent = provider(probe); const { res, out } = response(); const options = opts();
    await resolveRequiredWriteContextGraphId(agent, qualified, res, options);
    expect(out.status).toBe(503); expect(agent.listContextGraphs).not.toHaveBeenCalled();
    expect(options.writePreflightDiagnostics.record.mock.calls[0][1]).toEqual({
      failures: [{ site, kind: 'incomplete' }], rescue: 'not-attempted',
    });
  });
  it.each(['denied', 'deadline', 'failed'] as const)('reports rescue %s without changing its fail-closed result', async outcome => {
    const agent = { ...provider({ storeAvailable: false, storeUnavailable: true }),
      validateWriteTargetDuringStoreOutage: vi.fn(() => outcome === 'deadline' ? new Promise<boolean>(() => {})
        : outcome === 'failed' ? Promise.reject(new Error('secret rpc body')) : Promise.resolve(false)),
    };
    const { res, out } = response(); const options = opts();
    // Keep a bounded timer alive: the production rescue timeout is unref'ed.
    const keepAlive = setTimeout(() => {}, 1000);
    try { await resolveRequiredWriteContextGraphId(agent, qualified, res, options); }
    finally { clearTimeout(keepAlive); }
    expect(out.status).toBe(503); expect(agent.validateWriteTargetDuringStoreOutage).toHaveBeenCalledTimes(1);
    expect(options.writePreflightDiagnostics.record.mock.calls[0][1].rescue).toBe(outcome);
    expect(JSON.stringify(options.writePreflightDiagnostics.record.mock.calls)).not.toContain('secret');
  });
  it('keeps unexpected probe/list failures unknown and records both actual sites', async () => {
    const agent = provider(null); agent.probeContextGraphWritePreflight.mockRejectedValue(new Error('secret probe'));
    agent.listContextGraphs.mockRejectedValue(new Error('secret list'));
    const { res } = response(); const options = opts();
    await resolveRequiredWriteContextGraphId(agent, 'bare-name', res, options);
    expect(options.writePreflightDiagnostics.record.mock.calls[0][1]).toEqual({
      failures: [{ site: 'exact-probe', kind: 'unknown' }, { site: 'list', kind: 'unknown' }], rescue: 'unsupported',
    });
    expect(agent.listContextGraphs).toHaveBeenCalledTimes(1);
  });
  it('observer exceptions and malicious diagnostic getters do not change the response', async () => {
    const probe = { storeAvailable: false, storeUnavailable: true, get failureAttribution() { throw new Error('private'); } };
    const agent = provider(probe); const { res, out } = response(); const record = vi.fn(() => { throw new Error('observer'); });
    await expect(resolveRequiredWriteContextGraphId(agent, qualified, res, opts(record))).resolves.toBeNull();
    expect(out.status).toBe(503); expect(agent.listContextGraphs).not.toHaveBeenCalled(); expect(record).toHaveBeenCalledTimes(1);
  });
  it.each([
    { storeAvailable: true, exists: false },
    { storeAvailable: true, exists: true, declarationFound: true, accessPolicy: 'private', callerAuthorized: false },
  ])('keeps unknown/private denial without emitting an unavailable event', async probe => {
    const agent = provider(probe); const { res, out } = response(); const options = opts();
    await resolveRequiredWriteContextGraphId(agent, qualified, res, { ...options, callerAgentAddress: '0x2222222222222222222222222222222222222222' });
    expect(out.status).toBe(400); expect(out.body.code).toBe('CONTEXT_GRAPH_NOT_FOUND');
    expect(options.writePreflightDiagnostics.record).not.toHaveBeenCalled();
  });
  it('redacts closed fields and bounds attribution without replacing the renderer context', () => {
    const observer = { record: vi.fn() }; const ctx = createOperationContext('resolve');
    const row = { site: 'https://user:secret@rpc', kind: 'private payload' };
    recordWritePreflightUnavailable(ctx, Array(1000).fill(row), 'failed', observer);
    expect(observer.record).toHaveBeenCalledExactlyOnceWith(ctx, {
      failures: [{ site: 'decision', kind: 'unknown' }], rescue: 'failed',
    });
  });
  it('bounds warning state while retaining repeated informational messages', () => {
    let now = 0; const logger = { warn: vi.fn(), info: vi.fn() };
    const recorder = createWritePreflightDiagnostics({ logger, now: () => now, intervalMs: 100, cacheMax: 1 });
    const a = { failures: [{ site: 'existence' as const, kind: 'unknown' as const }], rescue: 'unsupported' as const };
    recorder.record(createOperationContext('resolve'), a); recorder.record(createOperationContext('resolve'), a);
    expect(logger.warn).toHaveBeenCalledTimes(1); expect(logger.info).toHaveBeenCalledTimes(1);
    recorder.record(createOperationContext('resolve'), { ...a, rescue: 'denied' });
    recorder.record(createOperationContext('resolve'), a); // A was evicted, bounded cache size is one.
    expect(logger.warn).toHaveBeenCalledTimes(3);
    now = 101; recorder.record(createOperationContext('resolve'), a);
    expect(logger.warn).toHaveBeenCalledTimes(4);
  });
});


it('correlates a real HTTP 503 after a real Oxigraph worker closes', async () => {
  const store = new OxigraphWorkerStore(); await store.query('ASK {}'); await store.close();
  const proto = ContextGraphResolveMethods.prototype;
  const harness = { store, config: {}, subscribedContextGraphs: new Map(),
    contextGraphExists: proto.contextGraphExists, contextGraphHasLocalContent: proto.contextGraphHasLocalContent,
  };
  const agent = { listContextGraphs: vi.fn(async () => []),
    probeContextGraphWritePreflight: (id: string) => proto.probeContextGraphWritePreflight.call(harness as never, id),
  };
  const logger = { warn: vi.fn(), info: vi.fn() };
  const options = { writePreflightDiagnostics: createWritePreflightDiagnostics({ logger, now: () => 0 }) };
  const server = createServer((_req, res) => {
    void resolveRequiredWriteContextGraphId(agent, qualified, res, options).catch(() => { res.writeHead(500); res.end(); });
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No listener');
    const ids: string[] = [];
    for (const level of ['warn', 'info'] as const) {
      const result = await fetch(`http://127.0.0.1:${address.port}/preflight`, { signal: AbortSignal.timeout(5000) });
      expect(result.status).toBe(503); expect((await result.json() as any).code).toBe('CONTEXT_GRAPH_VALIDATION_UNAVAILABLE');
      expect(logger[level]).toHaveBeenCalledTimes(1);
      const [ctx, message] = logger[level].mock.calls[0];
      const responseId = result.headers.get('x-dkg-operation-id');
      expect(responseId).toMatch(/^[a-f0-9-]{36}$/);
      expect(ctx.operationId).toBe(responseId);
      expect(ctx.operationName).toBe('resolve');
      expect(message).toContain('Context Graph write preflight unavailable, answered 503');
      expect(message).toContain('failures=' + JSON.stringify([
        { site: 'existence', kind: 'unknown' }, { site: 'content', kind: 'unknown' },
        { site: 'declaration', kind: 'unknown' },
      ]));
      expect(message).toContain('rescue=unsupported');
      ids.push(responseId!);
    }
    expect(new Set(ids).size).toBe(2);
    expect(logger.warn).toHaveBeenCalledTimes(1); expect(logger.info).toHaveBeenCalledTimes(1);
    expect(agent.listContextGraphs).not.toHaveBeenCalled();
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});


it('contains an asynchronously rejected diagnostic observer without delaying HTTP', async () => {
  const agent = provider({ storeAvailable: false, storeUnavailable: true });
  const { res, out } = response();
  await expect(resolveRequiredWriteContextGraphId(agent, qualified, res,
    opts(vi.fn(async () => { throw new Error('observer failed asynchronously'); })),
  )).resolves.toBeNull();
  expect(out.status).toBe(503);
});


it.each([qualified, 'bare-name'])('keeps accepted rescue control flow without an unavailable diagnostic for %s', async candidate => {
  const agent = { ...provider({ storeAvailable: false, storeUnavailable: true }),
    validateWriteTargetDuringStoreOutage: vi.fn(async () => true),
  };
  agent.listContextGraphs.mockRejectedValue(new Error('store down'));
  const { res, out } = response(); const options = opts();
  expect(await resolveRequiredWriteContextGraphId(agent, candidate, res, options)).toBe(candidate);
  expect(agent.validateWriteTargetDuringStoreOutage).toHaveBeenCalledTimes(1);
  expect(agent.listContextGraphs).toHaveBeenCalledTimes(candidate === qualified ? 0 : 1);
  expect(options.writePreflightDiagnostics.record).not.toHaveBeenCalled();
  expect(out.status).toBeUndefined();
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
