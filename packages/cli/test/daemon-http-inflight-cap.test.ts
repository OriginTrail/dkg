import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, authHeaders, type LiveDaemon } from './helpers/live-daemon.js';

/**
 * Real-node admission-control test. Boots an actual daemon with the in-flight
 * cap pinned to 1 (via config) and verifies, against the LIVE HTTP request
 * path, that it sheds concurrent over-capacity load with 503 + Retry-After,
 * keeps the exempt liveness path answerable, and recovers once slots free.
 *
 * This is the end-to-end counterpart to the unit tests in
 * http-admission-control.test.ts: it would fail if the limiter were never wired
 * into createServer, wired after an early return, or never released.
 *
 * Saturation is created with a 50-request burst against cap=1 rather than a
 * single held-open request. That is statistically deterministic — 50 concurrent
 * requests cannot all serialize through one slot without overlap — and avoids a
 * brittle blocking fixture (the daemon admits before the route reads the body,
 * so an unfinished-body "hold" does not reliably pin the slot). The precise
 * one-in/one-shed/release semantics are covered deterministically by the unit
 * tests; here we prove the wiring end-to-end.
 */
describe('daemon admission control (real node, maxInFlightRequests=1)', () => {
  let daemon: LiveDaemon | undefined;

  beforeAll(async () => {
    // Pin the cap via ENV (which takes precedence over config) so the test is
    // hermetic — an ambient DKG_MAX_INFLIGHT in CI/dev can't override it.
    daemon = await startLiveDaemon({
      authEnabled: true,
      extraConfig: { maxInFlightRequests: 1 },
      env: { DKG_MAX_INFLIGHT: '1' },
    });
  }, 90_000);

  afterAll(async () => {
    await stopLiveDaemon(daemon);
  }, 30_000);

  // Non-exempt endpoint that awaits the store, so concurrent calls overlap and
  // contend for the single in-flight slot.
  function selectQuery(d: LiveDaemon): Promise<Response> {
    return fetch(`${d.base}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({ sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1' }),
    });
  }

  it('sheds concurrent over-capacity requests with 503 + Retry-After, then recovers', async () => {
    const d = daemon!;
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        selectQuery(d)
          .then((r) => ({ status: r.status, retryAfter: r.headers.get('retry-after') }))
          .catch(() => ({ status: 0, retryAfter: null as string | null })),
      ),
    );
    const shed = results.filter((r) => r.status === 503);
    const ok = results.filter((r) => r.status === 200);

    // Every result must be an EXPECTED status — never a network error (0) or an
    // unexpected 4xx/5xx that would otherwise hide behind the >=1/>=1 counts.
    expect(results.every((r) => r.status === 200 || r.status === 503)).toBe(true);
    expect(ok.length).toBeGreaterThan(0); // at least one admitted
    expect(shed.length).toBeGreaterThan(0); // cap enforced under concurrent load
    expect(shed.every((r) => r.retryAfter === '1')).toBe(true); // Retry-After present on every 503

    // Slots are released after each handler completes → a fresh request succeeds.
    const recovered = await selectQuery(d);
    expect(recovered.status).toBe(200);
  }, 60_000);

  it('keeps the exempt liveness path (/api/status) answerable even while saturated', async () => {
    const d = daemon!;
    // Saturate with non-exempt query work; capture the burst results so we can
    // PROVE the daemon was actually over capacity (>=1 shed) while the status
    // probes ran — otherwise "status stayed 200" would be vacuous.
    const burst = Promise.all(
      Array.from({ length: 40 }, () =>
        selectQuery(d).then((r) => r.status).catch(() => 0),
      ),
    );
    // ...while hammering the exempt status endpoint, which must always answer 200.
    const statuses = await Promise.all(
      Array.from({ length: 12 }, () =>
        fetch(`${d.base}/api/status`, { headers: authHeaders(d) })
          .then((r) => r.status)
          .catch(() => 0),
      ),
    );
    const burstStatuses = await burst;

    expect(statuses.every((s) => s === 200)).toBe(true); // exempt path never shed
    expect(burstStatuses.filter((s) => s === 503).length).toBeGreaterThan(0); // saturation really happened
    expect(burstStatuses.every((s) => s === 200 || s === 503)).toBe(true); // no unexpected failures
  }, 60_000);
});
