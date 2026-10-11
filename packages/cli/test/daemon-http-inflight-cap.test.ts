import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
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

  /** What the tests read from one query; `body` is kept so a failure shows the answer. */
  interface QueryAnswer {
    status: number;
    retryAfter: string | null;
    body: string;
  }

  // The admission gate's own answer. The retryable 503s the query route itself
  // can give (store pressure, unavailable read authority, a withheld unscoped
  // result) carry a `code`, so none of them can pass for a shed.
  const SHED_BODY = JSON.stringify({ error: 'Server busy, retry shortly' });

  // Non-exempt endpoint that awaits the store, so concurrent calls overlap and
  // contend for the single in-flight slot.
  //
  // The query is scoped to a system context graph so that an admitted request
  // has one legitimate answer, 200. An UNSCOPED query releases its result only
  // if no store write landed while it ran, and a freshly started daemon is
  // still writing: it publishes its agent profile right after the API starts
  // listening. A burst that met that write got an answer that has nothing to do
  // with admission control. A scoped read has no such check, and the read
  // authority of a system graph is decided locally, without a chain read.
  function selectQuery(d: LiveDaemon): Promise<QueryAnswer> {
    return fetch(`${d.base}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      }),
    })
      .then(async (r) => ({ status: r.status, retryAfter: r.headers.get('retry-after'), body: await r.text() }))
      // A network error is reported as status 0, with its message as the body.
      .catch((err: unknown) => ({ status: 0, retryAfter: null, body: String(err) }));
  }

  function burst(d: LiveDaemon, count: number): Promise<QueryAnswer[]> {
    return Promise.all(Array.from({ length: count }, () => selectQuery(d)));
  }

  // Neither admitted nor shed: a network error (0) or an unexpected 4xx/5xx.
  // Returned as a list, so a failing `toEqual([])` prints the answers.
  function unexpected(answers: QueryAnswer[]): QueryAnswer[] {
    return answers.filter((r) => r.status !== 200 && r.status !== 503);
  }

  it('sheds concurrent over-capacity requests with 503 + Retry-After, then recovers', async () => {
    const d = daemon!;
    const results = await burst(d, 50);
    const shed = results.filter((r) => r.status === 503);
    const ok = results.filter((r) => r.status === 200);

    // Every result must be an EXPECTED status — never a network error (0) or an
    // unexpected 4xx/5xx that would otherwise hide behind the >=1/>=1 counts.
    expect(unexpected(results)).toEqual([]);
    expect(ok.length).toBeGreaterThan(0); // at least one admitted
    expect(shed.length).toBeGreaterThan(0); // cap enforced under concurrent load
    // Every 503 is the admission gate's own: Retry-After: 1 and its body.
    expect(shed.filter((r) => r.retryAfter !== '1' || r.body !== SHED_BODY)).toEqual([]);

    // Slots are released after each handler completes → a fresh request succeeds.
    expect(await selectQuery(d)).toMatchObject({ status: 200 });
  }, 60_000);

  it('keeps the exempt liveness path (/api/status) answerable even while saturated', async () => {
    const d = daemon!;
    // Saturate with non-exempt query work; capture the burst results so we can
    // PROVE the daemon was actually over capacity (>=1 shed) while the status
    // probes ran — otherwise "status stayed 200" would be vacuous.
    const saturating = burst(d, 40);
    // ...while hammering the exempt status endpoint, which must always answer 200.
    const statuses = await Promise.all(
      Array.from({ length: 12 }, () =>
        fetch(`${d.base}/api/status`, { headers: authHeaders(d) })
          .then((r) => r.status)
          .catch(() => 0),
      ),
    );
    const saturated = await saturating;

    expect(statuses.filter((s) => s !== 200)).toEqual([]); // exempt path never shed
    expect(saturated.filter((r) => r.status === 503).length).toBeGreaterThan(0); // saturation really happened
    expect(unexpected(saturated)).toEqual([]); // no unexpected failures
  }, 60_000);

  it('surfaces admission stats on /api/status (effective cap + per-burst shed delta)', async () => {
    const d = daemon!;
    // Read the surfaced admission block off the exempt status endpoint.
    const readAdmission = async (): Promise<{ inFlight: number; max: number; rejectedTotal: number }> => {
      const res = await fetch(`${d.base}/api/status`, { headers: authHeaders(d) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        admission?: { inFlight: number; max: number; rejectedTotal: number };
      };
      expect(body.admission).toBeDefined();
      return body.admission!;
    };

    // Snapshot BEFORE this burst — earlier tests in this file already shed, so a
    // bare `rejectedTotal > 0` would pass without proving THIS burst moved the
    // counter (i.e. that the surfaced value still tracks live shedding).
    const before = await readAdmission();
    expect(before.max).toBe(1); // the pinned effective cap is surfaced
    expect(typeof before.inFlight).toBe('number');

    // Saturate the non-exempt path so this burst provably sheds.
    const saturated = await burst(d, 50);
    expect(saturated.filter((r) => r.status === 503).length).toBeGreaterThan(0); // this burst really shed

    // /api/status is admission-exempt, so reading it doesn't perturb the counter:
    // `after` MUST exceed `before` by the sheds we just caused.
    const after = await readAdmission();
    expect(after.rejectedTotal).toBeGreaterThan(before.rejectedTotal);
  }, 60_000);
});
