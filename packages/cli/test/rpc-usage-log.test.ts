import { describe, it, expect } from 'vitest';
import { formatRpcUsageLines } from '../src/daemon/rpc-usage-log.js';

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
