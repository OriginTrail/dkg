/**
 * mcp-server / auth-probe
 * ------------------------------------------------------------------
 * Helpers used by the `mcp_auth` tool (see `src/index.ts`) to report
 * both daemon liveness and whether the configured bearer credential
 * is actually accepted by the daemon.
 *
 * These live in a dedicated module for two reasons:
 *   1. `src/index.ts` starts the stdio transport at import time
 *      (via `main()`), which would block any test that imports the
 *      probes directly from there. Extracting them keeps the probes
 *      unit-testable against a real http.Server.
 *   2. Liveness vs auth must be reported as distinct signals: the
 *      original `probeStatus` only hit `/api/status` (on the
 *      daemon's public allow-list), so `mcp_auth status` could
 *      report OK for an invalid credential. Splitting liveness
 *      (`probeStatus`) from authenticated reachability
 *      (`probeAuth`) lets us expose both signals in the tool
 *      output *and* pin them individually in tests.
 */

export interface ProbeResult {
  ok: boolean;
  code?: number;
  body?: string;
  /**
   * `authDisabled` is set when the probe reached an auth-gated endpoint
   * without supplying any credential and the daemon accepted the
   * request anyway — the only way that can happen in practice is if
   * the daemon is running with `auth.enabled=false` (CLI-8). Callers
   * render this as a distinct `auth disabled` status instead of
   * lumping it in with `ok` or `FAILED`.
   */
  authDisabled?: boolean;
}

/**
 * Probe `/api/status` (public / liveness only). Anything 2xx counts as
 * reachable. Note: reachability says NOTHING about whether the bearer
 * credential is accepted — see `probeAuth` for that.
 */
export async function probeStatus(
  url: string,
  token: string,
): Promise<ProbeResult> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${url.replace(/\/$/, '')}/api/status`, {
      headers,
    });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, code: res.status, body: text.slice(0, 240) };
  } catch (e) {
    return { ok: false, body: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Probe an authenticated endpoint so the host can verify the bearer
 * credential is actually accepted by the daemon (separately from
 * whether the daemon is reachable at all).
 *
 * `/api/agents` is a cheap GET on the daemon's auth-gated surface that
 * every DKG node exposes (see `packages/cli/src/daemon.ts`). Anything
 * other than 2xx — including 401 "missing auth token" — surfaces as
 * `FAILED`, so `mcp_auth status` can never again report OK for an
 * invalid or missing credential.
 *
 * When no credential is configured we still probe `/api/agents` —
 * without an Authorization header. A 2xx response then means the
 * daemon has auth disabled (`auth.enabled=false`) and every MCP
 * request would succeed; we surface that as `{ok: true, authDisabled:
 * true}` so the caller can render a distinct "auth disabled" state
 * instead of the hard `FAILED` the previous short-circuit produced
 * . A 4xx response on
 * the unauthenticated probe means auth IS enabled and no credential
 * is configured — still a failure, but one the caller can distinguish
 * from a rejected-credential failure.
 */
export async function probeAuth(
  url: string,
  token: string,
): Promise<ProbeResult> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${url.replace(/\/$/, '')}/api/agents`, {
      headers,
    });
    const text = await res.text().catch(() => '');
    const out: ProbeResult = {
      ok: res.ok,
      code: res.status,
      body: text.slice(0, 240),
    };
    if (!token && res.ok) {
      out.authDisabled = true;
    }
    return out;
  } catch (e) {
    return { ok: false, body: e instanceof Error ? e.message : String(e) };
  }
}
