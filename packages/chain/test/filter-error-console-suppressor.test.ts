/**
 * BUG-022: ethers v6 swallows `eth_getFilterChanges` "filter not found"
 * errors with `console.log("@TODO", error)` from
 * `subscriber-filterid.js`, bypassing `provider.on('error', ...)` so
 * the per-provider `FilterErrorSilencer` never sees them. The
 * `installFilterNotFoundConsoleSuppressor` patches `console.log` once
 * per process to catch exactly that two-arg shape and dedup-emit a
 * single warning per window.
 *
 * Tests:
 *   1. Filter-not-found `@TODO` calls are suppressed (no log spam).
 *   2. Suppression is dedup'd against the silencer's window.
 *   3. Unrelated `@TODO` calls (e.g. legitimate ethers warnings that
 *      aren't filter errors) propagate untouched.
 *   4. All other `console.log` calls are unaffected.
 *   5. Idempotent — calling install twice returns the same silencer.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  installFilterNotFoundConsoleSuppressor,
  _uninstallFilterNotFoundConsoleSuppressorForTest,
} from '../src/filter-error-silencer.js';

let originalLog: typeof console.log;
let originalWarn: typeof console.warn;

beforeEach(() => {
  originalLog = console.log;
  originalWarn = console.warn;
});

afterEach(() => {
  // Restore unconditionally — install patches console.log; tests must
  // not leak that patch between cases.
  _uninstallFilterNotFoundConsoleSuppressorForTest();
  console.log = originalLog;
  console.warn = originalWarn;
});

function buildEthersFilterError(): Error {
  const err = new Error('could not coalesce error (error={ "code": -32602, "message": "filter not found" }, payload={ "id": 92590, "jsonrpc": "2.0", "method": "eth_getFilterChanges", "params": [ "0xb5fdcb85048ee0132aae792ffcba21a2" ] }, code=UNKNOWN_ERROR, version=6.16.0)');
  (err as unknown as { code: string }).code = 'UNKNOWN_ERROR';
  (err as unknown as { info: unknown }).info = {
    error: { code: -32602, message: 'filter not found' },
    payload: { method: 'eth_getFilterChanges' },
  };
  return err;
}

describe('installFilterNotFoundConsoleSuppressor (BUG-022)', () => {
  it('suppresses `console.log("@TODO", filterError)` so the daemon log stays clean', () => {
    const captured: unknown[][] = [];
    console.log = (...args: unknown[]) => { captured.push(args); };
    const silencer = installFilterNotFoundConsoleSuppressor({ now: () => 0 });
    console.log('@TODO', buildEthersFilterError());
    expect(captured).toHaveLength(0);
    expect(silencer.stats().filterErrorsTotal).toBe(1);
  });

  it('dedupes repeated suppressions inside the configured window', () => {
    const warns: string[] = [];
    console.warn = (msg: string) => { warns.push(msg); };
    const silencer = installFilterNotFoundConsoleSuppressor({
      dedupWindowMs: 60_000,
      now: () => 0,
    });
    for (let i = 0; i < 100; i++) console.log('@TODO', buildEthersFilterError());
    expect(silencer.stats().filterErrorsTotal).toBe(100);
    expect(warns.length).toBeLessThanOrEqual(2);
    expect(warns[0]).toMatch(/filter expired/i);
  });

  it('forwards other console.log calls untouched (non-filter `@TODO` lines remain visible)', () => {
    const captured: unknown[][] = [];
    console.log = (...args: unknown[]) => { captured.push(args); };
    installFilterNotFoundConsoleSuppressor({ now: () => 0 });
    console.log('@TODO', new Error('some other unrelated error'));
    console.log('regular operator log line');
    console.log('@TODO', { code: 'NETWORK_ERROR', message: 'unrelated' });
    expect(captured).toHaveLength(3);
  });

  it('idempotent — re-installing returns the same silencer instance', () => {
    const a = installFilterNotFoundConsoleSuppressor();
    const b = installFilterNotFoundConsoleSuppressor();
    expect(a).toBe(b);
  });

  it('uninstall restores the console.log implementation captured at install time', () => {
    const captured: unknown[][] = [];
    const testLogger = (...args: unknown[]) => { captured.push(args); };
    console.log = testLogger;

    installFilterNotFoundConsoleSuppressor({ now: () => 0 });
    expect(console.log).not.toBe(testLogger);

    _uninstallFilterNotFoundConsoleSuppressorForTest();
    expect(console.log).toBe(testLogger);
    console.log('after uninstall');
    expect(captured).toEqual([['after uninstall']]);
  });

  it('does NOT match when args are not (string, error) — guards against a hostile caller spoofing the shape', () => {
    const captured: unknown[][] = [];
    console.log = (...args: unknown[]) => { captured.push(args); };
    installFilterNotFoundConsoleSuppressor({ now: () => 0 });
    console.log('@TODO');
    console.log('@TODO', buildEthersFilterError(), 'extra-arg');
    expect(captured).toHaveLength(2);
  });
});
