import { describe, expect, it } from 'vitest';
import {
  createAsyncAdmissionDiagnosticTrace, currentAsyncAdmissionDiagnosticContext,
  withoutAsyncAdmissionDiagnosticContext,
} from '../src/async-admission-diagnostic-context.js';
import { ASYNC_ADMISSION_PHASES, ASYNC_ADMISSION_ROUTES, isAsyncAdmissionPhase, isAsyncAdmissionRoute } from '../src/async-admission-usage.js';

describe('private admission diagnostic context', () => {
  it('accepts every canonical route and phase and rejects values outside that vocabulary', () => {
    for (const route of ASYNC_ADMISSION_ROUTES) for (const phase of ASYNC_ADMISSION_PHASES) {
      expect(isAsyncAdmissionRoute(route)).toBe(true);
      expect(isAsyncAdmissionPhase(phase)).toBe(true);
      const trace = createAsyncAdmissionDiagnosticTrace(route);
      expect(trace.run(phase, currentAsyncAdmissionDiagnosticContext)).toEqual({ requestId: trace.requestId, route, phase });
    }
    for (const invalid of [undefined, null, 0, {}, 'toString', 'TOKEN', '']) {
      expect(isAsyncAdmissionRoute(invalid)).toBe(false);
      expect(isAsyncAdmissionPhase(invalid)).toBe(false);
    }
  });

  it('isolates concurrent requests and restores the caller across async and nested steps', async () => {
    const a = createAsyncAdmissionDiagnosticTrace('publish_async');
    const b = createAsyncAdmissionDiagnosticTrace('share_async');
    expect(a.requestId).not.toBe(b.requestId);
    await Promise.all([a, b].map((trace) => trace.run('snapshot_preflight', async () => {
      await Promise.resolve();
      const own = currentAsyncAdmissionDiagnosticContext();
      expect(own?.requestId).toBe(trace.requestId);
      expect(Object.isFrozen(own)).toBe(true);
      await trace.run('enqueue', async () => {
        expect(currentAsyncAdmissionDiagnosticContext()?.phase).toBe('enqueue');
      });
      expect(currentAsyncAdmissionDiagnosticContext()).toBe(own);
      await withoutAsyncAdmissionDiagnosticContext(async () => {
        await Promise.resolve();
        expect(currentAsyncAdmissionDiagnosticContext()).toBeUndefined();
      });
      expect(currentAsyncAdmissionDiagnosticContext()).toBe(own);
    })));
    expect(currentAsyncAdmissionDiagnosticContext()).toBeUndefined();
  });

  it('keeps invalid internal labels out of context without changing return or error identity', () => {
    const trace = createAsyncAdmissionDiagnosticTrace('publish_async');
    const failure = new Error('original');
    expect(trace.run('payload/secret' as never, () => currentAsyncAdmissionDiagnosticContext())).toBeUndefined();
    expect(createAsyncAdmissionDiagnosticTrace('secret' as never).run('enqueue', () => 42)).toBe(42);
    expect(() => trace.run('enqueue', () => { throw failure; })).toThrow(failure);
    expect(currentAsyncAdmissionDiagnosticContext()).toBeUndefined();
  });
});
