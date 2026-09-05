import { readSoftOpenFileLimit, type DiagnosticReporter } from '../src/fd-limit.js';
// relay-capacity.test.ts
//
// Unit tests for the Core Node relay-server capacity tuning helpers
// landed in `feat/libp2p-relay-capacity-and-ttl` (PR1 of the libp2p
// reachability hardening series). Three surfaces under test:
//
//   1. `deriveRelayCaps(capacity)` — the pure 1:2 ratio derivation
//      that turns the operator-facing `relayServerCapacity` knob into
//      the full set of HOP/STOP stream caps + connectionManager limit.
//      Now also asserts the defensive throw path for direct callers.
//
//   2. `validateRelayServerCapacity(input)` — the input-validation
//      gate that defends against operator config containing 0,
//      negatives, NaN, Infinity, fractional values, non-numbers, etc.
//      Added in response to Codex review on PR #524.
//
//   3. `checkFdLimit(maxConnections, log)` — the startup helper that
//      reads the host's RLIMIT_NOFILE via process.report.userLimits
//      and routes log emissions to the appropriate severity level
//      (info for ok, warn for under-provisioned / unreadable). The
//      level split also came from PR #524 review — emitting the ok
//      line at warn level breaks operator alerting downstream.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RELAY_SERVER_CAPACITY,
  RELAY_CAPACITY_MULTIPLIER,
  RELAY_DEFAULT_DURATION_LIMIT_MS,
  RELAY_RESERVATION_TTL_MS,
  EDGE_NODE_MAX_CONNECTIONS,
  MAX_RELAY_SERVER_CAPACITY,
  deriveRelayCaps,
  validateRelayServerCapacity,
  checkFdLimit,
} from '../src/node.js';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

describe('deriveRelayCaps', () => {
  it('returns the default capacity-derived caps at the documented 1:2 ratio', () => {
    const caps = deriveRelayCaps(DEFAULT_RELAY_SERVER_CAPACITY);
    expect(caps).toEqual({
      maxReservations: 1024,
      maxConnections: 2048,
      maxInboundHopStreams: 2048,
      maxOutboundHopStreams: 2048,
      maxOutboundStopStreams: 2048,
      maxInboundStopStreams: 2048,
    });
  });

  it('scales linearly — capacity=2048 doubles every derived cap', () => {
    const caps = deriveRelayCaps(2048);
    expect(caps.maxReservations).toBe(2048);
    expect(caps.maxConnections).toBe(2048 * RELAY_CAPACITY_MULTIPLIER);
    expect(caps.maxInboundHopStreams).toBe(caps.maxConnections);
    expect(caps.maxOutboundHopStreams).toBe(caps.maxConnections);
    expect(caps.maxOutboundStopStreams).toBe(caps.maxConnections);
    expect(caps.maxInboundStopStreams).toBe(caps.maxConnections);
  });

  it('scales down for resource-constrained operators (Pi-class hosts)', () => {
    const caps = deriveRelayCaps(256);
    expect(caps.maxReservations).toBe(256);
    expect(caps.maxConnections).toBe(512);
  });

  it('the per-circuit duration limit is documented at 30 minutes (bumped from libp2p default 5min)', () => {
    expect(RELAY_DEFAULT_DURATION_LIMIT_MS).toBe(30 * 60 * 1000);
  });

  it('the reservation TTL is set explicitly at 2 hours (matches libp2p default but pinned for visibility)', () => {
    expect(RELAY_RESERVATION_TTL_MS).toBe(2 * 60 * 60 * 1000);
  });

  it('edge-node default maxConnections stays at the legacy 500 (no blast radius for non-relay nodes)', () => {
    // Sanity guard: this PR intentionally only touches Core Node
    // capacity. If a future change starts scaling edge nodes too,
    // this constant should be reconsidered carefully — every edge
    // bump multiplies across the network's broad install base.
    expect(EDGE_NODE_MAX_CONNECTIONS).toBe(500);
  });

  it('throws on invalid input as a defensive backstop for direct callers', () => {
    // start() gates this with validateRelayServerCapacity(); the
    // throw is purely insurance in case some future caller wires
    // around the validator. Hard fail is preferable to silently
    // shipping invalid limits into libp2p.
    expect(() => deriveRelayCaps(0)).toThrow(TypeError);
    expect(() => deriveRelayCaps(-1)).toThrow(TypeError);
    expect(() => deriveRelayCaps(1.5)).toThrow(TypeError);
    expect(() => deriveRelayCaps(NaN)).toThrow(TypeError);
    expect(() => deriveRelayCaps(Infinity)).toThrow(TypeError);
  });
});

