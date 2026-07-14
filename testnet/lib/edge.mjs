// OT-RFC-61 §3.2 — local edge daemon client + CLI runner (driver edge D; Phase 1 adds O/N).
//
// Every route below was verified against the monorepo at this worktree (origin/main):
//   POST /api/knowledge-assets                       packages/cli/src/daemon/routes/knowledge-assets.ts:715
//     (quads = array of {subject,predicate,object,graph?} — string quads rejected,
//      daemon/http-utils.ts:163 isWritableQuad; object term = quoted literal or bare
//      absolute IRI, http-utils.ts:199; finalize strict boolean, knowledge-assets.ts:771;
//      201 on success / 207 when an opt-in tail failed, knowledge-assets.ts:945-946)
//   POST /api/knowledge-assets/:name/swm/share-async knowledge-assets.ts:1301 → 200 {jobId, state:"queued"} (:1325)
//   GET  /api/knowledge-assets/swm/share-jobs/:jobId knowledge-assets.ts:617-625 →
//     routes/knowledge-assets-async-share.ts:187-195 → PromoteJob; state enum
//     packages/publisher/src/async-promote-queue-types.ts:17-24
//     ('queued'|'running'|'failed_retrying'|'succeeded'|'failed'; terminal: succeeded|failed)
//   POST /api/knowledge-assets/:name/vm/publish-async knowledge-assets.ts:1348 →
//     202 {jobId, status:"accepted", ...} (:1376-1386)
//   GET  /api/publisher/job?id=<jobId>               routes/publisher.ts:370-379 → 200 {job};
//     job.status enum packages/publisher/src/lift-job-states.ts:1-11
//     ('accepted'|'claimed'|'validated'|'broadcast'|'included'|'finalized'|'failed';
//      terminal per TERMINAL_LIFT_JOB_STATES lift-job-states.ts:21: finalized|failed)
//   GET  /api/knowledge-assets/:identifier?contextGraphId=… knowledge-assets.ts:1009-1015
//     (lifecycle descriptor: memoryLayer, publishedUal, reservedUal, events, status —
//      the §6 recovery authority; rfc59 harness pollFinalized consumed exactly this)
//   POST /api/query {sparql, view, contextGraphId}   routes/query.ts:395-610 →
//     200 {result: {bindings}, phases}; view names packages/core/src/memory-model.ts:202-204
//     ('working-memory'|'shared-working-memory'|'verifiable-memory')
//   GET  /api/sync/catchup-status?contextGraphId=…|jobId=… routes/query.ts:904-931
//   GET  /api/status (public — no auth; api-client.ts:476 requests it with auth:false)
//   GET  /api/events (SSE)                           daemon/lifecycle.ts:3449-3464
//     (frames `event: <name>\ndata: <json>\n\n` per sseBroadcast lifecycle.ts:2921-2927,
//      `event: connected\ndata: {}` greeting :3457, `: heartbeat` comments :3460;
//      bearer header or ?token= accepted, auth.ts:837-848)
//
// Auth resolution mirrors the CLI (api-client.ts:464-466 + auth.ts:31-33,62-77):
//   opts.token override → DKG_AUTH_TOKEN env → first non-comment line of
//   <dkgHome>/auth.token. No token → requests go out without an Authorization
//   header (the daemon may be running with auth disabled).
//
// S6 hygiene: this module never logs or embeds dkgHome paths, tokens, hosts, or
// wallet addresses in thrown errors — errors carry the edge `label`, route path,
// HTTP status, and a bounded body tail only.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { normTerm as utilNormTerm } from './util.mjs';

const OUTPUT_TAIL_CHARS = 16_000; // rfc59 harness.mjs commandOutput — tail-truncate cap
const OUTPUT_ACCUM_CAP = 4 * 1024 * 1024; // rfc59 maxBuffer parity for spawned CLI output
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** rfc59 commandOutput port: trim + keep only the LAST 16k chars. */
export function tailTruncate(value) {
  const text = String(value ?? '').trim();
  return text.length > OUTPUT_TAIL_CHARS ? text.slice(-OUTPUT_TAIL_CHARS) : text;
}

