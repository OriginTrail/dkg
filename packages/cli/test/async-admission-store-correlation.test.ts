import { createServer, request, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASYNC_ADMISSION_PHASES, ASYNC_ADMISSION_ROUTES, Logger, asyncAdmissionUsage, createAsyncAdmissionDiagnosticTrace, currentAsyncAdmissionDiagnosticContext } from '@origintrail-official/dkg-core';
import { StorePriorityScheduler } from '../../storage/src/store-priority-scheduler.js';
import { admissionStep, beginAsyncAdmissionTrace, noteAdmissionResponse } from '../src/daemon/async-admission-trace.js';
import { createAdmissionTraceReporter } from '../src/daemon/async-admission-trace-diagnostics.js';

afterEach(() => vi.restoreAllMocks());

describe('admission private trace diagnostics', () => {
  it('reports every canonical route and phase without accepting arbitrary labels', () => {
    const emit = vi.fn();
    const report = createAdmissionTraceReporter({ emit });
    for (const route of ASYNC_ADMISSION_ROUTES) for (const phase of ASYNC_ADMISSION_PHASES) {
      const trace = createAsyncAdmissionDiagnosticTrace(route);
      trace.run(phase, () => report(currentAsyncAdmissionDiagnosticContext()!, 503, 20_000));
      expect(JSON.parse(emit.mock.lastCall![0])).toMatchObject({ requestId: trace.requestId, route, phase });
    }
    expect(emit).toHaveBeenCalledTimes(ASYNC_ADMISSION_ROUTES.length * ASYNC_ADMISSION_PHASES.length);
  });

  it('bounds warning keys independently of request IDs and emits no caller payload or arbitrary labels', async () => {
    let now = 0;
    const emit = vi.fn();
    const report = createAdmissionTraceReporter({ emit, now: () => now });
    const context = createAsyncAdmissionDiagnosticTrace('publish_async').run('snapshot_preflight', () => currentAsyncAdmissionDiagnosticContext()!);
    for (let i = 0; i < 100; i++) report({ ...context, requestId: createAsyncAdmissionDiagnosticTrace('publish_async').requestId }, 0, 30_000);
    expect(emit).toHaveBeenCalledTimes(1);
    now = 60_000;
    report({ ...context, payload: 'PRIVATE', code: 'TOKEN', query: 'SECRET' } as never, 503, 13_000);
    const event = JSON.parse(emit.mock.calls[1]![0]);
    expect(Object.keys(event).sort()).toEqual(['elapsedMs', 'event', 'outcome', 'phase', 'requestId', 'route', 'status']);
    report({ ...context, route: 'TOKEN' } as never, 503, 20_000);
    report({ ...context, phase: 'TOKEN' } as never, 503, 20_000);
    report({ ...context, requestId: 'TOKEN' }, 503, 20_000);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(emit.mock.calls)).not.toMatch(/PRIVATE|TOKEN|SECRET/);
    const failing = createAdmissionTraceReporter({ emit: () => { throw new Error('sink'); } });
    expect(() => failing(context, 0, 30_000)).not.toThrow();
    const rejecting = createAdmissionTraceReporter({ emit: async () => { throw new Error('sink'); } });
    rejecting(context, 0, 30_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('retains the same request across real HTTP client close and a subsequent late enqueue, without cancelling or replaying', async () => {
    asyncAdmissionUsage.reset();
    const warnings: Record<string, unknown>[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((_ctx, message) => { warnings.push(JSON.parse(message)); });
    const scheduler = new StorePriorityScheduler();
    let release!: () => void;
    let arrived!: (res: ServerResponse) => void;
    let finished!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const entering = new Promise<ServerResponse>((resolve) => { arrived = resolve; });
    const done = new Promise<void>((resolve) => { finished = resolve; });
    const contexts: unknown[] = [];
    let admissions = 0;
    const server = createServer((req, res) => {
      void (async () => {
        beginAsyncAdmissionTrace(req.method, req.url!, res);
        await admissionStep(res, 'snapshot_preflight', () => scheduler.run('normal', 'blazegraph.query', async () => {
          contexts.push(currentAsyncAdmissionDiagnosticContext());
          arrived(res);
          await blocked;
        }));
        await admissionStep(res, 'enqueue', async () => {
          contexts.push(currentAsyncAdmissionDiagnosticContext());
          admissions++;
        });
        noteAdmissionResponse(res, 202, JSON.stringify({ jobId: 'PRIVATE_JOB' }));
        noteAdmissionResponse(res, 503, JSON.stringify({ code: 'PRIVATE_DUPLICATE' }));
        res.emit('close'); // A duplicate close must not replace the original HTTP outcome.
        res.end();
      })().finally(finished);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing loopback address');
    const client = request({ host: '127.0.0.1', port: address.port, method: 'POST', path: '/api/knowledge-assets/PRIVATE_ASSET/vm/publish-async' });
    client.on('error', () => undefined);
    try {
      client.end();
      const res = await entering;
      const closed = once(res, 'close');
      client.destroy();
      await closed;
      release();
      await done;
      expect(admissions).toBe(1);
      const [before, after] = contexts as Array<{ requestId: string; phase: string }>;
      expect(after?.requestId).toBe(before?.requestId);
      expect(after?.phase).toBe('enqueue');
      expect(warnings.map((event) => [event.outcome, event.status, event.phase, event.requestId])).toEqual([
        ['response_closed', 0, 'snapshot_preflight', before?.requestId],
        ['answer_after_close', 202, 'enqueue', before?.requestId],
      ]);
      expect(JSON.stringify(warnings)).not.toMatch(/PRIVATE_ASSET|PRIVATE_JOB|PRIVATE_DUPLICATE/);
      expect(asyncAdmissionUsage.take().http).toEqual([
        { route: 'publish_async', phase: 'snapshot_preflight', status: 0, code: 'client_closed', count: 1 },
      ]);
    } finally {
      release(); client.destroy(); server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