describe('validateRelayServerCapacity', () => {
  it('returns null for unset/undefined input (so callers can apply their own default)', () => {
    expect(validateRelayServerCapacity(undefined)).toBeNull();
    expect(validateRelayServerCapacity(null)).toBeNull();
  });

  it('accepts positive integers', () => {
    expect(validateRelayServerCapacity(1)).toEqual({ ok: true, value: 1 });
    expect(validateRelayServerCapacity(256)).toEqual({ ok: true, value: 256 });
    expect(validateRelayServerCapacity(DEFAULT_RELAY_SERVER_CAPACITY)).toEqual({
      ok: true,
      value: DEFAULT_RELAY_SERVER_CAPACITY,
    });
    expect(validateRelayServerCapacity(8192)).toEqual({ ok: true, value: 8192 });
  });

  it('rejects 0 and negatives — would brick the relay or produce garbage limits', () => {
    expect(validateRelayServerCapacity(0)).toEqual({ ok: false, reason: expect.stringContaining('>= 1') });
    expect(validateRelayServerCapacity(-1)).toEqual({ ok: false, reason: expect.stringContaining('>= 1') });
    expect(validateRelayServerCapacity(-1024)).toEqual({ ok: false, reason: expect.stringContaining('>= 1') });
  });

  it('rejects NaN and Infinity — non-finite values would propagate undefined behaviour', () => {
    expect(validateRelayServerCapacity(NaN)).toEqual({ ok: false, reason: expect.stringContaining('finite') });
    expect(validateRelayServerCapacity(Infinity)).toEqual({ ok: false, reason: expect.stringContaining('finite') });
    expect(validateRelayServerCapacity(-Infinity)).toEqual({ ok: false, reason: expect.stringContaining('finite') });
  });

  it('rejects fractional values — libp2p expects integer caps', () => {
    expect(validateRelayServerCapacity(1.5)).toEqual({ ok: false, reason: expect.stringContaining('integer') });
    expect(validateRelayServerCapacity(1024.0001)).toEqual({ ok: false, reason: expect.stringContaining('integer') });
  });

  it('rejects non-number types (strings, booleans, objects)', () => {
    expect(validateRelayServerCapacity('1024' as any)).toEqual({ ok: false, reason: expect.stringContaining('number') });
    expect(validateRelayServerCapacity(true as any)).toEqual({ ok: false, reason: expect.stringContaining('number') });
    expect(validateRelayServerCapacity({} as any)).toEqual({ ok: false, reason: expect.stringContaining('number') });
    expect(validateRelayServerCapacity([] as any)).toEqual({ ok: false, reason: expect.stringContaining('number') });
  });

  it('rejects values above Number.MAX_SAFE_INTEGER — would lose precision when multiplied', () => {
    // Codex review on PR #524 round 4: `Number.isInteger(9007199254740993)`
    // returns true even though that value already collapses into
    // `9007199254740992` (i.e. it fails round-trip equality with itself).
    // `deriveRelayCaps` then multiplies by RELAY_CAPACITY_MULTIPLIER and
    // hands an imprecise cap to libp2p. We now reject anything outside
    // the safe-integer range before it can leak through.
    const beyondSafe = Number.MAX_SAFE_INTEGER + 2; // +2 because +1 collides with MAX_SAFE_INTEGER itself
    expect(validateRelayServerCapacity(beyondSafe))
      .toEqual({ ok: false, reason: expect.stringContaining('safe integer') });
  });

  it('rejects values whose derived cap would overflow safe-integer range', () => {
    // The post-multiply ceiling matters: even if `capacity` is itself
    // safe, `capacity * RELAY_CAPACITY_MULTIPLIER` (the value libp2p
    // actually receives for the stream caps) must also stay safe.
    expect(validateRelayServerCapacity(MAX_RELAY_SERVER_CAPACITY))
      .toEqual({ ok: true, value: MAX_RELAY_SERVER_CAPACITY });
    expect(validateRelayServerCapacity(MAX_RELAY_SERVER_CAPACITY + 1))
      .toEqual({ ok: false, reason: expect.stringContaining(`capacity × ${RELAY_CAPACITY_MULTIPLIER}`) });
  });
});

