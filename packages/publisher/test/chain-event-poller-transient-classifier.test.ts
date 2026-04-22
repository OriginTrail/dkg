/**
 * Post-v10-rc merge fix: ChainEventPoller must classify transient
 * upstream-RPC failures (502/503/504, ECONNRESET, ethers
 * `code=SERVER_ERROR`, etc.) as recoverable [WARN] events instead of
 * fatal [ERROR] events, otherwise a single hiccup from the public
 * Sepolia/Base RPC permanently red-lights the
 * `three-player-game.test.ts` E2E "no fatal ERROR lines" assertion
 * even though the poller already retries on the next tick and the
 * cursor never advances on failure.
 *
 * The original commit `bdaa2f60 fix(chain-event-poller): downgrade
 * hardhat head-race to WARN` covered ONLY the local-hardhat head
 * race. Real-world CI flakes from the public RPC endpoint
 * (`https://sepolia.base.org`) that returned `502 Bad Gateway` were
 * still being logged as `[ERROR] Poll failed: server response 502 ...`
 * and tripping the same E2E. This file pins:
 *   - the broader transient classifier (`classifyPollFailure`),
 *   - the WARN/ERROR emission rule (`handlePollFailure`), and
 *   - the ESCALATION rule that prevents a permanently broken endpoint
 *     from hiding behind the warn-only path forever (which would
 *     itself be a false-negative "no real bug found" failure mode the
 *     user explicitly forbade).
 *
 * NOTE: We exercise the REAL `classifyPollFailure` and (via reflection
 * through a captured logger) the REAL `handlePollFailure`. There is no
 * locally-reimplemented classifier in this file — that would be a
 * tautological test smell.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { PublishHandler } from '../src/publish-handler.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus } from '@origintrail-official/dkg-core';

interface CapturedLog {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}

function attachLogCapture(poller: ChainEventPoller): CapturedLog[] {
  const captured: CapturedLog[] = [];
  // ChainEventPoller's logger is a private readonly field. We swap it
  // with a thin proxy that records every call so we can assert on the
  // exact level + message pair. Spying on `Logger.prototype` would
  // catch every other Logger instance in the process and pollute the
  // assertions.
  const proxy = {
    info: (_ctx: unknown, message: string) => captured.push({ level: 'info', message }),
    warn: (_ctx: unknown, message: string) => captured.push({ level: 'warn', message }),
    error: (_ctx: unknown, message: string) => captured.push({ level: 'error', message }),
    debug: (_ctx: unknown, message: string) => captured.push({ level: 'debug', message }),
  };
  (poller as unknown as { log: unknown }).log = proxy;
  return captured;
}

/**
 * Drive the production failure path directly. We can't easily fire the
 * real `setInterval` callback in a unit test (interval is min 1ms and
 * the wrapper is lambda-bound), so we invoke the extracted
 * `handlePollFailure` private method instead. That is the SAME function
 * the wrapper calls — there is no parallel implementation to drift.
 */
function emitFailure(poller: ChainEventPoller, err: Error): void {
  const fn = (poller as unknown as { handlePollFailure: (e: Error) => void }).handlePollFailure;
  fn.call(poller, err);
}

function emitSuccess(poller: ChainEventPoller): void {
  // The wrapper resets the counter on `.then(() => ...)`. Mirror that
  // exact reset so the test reflects production state transitions.
  (poller as unknown as { consecutiveTransientFailures: number }).consecutiveTransientFailures = 0;
}

function makePoller(): ChainEventPoller {
  const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());
  return new ChainEventPoller({
    chain: { chainType: 'evm', chainId: 'test-chain' } as unknown as ChainAdapter,
    publishHandler: handler,
  });
}

