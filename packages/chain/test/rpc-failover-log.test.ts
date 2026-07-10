// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  noteRpcFailover,
  noteRpcExhaustion,
  noteRpcServed,
  classifyRpcFailoverError,
  rpcHost,
  getRpcFailoverStats,
  _resetRpcFailoverStatsForTest,
  _setRpcFailoverClockForTest,
} from '../src/rpc-failover-log.js';

describe('rpc-failover-log', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let clock = 0;

  beforeEach(() => {
    _resetRpcFailoverStatsForTest();
    clock = 1_000_000;
    _setRpcFailoverClockForTest(() => clock);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    _resetRpcFailoverStatsForTest();
  });

  describe('classifyRpcFailoverError', () => {
    it('reduces errors to the bounded enum', () => {
      expect(classifyRpcFailoverError({ code: 'RPC_ENDPOINTS_EXHAUSTED' })).toBe('EXHAUSTED');
      expect(classifyRpcFailoverError({ message: 'no runners?!' })).toBe('EXHAUSTED');
      expect(classifyRpcFailoverError({ status: 429 })).toBe('THROTTLE_429');
      expect(classifyRpcFailoverError({ message: 'Too Many Requests' })).toBe('THROTTLE_429');
      expect(classifyRpcFailoverError({ status: 503 })).toBe('SERVER_5XX');
      expect(classifyRpcFailoverError({ code: 'TIMEOUT' })).toBe('TIMEOUT');
      expect(classifyRpcFailoverError({ code: 'ECONNREFUSED' })).toBe('NETWORK');
      expect(classifyRpcFailoverError({ message: 'something nobody classifies' })).toBe('OTHER');
    });

    it('never throws on non-object / undefined inputs (classifies as OTHER)', () => {
      expect(() => classifyRpcFailoverError(undefined)).not.toThrow();
      expect(classifyRpcFailoverError(undefined)).toBe('OTHER');
      expect(classifyRpcFailoverError(null)).toBe('OTHER');
      expect(classifyRpcFailoverError('econnrefused string')).toBe('NETWORK');
      expect(classifyRpcFailoverError(123)).toBe('OTHER');
    });
  });

  describe('rpcHost', () => {
    it('reduces a URL to host-only and never throws on garbage', () => {
      expect(rpcHost('https://base-rpc.publicnode.com/v1/key')).toBe('base-rpc.publicnode.com');
      expect(rpcHost('not a url')).toBe('unparseable-rpc');
    });
  });

  describe('noteRpcFailover: dedup gate + counters', () => {
    it('emits at most one line per host|class per window; counter counts every call', () => {
      const err = { code: 'SERVER_ERROR', status: 503 };
      noteRpcFailover('publish broadcast', 'https://a.example', err, 'https://b.example');
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Second identical failover inside the window is SUPPRESSED (dedup gate).
      noteRpcFailover('publish broadcast', 'https://a.example', err, 'https://b.example');
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // ...but the counter records BOTH (coarse health signal).
      const snap = getRpcFailoverStats();
      expect(snap.failovers).toBe(2);
      expect(snap.byErrorClass.SERVER_5XX).toBe(2);
      expect(snap.byEndpointHost['a.example']).toBe(2);

      // Advancing past the window re-emits, with a suppressed-count rollup.
      clock += 6 * 60_000;
      noteRpcFailover('publish broadcast', 'https://a.example', err, 'https://b.example');
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(String(warnSpy.mock.calls[1][0])).toMatch(/suppressed/);
    });

    it('logs host-only — never a full URL (no key leak)', () => {
      noteRpcFailover('x', 'https://secret.example/abc123key', { status: 500 }, 'https://b.example');
      const line = String(warnSpy.mock.calls[0][0]);
      expect(line).not.toContain('://');
      expect(line).not.toContain('abc123key');
      expect(line).toContain('secret.example');
    });

    it('never throws even if console.warn throws — failover must not abort', () => {
      warnSpy.mockImplementation(() => {
        throw new Error('logger boom');
      });
      expect(() => noteRpcFailover('x', 'https://a.example', { status: 500 })).not.toThrow();
      // The counter still advanced despite the throwing sink.
      expect(getRpcFailoverStats().failovers).toBe(1);
    });
  });

  describe('noteRpcExhaustion', () => {
    it('counts and logs host-only', () => {
      noteRpcExhaustion('publish broadcast', ['https://a.example/k', 'https://b.example']);
      expect(getRpcFailoverStats().exhaustions).toBe(1);
      const line = String(warnSpy.mock.calls[0][0]);
      expect(line).not.toContain('://');
      expect(line).toContain('a.example');
    });
  });

  describe('getRpcFailoverStats', () => {
    it('returns a plain, host-only JSON snapshot', () => {
      noteRpcFailover('x', 'https://a.example', { status: 429 }, 'https://b.example');
      expect(getRpcFailoverStats()).toEqual({
        failovers: 1,
        exhaustions: 0,
        preferredEstablishments: 0,
        byErrorClass: { THROTTLE_429: 1 },
        byEndpointHost: { 'a.example': 1 },
        servedByEndpointHost: {},
      });
    });
  });

  describe('noteRpcServed', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { logSpy = vi.spyOn(console, 'log').mockImplementation(() => {}); });
    afterEach(() => { logSpy.mockRestore(); });

    it('counts every successful call per host, host-only (no key leak)', () => {
      noteRpcServed('read cgKaCount', 'https://a.example/secretkey');
      noteRpcServed('read cgKaCount', 'https://a.example/secretkey');
      const snap = getRpcFailoverStats();
      expect(snap.servedByEndpointHost).toEqual({ 'a.example': 2 });
      // never the full URL / key
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).not.toContain('secretkey');
    });

    it('reads log only on a provider CHANGE, not per call', () => {
      noteRpcServed('read x', 'https://a.example');   // first sighting -> logs
      noteRpcServed('read x', 'https://a.example');   // same host    -> silent
      noteRpcServed('read x', 'https://a.example');   // same host    -> silent
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(String(logSpy.mock.calls[0][0])).toContain('via a.example');
      noteRpcServed('read x', 'https://b.example');   // shift        -> logs
      expect(logSpy).toHaveBeenCalledTimes(2);
      expect(String(logSpy.mock.calls[1][0])).toContain('via b.example (provider shift)');
      // ...but every call was still counted
      expect(getRpcFailoverStats().servedByEndpointHost).toEqual({ 'a.example': 3, 'b.example': 1 });
    });

    it('tx broadcasts (alwaysLog) log every success for per-tx attribution', () => {
      noteRpcServed('V10 publish broadcast', 'https://a.example', true);
      noteRpcServed('V10 publish broadcast', 'https://a.example', true); // same host, still logs
      expect(logSpy).toHaveBeenCalledTimes(2);
      expect(String(logSpy.mock.calls[0][0])).toBe('[chain] RPC served: V10 publish broadcast via a.example');
    });

    it('never throws even if console.log throws — the call path must not abort', () => {
      logSpy.mockImplementation(() => { throw new Error('sink down'); });
      expect(() => noteRpcServed('read x', 'https://a.example', true)).not.toThrow();
      expect(getRpcFailoverStats().servedByEndpointHost['a.example']).toBe(1);
    });
  });
});
