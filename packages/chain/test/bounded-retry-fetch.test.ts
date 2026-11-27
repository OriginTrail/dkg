// SPDX-License-Identifier: Apache-2.0
/**
 * T2 (immediate-RPC-failover): the per-endpoint retry budget contract.
 *
 * `boundedRetryFetchRequest` installs the `FetchRequest.retryFunc` that decides
 * whether ethers retries a 429/5xx on the SAME endpoint. The whole
 * immediate-failover change hinges on making that count configurable:
 *   - multi-RPC  => maxRetries = 0  => give up on the first failure so the
 *     adapter's own failover advances to the next endpoint AT ONCE;
 *   - single-RPC => maxRetries = RPC_REQUEST_MAX_RETRIES (5) => bounded retry
 *     preserved (there is nowhere to fail over to — the #894 resilience).
 *
 * The existing ~170 adapter tests inject bare provider mocks and never touch
 * this retryFunc at all, so the retry-COUNT contract is otherwise unproven.
 * This drives the real `FetchRequest.retryFunc` directly — no network, no
 * native deps — with fake timers so the backoff `sleep` is instant.
 *
 * The first block locks the CURRENT (single-arg) behaviour and is GREEN today.
 * The `describe.skip` block specifies the parametrised `(url, maxRetries)` API
 * ChainEngineer is adding — UN-SKIP it the moment that signature lands. Until
 * then it is staged (not red) so the shared chain suite stays green during S1.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FetchResponse } from 'ethers';
import { boundedRetryFetchRequest } from '../src/evm-adapter-rpc.js';

const URL = 'https://rpc.example/key';
// retryFunc ignores req/response; a bare stub satisfies the signature.
const RESP = undefined as unknown as FetchResponse;

async function decideWithFakeTimers(
  fn: NonNullable<ReturnType<typeof boundedRetryFetchRequest>['retryFunc']>,
  req: ReturnType<typeof boundedRetryFetchRequest>,
  attempt: number,
): Promise<boolean> {
  // The retry DECISION resolves only after the internal backoff sleep; drive
  // fake timers so a "retry=true" verdict returns without real wall time.
  const pending = fn(req, RESP, attempt);
  await vi.advanceTimersByTimeAsync(2_000);
  return pending;
}

describe('boundedRetryFetchRequest — current single-arg retry budget (#894)', () => {
  afterEach(() => vi.useRealTimers());

  it('retries through attempt 4 and gives up at attempt 5 (RPC_REQUEST_MAX_RETRIES)', async () => {
    vi.useFakeTimers();
    const req = boundedRetryFetchRequest(URL);
    const retryFunc = req.retryFunc!;
    expect(typeof retryFunc).toBe('function');

    // attempts 0..4 → retry (true), after a bounded backoff sleep.
    expect(await decideWithFakeTimers(retryFunc, req, 0)).toBe(true);
    expect(await decideWithFakeTimers(retryFunc, req, 4)).toBe(true);

    // attempt 5 → give up (false), and WITHOUT sleeping (no timer advance).
    expect(await retryFunc(req, RESP, 5)).toBe(false);
    // ...still false past the cap.
    expect(await retryFunc(req, RESP, 9)).toBe(false);
  });

  it('the give-up verdict at the cap is synchronous (no backoff sleep before failing over)', async () => {
    // A single-RPC node must not add a stray sleep to its terminal give-up;
    // the false at the cap resolves with no pending timer.
    vi.useFakeTimers();
    const req = boundedRetryFetchRequest(URL);
    const verdict = req.retryFunc!(req, RESP, 5);
    // No timer advance — if the impl slept here this would still be pending.
    await expect(verdict).resolves.toBe(false);
  });

  it('starts a fresh retry budget after the request object has aged past the old wall-clock deadline', async () => {
    // Regression guard: the budget was once a Date.now() deadline captured at
    // FetchRequest construction. Once that deadline elapsed, every later
    // top-level request stopped retrying. Drive the retry function directly so
    // this contract is deterministic and independent of real HTTP backoff.
    vi.useFakeTimers({ now: 0 });
    const req = boundedRetryFetchRequest(URL);
    const retry = req.retryFunc!;

    expect(await decideWithFakeTimers(retry, req, 0)).toBe(true);

    // A new top-level request begins again at attempt 0, even long after the
    // old construction-time budget would have expired.
    vi.setSystemTime(60_000);
    expect(await decideWithFakeTimers(retry, req, 0)).toBe(true);
  });
});

// The parametrised `(url, maxRetries)` contract — the core of immediate failover:
// maxRetries=0 fails over on the FIRST failure (multi-RPC), maxRetries=5 keeps
// the #894 budget (single-RPC). ChainEngineer landed the 2-arg signature
// (default = RPC_REQUEST_MAX_RETRIES, so single-arg callers are unchanged), so
// this runs live.
describe('boundedRetryFetchRequest(url, maxRetries) — parametrised failover budget', () => {
  afterEach(() => vi.useRealTimers());

  it('maxRetries=0 → gives up immediately at attempt 0 (multi-RPC: fail over at once, no backoff)', async () => {
    vi.useFakeTimers();
    const req = boundedRetryFetchRequest(URL, 0);
    // attempt 0 must be false AND synchronous — no per-endpoint backoff sleep.
    // (If the impl slept here, this would stay pending with no timer advanced.)
    await expect(req.retryFunc!(req, RESP, 0)).resolves.toBe(false);
  });

  it('maxRetries=5 → preserves the #894 budget (true through 4, false at 5)', async () => {
    vi.useFakeTimers();
    const req = boundedRetryFetchRequest(URL, 5);
    expect(await decideWithFakeTimers(req.retryFunc!, req, 0)).toBe(true);
    expect(await decideWithFakeTimers(req.retryFunc!, req, 4)).toBe(true);
    expect(await req.retryFunc!(req, RESP, 5)).toBe(false);
  });

  it('default maxRetries (no 2nd arg) equals the single-RPC #894 budget of 5', async () => {
    vi.useFakeTimers();
    const req = boundedRetryFetchRequest(URL); // default = RPC_REQUEST_MAX_RETRIES
    expect(await decideWithFakeTimers(req.retryFunc!, req, 4)).toBe(true);
    expect(await req.retryFunc!(req, RESP, 5)).toBe(false);
  });
});
