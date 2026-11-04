import { describe, expect, it } from 'vitest';
import {
  createAsyncAdmissionDiagnosticTrace, currentAsyncAdmissionDiagnosticContext,
  withoutAsyncAdmissionDiagnosticContext,
} from '../src/async-admission-diagnostic-context.js';

describe('private admission diagnostic context', () => {
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