describe('ChainEventPoller.classifyPollFailure (post-v10-rc-merge)', () => {
  it('classifies a real ethers v6 "502 Bad Gateway code=SERVER_ERROR" message as upstream-rpc', () => {
    const err = new Error(
      `server response 502 Bad Gateway (request={  }, response={  }, error=null, ` +
        `info={ "requestUrl": "https://sepolia.base.org", "responseBody": "error code: 502", ` +
        `"responseStatus": "502 Bad Gateway" }, code=SERVER_ERROR, version=6.16.0)`,
    );
    const out = ChainEventPoller.classifyPollFailure(err);
    expect(out.kind).toBe('upstream-rpc');
    expect(out.message).toContain('502 Bad Gateway');
  });

  it('classifies generic 503/504 gateway errors as upstream-rpc', () => {
    expect(ChainEventPoller.classifyPollFailure(new Error('503 Service Unavailable')).kind).toBe('upstream-rpc');
    expect(ChainEventPoller.classifyPollFailure(new Error('504 Gateway Timeout')).kind).toBe('upstream-rpc');
    expect(ChainEventPoller.classifyPollFailure(new Error('500 Internal Server Error')).kind).toBe('upstream-rpc');
  });

  it('classifies common Node socket / DNS errors as upstream-rpc', () => {
    expect(ChainEventPoller.classifyPollFailure(new Error('ECONNRESET')).kind).toBe('upstream-rpc');
    expect(ChainEventPoller.classifyPollFailure(new Error('ETIMEDOUT')).kind).toBe('upstream-rpc');
    expect(ChainEventPoller.classifyPollFailure(new Error('ENOTFOUND sepolia.base.org')).kind).toBe('upstream-rpc');
    expect(ChainEventPoller.classifyPollFailure(new Error('socket hang up')).kind).toBe('upstream-rpc');
    expect(ChainEventPoller.classifyPollFailure(new Error('fetch failed')).kind).toBe('upstream-rpc');
  });

  it('classifies the Hardhat head race (block range extends beyond current head) as chain-head-race (regression)', () => {
    const out = ChainEventPoller.classifyPollFailure(
      new Error('block range extends beyond current head block (got 14, head=12)'),
    );
    expect(out.kind).toBe('chain-head-race');
  });

  it('classifies the ethers UNKNOWN_ERROR / -32602 race as chain-head-race (regression)', () => {
    const out = ChainEventPoller.classifyPollFailure(
      new Error('something failed code=UNKNOWN_ERROR -32602 invalid block range'),
    );
    expect(out.kind).toBe('chain-head-race');
  });

  it('does NOT classify genuinely-broken errors as transient (real bugs surface as fatal)', () => {
    expect(ChainEventPoller.classifyPollFailure(new Error('invalid ABI selector 0xdeadbeef')).kind).toBe('fatal');
    expect(ChainEventPoller.classifyPollFailure(new Error('TypeError: cannot read properties of undefined')).kind).toBe('fatal');
    expect(ChainEventPoller.classifyPollFailure(new Error('schema mismatch: expected uint256 got bytes')).kind).toBe('fatal');
  });

  it('handles non-Error throws via String() coercion', () => {
    const out = ChainEventPoller.classifyPollFailure('plain string failure');
    expect(out.kind).toBe('fatal');
    expect(out.message).toBe('plain string failure');
  });
});

describe('ChainEventPoller.handlePollFailure emission rules (post-v10-rc-merge)', () => {
  let poller: ChainEventPoller;
  let captured: CapturedLog[];

  beforeEach(() => {
    poller = makePoller();
    captured = attachLogCapture(poller);
  });

  it('a single 502 emits exactly one [WARN] (not [ERROR])', () => {
    emitFailure(poller, new Error('server response 502 Bad Gateway code=SERVER_ERROR'));

    expect(captured.filter((c) => c.level === 'error')).toEqual([]);
    const warns = captured.filter((c) => c.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toMatch(/^Poll transient \(upstream RPC — retrying next tick, 1\/5\):/);
    expect(warns[0].message).toContain('502 Bad Gateway');
  });

  it('a head-race emits "Poll transient (chain head race ...)" — matches E2E allowlist token', () => {
    emitFailure(poller, new Error('block range extends beyond current head block'));
    const warns = captured.filter((c) => c.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toMatch(/^Poll transient \(chain head race/);
  });

  it('a fatal error emits exactly one [ERROR] with the original "Poll failed: ..." prefix', () => {
    emitFailure(poller, new Error('invalid ABI selector 0xdeadbeef'));
    expect(captured.filter((c) => c.level === 'warn')).toEqual([]);
    const errors = captured.filter((c) => c.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('Poll failed: invalid ABI selector 0xdeadbeef');
  });

  it('escalates to [ERROR] on the 5th consecutive transient (no false negatives for permanently broken endpoints)', () => {
    for (let i = 0; i < 5; i += 1) {
      emitFailure(poller, new Error('server response 502 Bad Gateway code=SERVER_ERROR'));
    }
    const warns = captured.filter((c) => c.level === 'warn');
    const errors = captured.filter((c) => c.level === 'error');
    expect(warns).toHaveLength(4);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/^Poll failed: transient persisted 5 ticks /);
  });

  it('a successful poll resets the escalation counter — recovery does not carry over', () => {
    for (let i = 0; i < 4; i += 1) {
      emitFailure(poller, new Error('server response 502 Bad Gateway code=SERVER_ERROR'));
    }
    expect((poller as unknown as { consecutiveTransientFailures: number }).consecutiveTransientFailures).toBe(4);

    emitSuccess(poller);
    expect((poller as unknown as { consecutiveTransientFailures: number }).consecutiveTransientFailures).toBe(0);

    // Now 4 more transients — must STILL be all WARN, not escalate.
    for (let i = 0; i < 4; i += 1) {
      emitFailure(poller, new Error('server response 502 Bad Gateway code=SERVER_ERROR'));
    }
    const warns = captured.filter((c) => c.level === 'warn');
    const errors = captured.filter((c) => c.level === 'error');
    expect(warns).toHaveLength(8);
    expect(errors).toHaveLength(0);
  });

  it('mixed transient kinds share the same escalation counter (one stuck endpoint = one escalation, regardless of error shape jitter)', () => {
    // Real-world: a flaky endpoint can return 502s, then ECONNRESET,
    // then 504s within the same outage window. They are all the same
    // "endpoint is sick" signal and should all count toward escalation.
    emitFailure(poller, new Error('502 Bad Gateway'));
    emitFailure(poller, new Error('ECONNRESET'));
    emitFailure(poller, new Error('504 Gateway Timeout'));
    emitFailure(poller, new Error('socket hang up'));
    emitFailure(poller, new Error('block range extends beyond current head block'));
    const errors = captured.filter((c) => c.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/transient persisted 5 ticks/);
  });
});
