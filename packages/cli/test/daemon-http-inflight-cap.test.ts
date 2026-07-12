import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
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
 * Saturation is created with a real HTTP request whose JSON body is deliberately
 * left unfinished. The test then polls the admission-exempt status route until
 * it observes the occupied slot before sending competing requests. This proves
 * the production wiring without relying on a fast request burst happening to
 * overlap on a particular runner.
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

  async function readAdmission(
    d: LiveDaemon,
  ): Promise<{ inFlight: number; max: number; rejectedTotal: number }> {
    const res = await fetch(`${d.base}/api/status`, { headers: authHeaders(d) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      admission?: { inFlight: number; max: number; rejectedTotal: number };
    };
    expect(body.admission).toBeDefined();
    return body.admission!;
  }

  async function holdQuerySlot(d: LiveDaemon): Promise<{
    release: () => void;
    responseStatus: Promise<number>;
  }> {
    let released = false;
    let req: ReturnType<typeof httpRequest>;
    const responseStatus = new Promise<number>((resolve, reject) => {
      req = httpRequest(
        `${d.base}/api/query`,
        {
          method: 'POST',
          headers: authHeaders(d),
        },
        (res) => {
          res.resume();
          res.once('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.once('error', reject);
      req.write('{"sparql":"SELECT * WHERE { ?s ?p ?o } LIMIT 1","hold":"');
    });
    const release = () => {
      if (released) return;
      released = true;
      req.end('released"}');
    };

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if ((await readAdmission(d)).inFlight === 1) {
        return { release, responseStatus };
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    release();
    throw new Error('Timed out waiting for the held query to occupy the admission slot');
  }

  it('sheds concurrent over-capacity requests with 503 + Retry-After, then recovers', async () => {
    const d = daemon!;
    const held = await holdQuerySlot(d);
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          selectQuery(d)
            .then((r) => ({ status: r.status, retryAfter: r.headers.get('retry-after') }))
            .catch(() => ({ status: 0, retryAfter: null as string | null })),
        ),
      );

      expect(results.every((r) => r.status === 503)).toBe(true);
      expect(results.every((r) => r.retryAfter === '1')).toBe(true);

      held.release();
      expect(await held.responseStatus).toBe(200);
    } finally {
      held.release();
    }

    // Slots are released after each handler completes → a fresh request succeeds.
    const recovered = await selectQuery(d);
    expect(recovered.status).toBe(200);
  }, 60_000);

  it('keeps the exempt liveness path (/api/status) answerable even while saturated', async () => {
    const d = daemon!;
    const held = await holdQuerySlot(d);
    try {
      const [statuses, burstStatuses] = await Promise.all([
        Promise.all(
          Array.from({ length: 12 }, () =>
            fetch(`${d.base}/api/status`, { headers: authHeaders(d) })
              .then((r) => r.status)
              .catch(() => 0),
          ),
        ),
        Promise.all(
          Array.from({ length: 10 }, () =>
            selectQuery(d).then((r) => r.status).catch(() => 0),
          ),
        ),
      ]);

      expect(statuses.every((s) => s === 200)).toBe(true);
      expect(burstStatuses.every((s) => s === 503)).toBe(true);
    } finally {
      held.release();
    }
    expect(await held.responseStatus).toBe(200);
  }, 60_000);

  it('surfaces admission stats on /api/status (effective cap + per-burst shed delta)', async () => {
    const d = daemon!;
    // Snapshot BEFORE this burst — earlier tests in this file already shed, so a
    // bare `rejectedTotal > 0` would pass without proving THIS burst moved the
    // counter (i.e. that the surfaced value still tracks live shedding).
    const before = await readAdmission(d);
    expect(before.max).toBe(1); // the pinned effective cap is surfaced
    expect(typeof before.inFlight).toBe('number');

    const held = await holdQuerySlot(d);
    try {
      const burst = await Promise.all(
        Array.from({ length: 10 }, () => selectQuery(d).then((r) => r.status).catch(() => 0)),
      );
      expect(burst.every((s) => s === 503)).toBe(true);
    } finally {
      held.release();
    }
    expect(await held.responseStatus).toBe(200);

    // /api/status is admission-exempt, so reading it doesn't perturb the counter:
    // `after` MUST exceed `before` by the sheds we just caused.
    const after = await readAdmission(d);
    expect(after.rejectedTotal).toBeGreaterThan(before.rejectedTotal);
  }, 60_000);
});