describe('checkFdLimit', () => {
  let readLimit: () => number | undefined;

  it.each([
    { previous: false, throws: false, expectedLevel: 'info' },
    { previous: false, throws: true, expectedLevel: 'warn' },
    { previous: true, throws: false, expectedLevel: 'info' },
    { previous: true, throws: true, expectedLevel: 'warn' },
  ])('omits DNS diagnostics and restores excludeNetwork=$previous when report throws=$throws', ({ previous, throws, expectedLevel }) => {
    let observedExcludeNetwork;
    const reporter: DiagnosticReporter = {
      excludeNetwork: previous,
      getReport() {
        observedExcludeNetwork = this.excludeNetwork;
        if (throws) throw new Error('report unavailable');
        return { userLimits: { open_files: { soft: 8192 } } };
      },
    };
    readLimit = () => readSoftOpenFileLimit(reporter);
    const log = recorder((_level: string, _msg: string) => undefined);
    checkFdLimit(2048, log, readLimit);
    expect(observedExcludeNetwork).toBe(true);
    expect(reporter.excludeNetwork).toBe(previous);
    expect(log.calls[0][0]).toBe(expectedLevel);
  });

  function stubReport(report: any) {
    const m = recorder(() => report);
    readLimit = () => readSoftOpenFileLimit({ excludeNetwork: false, getReport: m });
    return m;
  }

  it('emits warn level when soft limit is below recommended (= max(4096, maxConnections × 2))', () => {
    stubReport({ userLimits: { open_files: { soft: 1024, hard: 'unlimited' } } });
    const log = recorder((_level: string, _msg: string) => undefined);
    // maxConnections=2048 → recommended = max(4096, 4096) = 4096; soft=1024 is below.
    checkFdLimit(2048, log, readLimit);
    expect(log.calls).toHaveLength(1);
    const [level, msg] = log.calls[0];
    expect(level).toBe('warn');
    expect(msg).toMatch(/^relay server enabled/);
    expect(msg).toContain('soft=1024');
    expect(msg).toContain('recommended 4096');
    // Operator-facing remediation hint must surface all three deployment
    // shapes so people on the wrong one find their fix immediately.
    expect(msg).toMatch(/ulimit -n 4096/);
    expect(msg).toMatch(/LimitNOFILE=4096/);
    expect(msg).toMatch(/--ulimit nofile=4096:4096/);
  });

  it('emits info level (NOT warn) when soft limit meets or exceeds the recommended value', () => {
    // Codex review on PR #524: emitting the ok line at warn level
    // would trip operator-facing alerting downstream on every
    // healthy startup. The level split is the contract being
    // pinned here.
    stubReport({ userLimits: { open_files: { soft: 8192, hard: 'unlimited' } } });
    const log = recorder((_level: string, _msg: string) => undefined);
    checkFdLimit(2048, log, readLimit);
    expect(log.calls).toHaveLength(1);
    const [level, msg] = log.calls[0];
    expect(level).toBe('info');
    expect(msg).toMatch(/soft=8192 >= recommended 4096, ok/);
  });

  it('uses the 4096 floor when 2 × maxConnections would be smaller', () => {
    // For a small Core Node (capacity=256 → maxConnections=512),
    // 2 × maxConnections = 1024. The floor at 4096 ensures we still
    // recommend a sensible minimum — fd usage isn't dominated by
    // libp2p alone on a real host (SQLite, log files, the daemon
    // HTTP server, etc. all chip in).
    stubReport({ userLimits: { open_files: { soft: 1500, hard: 'unlimited' } } });
    const log = recorder((_level: string, _msg: string) => undefined);
    checkFdLimit(512, log, readLimit);
    const [level, msg] = log.calls[0];
    expect(level).toBe('warn');
    expect(msg).toContain('recommended 4096');
    expect(msg).not.toContain('recommended 1024');
  });

  it('logs the can-not-read fallback at warn level when userLimits is missing (e.g. exotic Node build)', () => {
    stubReport({ userLimits: {} });
    const log = recorder((_level: string, _msg: string) => undefined);
    checkFdLimit(2048, log, readLimit);
    expect(log.calls).toHaveLength(1);
    const [level, msg] = log.calls[0];
    expect(level).toBe('warn');
    expect(msg).toMatch(/could not read host ulimit/);
    expect(msg).toContain('>= 4096');
  });

  it('logs the can-not-read fallback when soft is non-numeric (e.g. "unlimited")', () => {
    // POSIX returns either a number or the string "unlimited" for the
    // hard limit; soft is usually numeric but the API contract
    // doesn't strictly require it. Defence in depth.
    stubReport({ userLimits: { open_files: { soft: 'unlimited', hard: 'unlimited' } } });
    const log = recorder((_level: string, _msg: string) => undefined);
    checkFdLimit(2048, log, readLimit);
    expect(log.calls).toHaveLength(1);
    const [level, msg] = log.calls[0];
    expect(level).toBe('warn');
    expect(msg).toMatch(/could not read host ulimit/);
  });

  it('logs the error fallback at warn level when process.report.getReport() throws', () => {
    const throwingGetReport = recorder(() => {
      throw new Error('exotic test environment');
    });
    readLimit = throwingGetReport;
    const log = recorder((_level: string, _msg: string) => undefined);
    checkFdLimit(2048, log, readLimit);
    expect(log.calls).toHaveLength(1);
    const [level, msg] = log.calls[0];
    expect(level).toBe('warn');
    expect(msg).toMatch(/error reading ulimit/);
    expect(msg).toContain('exotic test environment');
    expect(msg).toContain('>= 4096');
  });
});
