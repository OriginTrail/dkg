import { describe, expect, it } from 'vitest';
import { IntervalLatency } from '../src/interval-latency.js';

describe('IntervalLatency', () => {
  it('reports an empty window as zero samples with no percentiles', () => {
    expect(new IntervalLatency().take()).toEqual({ n: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null });
  });

  it('reports the percentiles and the maximum of the samples in milliseconds', () => {
    const latency = new IntervalLatency();
    for (let ms = 1; ms <= 100; ms += 1) latency.record(ms);
    const summary = latency.take();
    expect(summary.n).toBe(100);
    expect(summary.p50Ms).toBeCloseTo(50, 0);
    expect(summary.p95Ms).toBeCloseTo(95, 0);
    expect(summary.p99Ms).toBeCloseTo(99, 0);
    expect(summary.maxMs).toBe(100);
  });

  it('counts a zero-length sample as the smallest one and ignores negative and non-finite input', () => {
    const latency = new IntervalLatency();
    latency.record(0);
    latency.record(-1);
    latency.record(Number.NaN);
    latency.record(Number.POSITIVE_INFINITY);
    latency.record(Number.NEGATIVE_INFINITY);
    const summary = latency.take();
    expect(summary.n).toBe(1);
    expect(summary.maxMs).toBe(0);
  });

  it('clamps an absurdly long sample instead of rejecting it', () => {
    const latency = new IntervalLatency();
    latency.record(Number.MAX_SAFE_INTEGER);
    const summary = latency.take();
    expect(summary.n).toBe(1);
    expect(summary.maxMs).toBeGreaterThan(9e8);
  });

  it('empties the window when it is taken', () => {
    const latency = new IntervalLatency();
    latency.record(10);
    expect(latency.take().n).toBe(1);
    expect(latency.take()).toEqual({ n: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null });
    latency.record(20);
    expect(latency.take().maxMs).toBeCloseTo(20, 0);
  });
});
