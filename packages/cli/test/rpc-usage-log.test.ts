import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatRpcUsageLines, emitRpcUsage, startRpcUsageTelemetry } from '../src/daemon/rpc-usage-log.js';

/**
 * The rpc_usage line format is a CONTRACT with the Grafana dashboards (parsed
 * in LogQL via `| json | line_format "{{.body}}" | logfmt | unwrap count`), so
 * pin it: one logfmt line per method, delta counts, token-safe values.
 */
describe('formatRpcUsageLines — the Grafana-facing rpc_usage contract', () => {
  it('emits one logfmt line per method with count/window/chain', () => {
    const lines = formatRpcUsageLines(
      { byMethod: { eth_call: 42, eth_getLogs: 7 }, total: 49, lifetimeTotal: 49 },
      60,
      'base:8453',
    );
    expect(lines).toHaveLength(2);
    expect(lines).toContain('rpc_usage method=eth_call count=42 window_s=60 chain=base:8453');
    expect(lines).toContain('rpc_usage method=eth_getLogs count=7 window_s=60 chain=base:8453');
    // Every line is logfmt-parseable: key=value tokens, no quotes needed.
    for (const l of lines) expect(l).toMatch(/^rpc_usage( [a-z_]+=[A-Za-z0-9_.:-]+)+$/);
  });

  it('returns [] for an empty window (idle node logs nothing, not zeros)', () => {
    expect(formatRpcUsageLines({ byMethod: {}, total: 0, lifetimeTotal: 123 }, 60, 'base:8453')).toEqual([]);
  });

  it('omits chain when unset and skips zero/negative/NaN counts', () => {
    const lines = formatRpcUsageLines(
      { byMethod: { eth_call: 3, eth_getLogs: 0, eth_gasPrice: NaN as unknown as number }, total: 3, lifetimeTotal: 3 },
      60,
    );
    expect(lines).toEqual(['rpc_usage method=eth_call count=3 window_s=60']);
  });

  it('sanitizes non-token-safe method/chain values (defensive logfmt safety)', () => {
    const lines = formatRpcUsageLines(
      { byMethod: { 'bad method "x"': 5 }, total: 5, lifetimeTotal: 5 },
      60,
      'weird chain id',
    );
    expect(lines).toEqual(['rpc_usage method=other count=5 window_s=60 chain=unknown']);
  });
});

describe('emitRpcUsage — the complete daemon emission step (drain → format → emit)', () => {
  it('drains the agent source and emits one line per method', () => {
    const emitted: string[] = [];
    const agentLike = {
      drainChainRpcUsage: () => ({ byMethod: { eth_call: 12, eth_getLogs: 3 }, total: 15, lifetimeTotal: 15 }),
    };
    const n = emitRpcUsage(agentLike, (l) => emitted.push(l), 60, 'base:8453');
    expect(n).toBe(2);
    expect(emitted).toContain('rpc_usage method=eth_call count=12 window_s=60 chain=base:8453');
    expect(emitted).toContain('rpc_usage method=eth_getLogs count=3 window_s=60 chain=base:8453');
  });

  it('emits nothing for an empty window, a missing capability, or no source', () => {
    const emitted: string[] = [];
    expect(emitRpcUsage({ drainChainRpcUsage: () => ({ byMethod: {}, total: 0, lifetimeTotal: 9 }) }, (l) => emitted.push(l), 60)).toBe(0);
    expect(emitRpcUsage({ drainChainRpcUsage: () => undefined }, (l) => emitted.push(l), 60)).toBe(0);
    expect(emitRpcUsage({}, (l) => emitted.push(l), 60)).toBe(0); // adapter without the capability
    expect(emitRpcUsage(undefined, (l) => emitted.push(l), 60)).toBe(0);
    expect(emitted).toEqual([]);
  });

  it('never throws — a throwing drain or emitter is swallowed (accounting must not break the node)', () => {
    expect(emitRpcUsage({ drainChainRpcUsage: () => { throw new Error('boom'); } }, () => {}, 60)).toBe(0);
    expect(
      emitRpcUsage(
        { drainChainRpcUsage: () => ({ byMethod: { eth_call: 1 }, total: 1, lifetimeTotal: 1 }) },
        () => { throw new Error('sink down'); },
        60,
      ),
    ).toBe(0);
  });
});

describe('startRpcUsageTelemetry — the full scheduling lifecycle (timer + shutdown drain)', () => {
  afterEach(() => vi.useRealTimers());

  it('ticks every window, emits the drained lines, and stop() drains the partial window then halts', () => {
    vi.useFakeTimers();
    const emitted: string[] = [];
    let next = { byMethod: { eth_call: 5 }, total: 5, lifetimeTotal: 5 };
    const handle = startRpcUsageTelemetry({
      source: { drainChainRpcUsage: () => next },
      emit: (l) => emitted.push(l),
      chainId: 'base:8453',
      windowSeconds: 60,
    });

    expect(emitted).toEqual([]); // nothing before the first tick
    vi.advanceTimersByTime(60_000);
    expect(emitted).toEqual(['rpc_usage method=eth_call count=5 window_s=60 chain=base:8453']);

    // Partial window accumulated after the last tick → stop() must drain it.
    next = { byMethod: { eth_getLogs: 2 }, total: 2, lifetimeTotal: 7 };
    handle.stop();
    expect(emitted).toContain('rpc_usage method=eth_getLogs count=2 window_s=60 chain=base:8453');

    // ...and the timer is really gone: no further emissions after stop().
    const after = emitted.length;
    next = { byMethod: { eth_call: 9 }, total: 9, lifetimeTotal: 16 };
    vi.advanceTimersByTime(300_000);
    expect(emitted.length).toBe(after);
  });

  it('idle windows emit nothing on tick or stop', () => {
    vi.useFakeTimers();
    const emitted: string[] = [];
    const handle = startRpcUsageTelemetry({
      source: { drainChainRpcUsage: () => ({ byMethod: {}, total: 0, lifetimeTotal: 3 }) },
      emit: (l) => emitted.push(l),
      windowSeconds: 60,
    });
    vi.advanceTimersByTime(180_000);
    handle.stop();
    expect(emitted).toEqual([]);
  });
});