/**
 * Resolve the bearer token the way the CLI does (api-client.ts:464-466):
 * explicit override → DKG_AUTH_TOKEN env → first non-comment, non-blank line of
 * <dkgHome>/auth.token (auth.ts:31-33,62-77). Returns undefined when nothing
 * resolves (daemon may have auth disabled).
 * @param {string} dkgHome
 * @param {{token?: string, env?: object}} [opts]
 */
export function resolveEdgeToken(dkgHome, opts = {}) {
  if (opts.token) return opts.token;
  const env = opts.env ?? process.env;
  const envToken = typeof env.DKG_AUTH_TOKEN === 'string' ? env.DKG_AUTH_TOKEN.trim() : '';
  if (envToken) return envToken;
  try {
    const raw = readFileSync(join(dkgHome, 'auth.token'), 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t.length > 0 && !t.startsWith('#')) return t;
    }
  } catch {
    /* no token file — fall through */
  }
  return undefined;
}

/**
 * Parse a deterministic N-Quads document (the makePayload / seed-generator
 * shapes: IRI subject, IRI predicate, literal-or-IRI object, optional graph)
 * into the writable-quad objects the create/write routes accept
 * (daemon/http-utils.ts:163 — string-shaped quads are rejected by the route,
 * so the client converts). Blank-node terms are refused: the deterministic
 * generator never emits them and silently guessing would corrupt readback.
 * @param {string} nquads
 * @returns {Array<{subject: string, predicate: string, object: string, graph?: string}>}
 */
export function parseNquads(nquads) {
  const LINE =
    /^\s*<([^>]*)>\s+<([^>]*)>\s+("(?:[^"\\]|\\.)*"(?:\^\^<[^>]*>|@[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)?|<[^>]*>)\s*(?:<([^>]*)>\s*)?\.\s*$/;
  const out = [];
  for (const raw of String(nquads ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) throw new Error(`parseNquads: unparseable N-Quads line: ${tailTruncate(line).slice(0, 200)}`);
    const object = m[3].startsWith('<') ? m[3].slice(1, -1) : m[3];
    const quad = { subject: m[1], predicate: m[2], object };
    if (m[4] !== undefined) quad.graph = m[4];
    out.push(quad);
  }
  if (out.length === 0) throw new Error('parseNquads: no quads in payload');
  return out;
}

/** Strip surrounding <…> from an IRI term string (tolerates bare IRIs). */
function unwrapIri(term) {
  const t = String(term ?? '');
  return t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t;
}

/** Drop a redundant explicit xsd:string suffix so both normTerm dialects compare equal. */
function comparableLiteral(term) {
  const t = String(term ?? '');
  const suffix = `^^<${XSD_STRING}>`;
  return t.endsWith(suffix) ? t.slice(0, -suffix.length) : t;
}

function extractBindings(json, label) {
  const bindings = json?.result?.bindings ?? json?.results?.bindings ?? json?.bindings;
  if (!Array.isArray(bindings)) {
    throw new Error(`unrecognised /api/query response shape (${label}): ${JSON.stringify(json ?? null).slice(0, 300)}`);
  }
  return bindings;
}

/**
 * Thin authenticated client for ONE local edge daemon.
 * Auth: bearer token resolved the way the CLI does (DKG_HOME token files /
 * DKG_AUTH_TOKEN env) — verified against packages/cli/src/auth.ts:31-77 and
 * api-client.ts:464-466.
 *
 * Optional (non-contract) opts: `token` (override), `env` (env source for
 * token resolution — tests), `_fetch` (injectable fetch), `requestTimeoutMs`.
 */
