import { afterEach, describe, expect, it, vi } from 'vitest';

import { Rfc64CoalescingSupervisorV1 } from
  '../src/rfc64/coalescing-supervisor-v1.js';
import { resolveRfc64RuntimeCatalogBootstrapConfigV1 } from
  '../src/rfc64/public-catalog-activation-config-v1.js';
import { boundedRfc64SupervisorErrorV1 } from
  '../src/rfc64/supervisor-status-v1.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('RFC-64 coalescing supervisor', () => {
  it('drops overlapping requests when the workload selects fixed-cadence semantics', async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let passes = 0;
    const runner = new Rfc64CoalescingSupervisorV1({
      requestWhileRunning: 'drop',
      runPass: async () => {
        passes += 1;
        markStarted();
        await gate;
      },
      onError: () => undefined,
      closingMessage: 'test closing',
    });

    expect(runner.request()).toBe(true);
    await started;
    expect(runner.request()).toBe(false);
    release();
    await runner.whenIdle();
    expect(passes).toBe(1);
    await runner.close();
  });

  it('does not let frequent live work postpone a failed scope periodic retry', async () => {
    vi.useFakeTimers();
    const dirty = new Set(['failed-scope', 'live-scope']);
    const attempts = new Map<string, number>();
    const runner = new Rfc64CoalescingSupervisorV1({
      retryIntervalMs: 1_000,
      runPass: async () => {
        for (const scope of dirty) {
          dirty.delete(scope);
          attempts.set(scope, (attempts.get(scope) ?? 0) + 1);
        }
      },
      onError: () => undefined,
      beforePeriodicPass: () => {
        dirty.add('failed-scope');
        dirty.add('live-scope');
      },
      closingMessage: 'test closing',
    });

    runner.request();
    await runner.whenIdle();
    expect(attempts.get('failed-scope')).toBe(1);

    for (let index = 0; index < 3; index += 1) {
      await vi.advanceTimersByTimeAsync(250);
      dirty.add('live-scope');
      runner.request();
      await runner.whenIdle();
    }
    expect(attempts.get('failed-scope')).toBe(1);

    await vi.advanceTimersByTimeAsync(250);
    await runner.whenIdle();
    expect(attempts.get('failed-scope')).toBe(2);
    expect(attempts.get('live-scope')).toBeGreaterThanOrEqual(4);
    await runner.close();
  });

  it('normalizes current and legacy bootstrap fields through one boundary', () => {
    const current = Object.freeze({
      acceptedPolicies: Object.freeze([]),
      retryIntervalMs: 250,
    });
    const legacy = Object.freeze({
      acceptedPublicPolicies: Object.freeze([]),
      retryIntervalMs: 500,
    });

    expect(resolveRfc64RuntimeCatalogBootstrapConfigV1(current, legacy)).toBe(current);
    expect(resolveRfc64RuntimeCatalogBootstrapConfigV1(undefined, legacy)).toEqual({
      acceptedPolicies: [],
      retryIntervalMs: 500,
    });
    expect(resolveRfc64RuntimeCatalogBootstrapConfigV1(undefined, undefined)).toBeUndefined();
  });

  it('bounds supervisor errors by UTF-8 bytes without splitting characters', () => {
    const bounded = boundedRfc64SupervisorErrorV1(new Error('🙂'.repeat(300)));
    expect(new TextEncoder().encode(bounded).byteLength).toBe(1_024);
    expect(bounded).toBe('🙂'.repeat(256));
  });
});
