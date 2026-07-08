import { describe, it, expect } from 'vitest';
import {
  createMetricsPresence,
  DEFAULT_METRICS_PRESENCE_WINDOW_MS,
} from '../src/daemon/metrics-presence.js';

describe('createMetricsPresence (#1066 Item 1)', () => {
  it('reports no consumer before any signal', () => {
    const p = createMetricsPresence({ sseClientCount: () => 0, now: () => 1000 });
    expect(p.hasRecentConsumer()).toBe(false);
  });

  it('reports a consumer while an SSE dashboard client is connected', () => {
    let clients = 0;
    const p = createMetricsPresence({ sseClientCount: () => clients, now: () => 1000 });
    expect(p.hasRecentConsumer()).toBe(false);
    clients = 1;
    expect(p.hasRecentConsumer()).toBe(true);
  });

  it('reports a consumer for windowMs after a mark(), then expires', () => {
    let t = 10_000;
    const p = createMetricsPresence({ sseClientCount: () => 0, windowMs: 90_000, now: () => t });
    p.mark(); // marked at t=10_000
    expect(p.hasRecentConsumer()).toBe(true);
    t = 10_000 + 89_999; // just inside the window
    expect(p.hasRecentConsumer()).toBe(true);
    t = 10_000 + 90_000; // window edge → expired
    expect(p.hasRecentConsumer()).toBe(false);
    t = 10_000 + 200_000; // well past
    expect(p.hasRecentConsumer()).toBe(false);
  });

  it('a fresh mark() re-opens the window', () => {
    let t = 0;
    const p = createMetricsPresence({ sseClientCount: () => 0, windowMs: 1000, now: () => t });
    p.mark();
    t = 2000;
    expect(p.hasRecentConsumer()).toBe(false);
    p.mark(); // re-mark at t=2000
    t = 2500;
    expect(p.hasRecentConsumer()).toBe(true);
  });

  it('alwaysCollect overrides everything (kill-switch)', () => {
    const p = createMetricsPresence({
      sseClientCount: () => 0,
      alwaysCollect: true,
      now: () => 1_000_000,
    });
    // no SSE client, never marked — still present.
    expect(p.hasRecentConsumer()).toBe(true);
  });

  it('defaults the window to 90s (3× the 30s tick)', () => {
    expect(DEFAULT_METRICS_PRESENCE_WINDOW_MS).toBe(90_000);
    let t = 0;
    const p = createMetricsPresence({ sseClientCount: () => 0, now: () => t });
    p.mark();
    t = 89_999;
    expect(p.hasRecentConsumer()).toBe(true);
    t = 90_000;
    expect(p.hasRecentConsumer()).toBe(false);
  });
});