export class EdgeClient {
  /** @param {{dkgHome: string, apiPort: number, label: 'driver'|'observer'|'nonMember'}} opts */
  constructor(opts) {
    if (!opts || typeof opts.dkgHome !== 'string' || !opts.dkgHome) {
      throw new Error('EdgeClient: "dkgHome" is required');
    }
    if (!Number.isInteger(opts.apiPort) || opts.apiPort <= 0) {
      throw new Error('EdgeClient: "apiPort" must be a positive integer');
    }
    if (!['driver', 'observer', 'nonMember'].includes(opts.label)) {
      throw new Error('EdgeClient: "label" must be driver|observer|nonMember');
    }
    this.dkgHome = opts.dkgHome;
    this.apiPort = opts.apiPort;
    this.label = opts.label;
    this.baseUrl = `http://127.0.0.1:${opts.apiPort}`;
    this._tokenOverride = opts.token;
    this._env = opts.env;
    this._fetch = opts._fetch ?? globalThis.fetch;
    this._requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this._cachedToken = undefined;
  }

  /** Lazily resolved + cached bearer token (re-probed while absent so a daemon
   *  that mints auth.token after construction is still picked up). */
  token() {
    if (this._tokenOverride) return this._tokenOverride;
    if (this._cachedToken === undefined) {
      this._cachedToken = resolveEdgeToken(this.dkgHome, { env: this._env }) ?? undefined;
      if (this._cachedToken === undefined) return undefined;
    }
    return this._cachedToken;
  }

  async #request(method, path, { body, auth = true, timeoutMs } = {}) {
    const headers = {};
    if (auth) {
      const token = this.token();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const init = { method, headers, signal: AbortSignal.timeout(timeoutMs ?? this._requestTimeoutMs) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await this._fetch(`${this.baseUrl}${path}`, init);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body — kept as text tail in the error below */
    }
    if (!res.ok) {
      const err = new Error(
        `${this.label} edge ${method} ${path.split('?')[0]} → HTTP ${res.status}: ${tailTruncate(text).slice(0, 500)}`,
      );
      err.status = res.status;
      err.body = json ?? tailTruncate(text);
      throw err;
    }
    return json;
  }

  /** GET /api/status (public). @returns {Promise<object>} */
  async status() {
    return this.#request('GET', '/api/status', { auth: false, timeoutMs: 10_000 });
  }

  /** Create KA (WM) + optional share/finalize flags — POST /api/knowledge-assets.
   * `quads` may be an N-Quads string (converted via parseNquads — the route
   * rejects string-shaped quads, http-utils.ts:163) or a pre-built writable-quad
   * array. Route default seals the draft (finalize !== false).
   * @param {{name: string, cg: string, quads: string, finalize?: boolean}} p */
  async createKnowledgeAsset(p) {
    const quads = typeof p.quads === 'string' ? parseNquads(p.quads) : p.quads;
    const body = {
      name: p.name,
      contextGraphId: p.cg,
      quads,
      ...(p.finalize !== undefined ? { finalize: p.finalize } : {}),
      ...(p.subGraphName !== undefined ? { subGraphName: p.subGraphName } : {}),
      ...(p.alsoShareSwm !== undefined ? { alsoShareSwm: p.alsoShareSwm } : {}),
    };
    return this.#request('POST', '/api/knowledge-assets', { body });
  }

  /** SHARE WM->SWM async — POST /api/knowledge-assets/:name/swm/share-async → {jobId}.
   * @param {{name: string, cg: string}} p */
  async shareAsync(p) {
    return this.#request('POST', `/api/knowledge-assets/${encodeURIComponent(p.name)}/swm/share-async`, {
      body: { contextGraphId: p.cg, ...(p.subGraphName !== undefined ? { subGraphName: p.subGraphName } : {}) },
    });
  }

  /** Poll a share job to terminal state (async-promote-queue-types.ts:17-24 —
   * terminal = succeeded | failed; failed_retrying is NOT terminal).
   * Returns {job, pollIntervalMs} (§4.3: polled anchors carry their interval).
   * @param {{jobId: string, timeoutMs: number, intervalMs?: number}} p */
  async waitShareJob(p) {
    return this.#waitJob({
      ...p,
      what: 'share job',
      fetchJob: () => this.#request('GET', `/api/knowledge-assets/swm/share-jobs/${encodeURIComponent(p.jobId)}`),
      stateOf: (job) => job?.state,
      terminal: ['succeeded', 'failed'],
      defaultIntervalMs: 500,
    });
  }

  /** PUBLISH SWM->VM async — POST /api/knowledge-assets/:name/vm/publish-async → {jobId}.
   * @param {{name: string, cg: string}} p */
  async publishAsync(p) {
    return this.#request('POST', `/api/knowledge-assets/${encodeURIComponent(p.name)}/vm/publish-async`, {
      body: { contextGraphId: p.cg, ...(p.subGraphName !== undefined ? { subGraphName: p.subGraphName } : {}) },
    });
  }

  /** Poll a publisher (lift) job to terminal state (lift-job-states.ts:21 —
   * terminal = finalized | failed; a finalized job carries ual + txHash).
   * Returns {job, pollIntervalMs}.
   * @param {{jobId: string, timeoutMs: number, intervalMs?: number}} p */
  async waitPublishJob(p) {
    return this.#waitJob({
      ...p,
      what: 'publish job',
      fetchJob: async () => {
        const wrapped = await this.#request('GET', `/api/publisher/job?id=${encodeURIComponent(p.jobId)}`);
        // publisher.ts:370-379 wraps as {job}; the legacy /jobs/:id route is bare.
        return wrapped?.job ?? wrapped;
      },
      stateOf: (job) => job?.status ?? job?.state,
      terminal: ['finalized', 'failed'],
      defaultIntervalMs: 1000,
    });
  }

  async #waitJob({ jobId, timeoutMs, intervalMs, what, fetchJob, stateOf, terminal, defaultIntervalMs }) {
    if (!jobId) throw new Error(`${what} poll requires a jobId`);
    const pollIntervalMs = intervalMs ?? defaultIntervalMs;
    const deadline = Date.now() + timeoutMs;
    let lastError;
    let lastJob;
    for (;;) {
      try {
        const job = await fetchJob();
        lastJob = job;
        if (terminal.includes(stateOf(job))) return { job, pollIntervalMs };
      } catch (err) {
        // Transient poll errors never fail the op before the authoritative
        // deadline (§6 — success is decided by daemon state, not client blips).
        lastError = err;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollIntervalMs, remaining));
    }
    const err = new Error(
      `${this.label} edge ${what} ${jobId} did not reach ${terminal.join('|')} within ${timeoutMs}ms` +
        `${lastJob ? ` (last state: ${stateOf(lastJob)})` : ''}${lastError ? ` (last poll error: ${lastError.message})` : ''}`,
    );
    err.timedOut = true;
    err.lastJob = lastJob;
    err.pollIntervalMs = pollIntervalMs;
    throw err;
  }

  /** Authoritative KA state — GET /api/knowledge-assets/:name?contextGraphId=…
   * (knowledge-assets.ts:1009-1015 — lifecycle descriptor with memoryLayer,
   * publishedUal, reservedUal, events). Used for §6 recovery re-scoring
   * (client timeout ≠ failure) and memoryLayer=VM polling.
   * @param {{name: string, cg: string}} p */
  async knowledgeAssetState(p) {
    const qs = new URLSearchParams({ contextGraphId: p.cg });
    if (p.subGraphName !== undefined) qs.set('subGraphName', p.subGraphName);
    return this.#request('GET', `/api/knowledge-assets/${encodeURIComponent(p.name)}?${qs}`);
  }

  /** Local SPARQL — POST /api/query {sparql, view, contextGraphId}. view:
   * 'working-memory'|'shared-working-memory'|'verifiable-memory'
   * (core/src/memory-model.ts:202-204). Returns the daemon body verbatim:
   * {result: {bindings: [...]}, phases} (query.ts:607-610).
   * @param {{sparql: string, view: string, cg?: string}} p @returns SPARQL JSON results */
  async query(p) {
    const body = {
      sparql: p.sparql,
      ...(p.view !== undefined ? { view: p.view } : {}),
      ...(p.cg !== undefined ? { contextGraphId: p.cg } : {}),
    };
    return this.#request('POST', '/api/query', { body });
  }

  /** Sync catch-up status — GET /api/sync/catchup-status?contextGraphId=…
   * (query.ts:904-931; also accepts jobId as an optional extra param).
   * @param {{cg?: string}} p */
  async catchupStatus(p = {}) {
    const qs = new URLSearchParams();
    if (p.cg !== undefined) qs.set('contextGraphId', p.cg);
    if (p.jobId !== undefined) qs.set('jobId', p.jobId);
    return this.#request('GET', `/api/sync/catchup-status?${qs}`);
  }

  /** Subscribe to SSE /api/events (lifecycle.ts:3449-3464). Returns
   * {close(), gaps(): Array<{fromTs,toTs}>} and invokes onEvent(parsed) per
   * event; tracks disconnect gaps (§4.3 SSE reliability — gaps are recorded,
   * reconnect is automatic). onEvent receives {event, data, ts}; heartbeat
   * comment lines (`: heartbeat`) are ignored. The returned promise resolves
   * once the first connection is established (rejects after connectTimeoutMs,
   * default 15s). A still-open disconnection is reported as {fromTs, toTs: null}.
   * Optional extras: p.retryMs (reconnect delay, default 1000),
   * p.connectTimeoutMs.
   * @param {{onEvent: (e: object) => void}} p */
  async events(p) {
    const onEvent = p?.onEvent ?? (() => {});
    const retryMs = p?.retryMs ?? 1000;
    const connectTimeoutMs = p?.connectTimeoutMs ?? 15_000;
    const token = this.token();
    const state = {
      closed: false,
      gaps: [],
      gapOpenTs: null,
      req: null,
      res: null,
      timer: null,
      reconnectScheduled: false,
      everConnected: false,
    };

    const handle = {
      close: () => {
        state.closed = true;
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        try { state.res?.destroy(); } catch { /* already gone */ }
        try { state.req?.destroy(); } catch { /* already gone */ }
      },
      gaps: () =>
        state.gapOpenTs === null
          ? state.gaps.map((g) => ({ ...g }))
          : [...state.gaps.map((g) => ({ ...g })), { fromTs: state.gapOpenTs, toTs: null }],
    };

    let resolveFirst;
    let rejectFirst;
    const first = new Promise((resolve, reject) => {
      resolveFirst = resolve;
      rejectFirst = reject;
    });
    const firstTimer = setTimeout(() => {
      handle.close();
      rejectFirst(new Error(`${this.label} edge /api/events: no SSE connection within ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);

    const dispatchFrame = (frame) => {
      let eventName = 'message';
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) continue; // comment / heartbeat
        if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
      }
      if (dataLines.length === 0 && eventName === 'message') return; // pure comment frame
      const raw = dataLines.join('\n');
      let data = raw;
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        /* non-JSON payload — deliver raw string */
      }
      try {
        onEvent({ event: eventName, data, ts: Date.now() });
      } catch {
        /* listener errors must never kill the stream */
      }
    };

    const scheduleReconnect = () => {
      if (state.closed || state.reconnectScheduled) return;
      state.reconnectScheduled = true;
      if (state.gapOpenTs === null) state.gapOpenTs = Date.now();
      state.timer = setTimeout(() => {
        state.reconnectScheduled = false;
        connect();
      }, retryMs);
    };

    const connect = () => {
      if (state.closed) return;
      const req = httpRequest({
        host: '127.0.0.1',
        port: this.apiPort,
        path: '/api/events',
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      state.req = req;
      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          scheduleReconnect();
          return;
        }
        state.res = res;
        if (state.gapOpenTs !== null) {
          state.gaps.push({ fromTs: state.gapOpenTs, toTs: Date.now() });
          state.gapOpenTs = null;
        }
        if (!state.everConnected) {
          state.everConnected = true;
          clearTimeout(firstTimer);
          resolveFirst(handle);
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          for (;;) {
            const cut = buf.indexOf('\n\n');
            if (cut < 0) break;
            const frame = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            if (frame.trim()) dispatchFrame(frame);
          }
        });
        res.on('close', scheduleReconnect);
        res.on('error', () => { /* 'close' follows; avoid unhandled 'error' */ });
      });
      req.on('error', scheduleReconnect);
      req.end();
    };

    connect();
    return first;
  }
}

/**
 * Run the dkg CLI as a child process against a DKG_HOME (rfc59 publish path —
 * kept because certify Phase 0 must reproduce the CLI-driven runs byte-for-byte).
 * Port of rfc59 publishOne's child_process mechanics: spawn node <cliPath>,
 * env DKG_HOME, timeout+SIGKILL, capture + tail-truncate 16 KB (commandOutput).
 * Optional extras: p.env (merged over process.env), p.apiPort (→ DKG_API_PORT),
 * p.cwd, p.execPath. Never rejects — spawn errors surface as {ok:false, error}.
 * @param {{cliPath: string, dkgHome: string, args: string[], timeoutMs: number}} p
 * @returns {Promise<{ok, code, signal, stdout, stderr, timedOut, durationMs}>}
 */
export async function runCli(p) {
  const { cliPath, dkgHome, args, timeoutMs } = p;
  if (!cliPath || !dkgHome || !Array.isArray(args) || !Number.isFinite(timeoutMs)) {
    throw new Error('runCli requires {cliPath, dkgHome, args[], timeoutMs}');
  }
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(p.execPath ?? process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        ...(p.env ?? {}),
        DKG_HOME: dkgHome,
        ...(p.apiPort !== undefined ? { DKG_API_PORT: String(p.apiPort) } : {}),
      },
      ...(p.cwd ? { cwd: p.cwd } : {}),
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const cap = (s) => (s.length > OUTPUT_ACCUM_CAP ? s.slice(-OUTPUT_ACCUM_CAP) : s);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on('data', (d) => { stdout = cap(stdout + d.toString()); });
    child.stderr?.on('data', (d) => { stderr = cap(stderr + d.toString()); });
    child.on('error', (err) => {
      finish({
        ok: false,
        code: null,
        signal: null,
        stdout: tailTruncate(stdout),
        stderr: tailTruncate(stderr),
        timedOut,
        durationMs: Date.now() - startedAt,
        error: tailTruncate(err?.message ?? String(err)),
      });
    });
    child.on('close', (code, signal) => {
      finish({
        ok: code === 0 && !timedOut,
        code,
        signal,
        stdout: tailTruncate(stdout),
        stderr: tailTruncate(stderr),
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/**
 * Deterministic single-triple N-Quads payload for op `index` of a run
 * (subject urn:rfc61:<lane>:<runId>:<index>, schema.org/name object; every
 * `controlFixtureEvery`-th op uses the Unicode/control-char fixture set —
 * café/Δ/newline/tab/ — port of rfc59 publishOne's fixtures, urn scheme
 * adapted rfc59→rfc61). controlFixtureEvery <= 0 disables control fixtures.
 * expectedObject is the JSON/N-Triples-escaped quoted literal, byte-comparable
 * to the daemon's term-string bindings (the rfc59 readback contract).
 * @param {{runId: string, lane: string, index: number, controlFixtureEvery: number}} p
 * @returns {{quads: string, subject: string, expectedObject: string, controlFixture: boolean}}
 */
export function makePayload(p) {
  const { runId, lane, index, controlFixtureEvery } = p;
  if (typeof runId !== 'string' || !runId) throw new Error('makePayload: "runId" required');
  if (typeof lane !== 'string' || !lane) throw new Error('makePayload: "lane" required');
  if (!Number.isInteger(index) || index < 0) throw new Error('makePayload: "index" must be a non-negative integer');
  const subject = `urn:rfc61:${lane}:${runId}:${index}`;
  const controlFixture =
    Number.isInteger(controlFixtureEvery) && controlFixtureEvery > 0 && index % controlFixtureEvery === 0;
  // rfc59 harness.mjs publishOne literal fixtures, verbatim (certify line kept
  // byte-identical; steady-state line carries the rfc61 tag).
  const literalValue = controlFixture
    ? `certify ${lane} ${runId} #${index} — café Δ line1\nline2\tcontrol:\u0001`
    : `rfc61 ${lane} ${runId} #${index}`;
  const expectedObject = JSON.stringify(literalValue);
  const quads = `<${subject}> <http://schema.org/name> ${expectedObject} .\n`;
  return { quads, subject, expectedObject, controlFixture };
}

/**
 * Byte-exact readback of published fixtures via chunked VALUES queries
 * (chunk 25 subjects — rfc59 verifyReadback port, harness.mjs:947-983).
 * Object terms are normalized through lib/util.mjs normTerm (devnet
 * semantics). Mismatch kinds: 'missing' (subject absent from the
 * view), 'mismatch' (present with a different value), 'query_error' (the
 * chunk's VALUES query failed — counted per rfc59 discipline: a failed
 * readback query is a readback failure, never a silent skip).
 * Optional extras: p._normTerm (injectable normalizer for tests).
 * @param {EdgeClient} edge
 * @param {{items: Array<{subject, expectedObject}>, cg: string, view: string, chunkSize?: number}} p
 * @returns {Promise<{matched: number, mismatches: Array<{subject, kind}>}>}
 */
export async function verifyReadback(edge, p) {
  const items = p.items ?? [];
  const chunkSize = p.chunkSize ?? 25;
  const normalize = p._normTerm ?? utilNormTerm;
  let matched = 0;
  const mismatches = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const sparql =
      `SELECT ?s ?o WHERE { VALUES ?s { ${chunk.map((it) => `<${it.subject}>`).join(' ')} } ` +
      `?s <http://schema.org/name> ?o }`;
    let bindings;
    try {
      const response = await edge.query({ sparql, view: p.view, cg: p.cg });
      bindings = extractBindings(response, `${edge.label} readback`);
    } catch {
      for (const item of chunk) mismatches.push({ subject: item.subject, kind: 'query_error' });
      continue;
    }
    const observed = new Map(); // bare subject IRI -> Set<comparable object term>
    for (const b of bindings) {
      const s = unwrapIri(normalize(b.s));
      if (!observed.has(s)) observed.set(s, new Set());
      observed.get(s).add(comparableLiteral(normalize(b.o)));
    }
    for (const item of chunk) {
      const values = observed.get(item.subject);
      const expected = comparableLiteral(item.expectedObject);
      // Primary path (daemon term-string bindings) is byte-exact. The raw-value
      // form tolerates a structured SPARQL-JSON cell, whose normTerm output
      // carries the UNESCAPED lexical form (devnet normTerm does not re-escape).
      let rawForm = null;
      try {
        rawForm = `"${JSON.parse(item.expectedObject)}"`;
      } catch {
        /* expectedObject not a JSON-quoted literal — exact match only */
      }
      if (!values) {
        mismatches.push({ subject: item.subject, kind: 'missing' });
      } else if (values.has(expected) || (rawForm !== null && values.has(rawForm))) {
        matched++;
      } else {
        mismatches.push({ subject: item.subject, kind: 'mismatch' });
      }
    }
  }
  return { matched, mismatches };
}
