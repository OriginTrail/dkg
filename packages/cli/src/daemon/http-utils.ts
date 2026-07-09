// HTTP request/response utilities extracted from the legacy monolithic
// `daemon.ts`. Body parsing, JSON validators, CORS resolution, the
// loopback rate-limiter, plus small helpers used across route handlers.
// Pure helpers; the rate-limiter class is the only stateful piece and
// is instantiated per-daemon-boot by `runDaemonInner`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PayloadTooLargeError,
  assertQuadLiteralsMutf8Safe,
  isOversizedRdfLiteralError,
  validateContextGraphId,
  validateSubGraphName,
  isSafeIri,
  NO_FUNDED_PUBLISHER_WALLET_CODE,
  messageIndicatesNoFundedPublisherWallet,
  Logger,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import { enrichEvmError, isChainRpcTransportError } from '@origintrail-official/dkg-chain';
import type { DKGAgent, ContextGraphWritePreflightProbe } from '@origintrail-official/dkg-agent';
import type { DkgConfig } from '../config.js';
import { enforceSignedRequestPostBody } from '../auth.js';

import type { CorsAllowlist } from './state.js';

export function isPayloadTooLargeError(err: unknown): err is PayloadTooLargeError {
  if (err instanceof PayloadTooLargeError) return true;
  if (!err || typeof err !== 'object') return false;
  const shaped = err as { name?: unknown; code?: unknown };
  return (
    shaped.name === 'PayloadTooLargeError' ||
    shaped.name === 'SwmGossipPayloadTooLargeError' ||
    shaped.code === 'PAYLOAD_TOO_LARGE' ||
    shaped.code === 'SWM_GOSSIP_PAYLOAD_TOO_LARGE'
  );
}

export function payloadTooLargeResponseBody(err: unknown): Record<string, unknown> {
  const shaped = (err && typeof err === 'object') ? err as Record<string, unknown> : {};
  const message = err instanceof Error ? err.message : String(err ?? 'Payload too large');
  const body: Record<string, unknown> = {
    error: message,
    code: typeof shaped.code === 'string' ? shaped.code : 'PAYLOAD_TOO_LARGE',
  };
  const maxBytes = shaped.maxBytes;
  if (typeof maxBytes === 'number') body.limitBytes = maxBytes;
  const actualBytes = shaped.actualBytes;
  if (typeof actualBytes === 'number') body.actualBytes = actualBytes;
  const hint = shaped.hint;
  if (typeof hint === 'string' && hint.length > 0) body.hint = hint;
  return body;
}

/**
 * True iff `err` is (or looks like) the funded-wallet-selection failure
 * (`InsufficientPublisherFundsError`, code `NO_FUNDED_PUBLISHER_WALLET`) —
 * code-first, with a message-marker fallback for a re-wrap that dropped `.code`.
 * Code + marker are the shared dkg-core contract so the daemon, publisher
 * classifier, chain, and node-ui cannot drift. Shared by the `/vm/publish` route
 * catch and the top-level daemon handler.
 */
export function isNoFundedPublisherWalletLike(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  if (e?.code === NO_FUNDED_PUBLISHER_WALLET_CODE) return true;
  return messageIndicatesNoFundedPublisherWallet(e?.message);
}

/** The HTTP-400 response body for a no-funded-wallet publish failure: the
 *  structured `code` plus the actionable message (which lists per-wallet
 *  balances). Single source of truth for both publish routes. */
export function noFundedPublisherWalletBody(message: string): { code: string; error: string } {
  return { code: NO_FUNDED_PUBLISHER_WALLET_CODE, error: message };
}

/**
 * Map a thrown request error to the daemon's top-level HTTP response — the
 * single neutral place that rethrowing lifecycle publish routes
 * and the lifecycle catch agree on status codes: 413 payload-too-large; 400 for
 * SyntaxError / reserved-namespace / NO_FUNDED_PUBLISHER_WALLET; otherwise a 500
 * with the EVM-decoded message. Unit-testable in isolation.
 */
export function respondWithDaemonError(res: ServerResponse, err: any): void {
  if (res.headersSent || res.writableEnded) return;
  if (isPayloadTooLargeError(err)) {
    jsonResponse(res, 413, payloadTooLargeResponseBody(err));
  } else if (err instanceof SyntaxError) {
    jsonResponse(res, 400, { error: err.message });
  } else if (
    // Round 9 Bug 25: user-authored quads with reserved URN prefixes map to 400
    // so share/publish routes that rethrow get the correct status.
    err?.name === 'ReservedNamespaceError' ||
    (typeof err?.message === 'string' && err.message.includes('reserved namespace'))
  ) {
    jsonResponse(res, 400, { error: err.message });
  } else if (isNoFundedPublisherWalletLike(err)) {
    // Funded-wallet selection found no operational wallet with gas + TRAC — a
    // user-actionable funding condition (4xx), not a server bug.
    jsonResponse(res, 400, noFundedPublisherWalletBody(typeof err?.message === 'string' ? err.message : String(err)));
  } else if (respondIfChainRpcTransportError(res, err)) {
    // Transient transport exhaustion (RPC_ENDPOINTS_EXHAUSTED /
    // RPC_RECEIPT_LOOKUP_FAILED → 503, TIMEOUT → 504) is retryable — a route
    // that RE-THROWS to this top-level handler gets the retryable status instead
    // of 500.
    // Code-keyed, so on-chain reverts (no transport code) fall through to 500.
  } else {
    enrichEvmError(err);
    jsonResponse(res, 500, { error: err?.message ?? String(err) });
  }
}

export function oversizedRdfLiteralResponseBody(err: unknown): Record<string, unknown> {
  const shaped = (err && typeof err === 'object') ? err as Record<string, unknown> : {};
  const message = err instanceof Error ? err.message : String(err ?? 'Oversized RDF literal');
  const body: Record<string, unknown> = {
    error: message,
    code: 'OVERSIZED_RDF_LITERAL',
  };
  const maxBytes = shaped.maxBytes;
  if (typeof maxBytes === 'number') body.limitBytes = maxBytes;
  const actualBytes = shaped.actualBytes;
  if (typeof actualBytes === 'number') body.actualBytes = actualBytes;
  const subject = shaped.subject;
  if (typeof subject === 'string') body.subject = subject;
  const predicate = shaped.predicate;
  if (typeof predicate === 'string') body.predicate = predicate;
  const graph = shaped.graph;
  if (typeof graph === 'string') body.graph = graph;
  return body;
}

export async function resolveNameToPeerId(
  agent: DKGAgent,
  nameOrId: string,
): Promise<string | null> {
  // If it looks like a PeerId already (starts with 12D3 or 16Uiu), return as-is
  if (
    nameOrId.startsWith("12D3") ||
    nameOrId.startsWith("16Uiu") ||
    nameOrId.length > 40
  ) {
    return nameOrId;
  }

  const agents = await agent.findAgents();
  const lower = nameOrId.toLowerCase();
  const match = agents.find(
    (a) =>
      a.name.toLowerCase() === lower || a.name.toLowerCase().startsWith(lower),
  );
  return match?.peerId ?? null;
}

/**
 * GH #306 / #787 — shape guard for the WRITE routes (wm/write,
 * shared-memory/write). The `graph` term is OPTIONAL here: those routes
 * legitimately accept `{subject,predicate,object}`
 * and fill the graph internally. Without this guard, a string-shaped quad
 * (e.g. an N-Quad line `"<s> <p> <o> ."`) slips past a bare `Array.isArray`
 * check and crashes the agent write path with a TypeError → HTTP 500 instead
 * of an actionable 4xx.
 */
export function isWritableQuad(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.subject === "string" &&
    typeof v.predicate === "string" &&
    typeof v.object === "string" &&
    (v.graph === undefined || typeof v.graph === "string")
  );
}

export function validateWritableQuadLiteralSizes(
  label: string,
  quads: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
): { ok: true } | { ok: false; body: Record<string, unknown> } {
  try {
    assertQuadLiteralsMutf8Safe(quads, { label });
    return { ok: true };
  } catch (err) {
    if (isOversizedRdfLiteralError(err)) {
      return { ok: false, body: oversizedRdfLiteralResponseBody(err) };
    }
    throw err;
  }
}

/**
 * GH #306 / #787 (follow-up) — validate each quad's `object` term is either a
 * quoted RDF literal (`"…"`) or an absolute IRI. Shared by lifecycle write
 * routes and other quad-accepting validation paths: the shape guard
 * ({@link isWritableQuad}) only checks that fields
 * are strings, so an object that is neither a literal nor an IRI (e.g. a bare
 * word `hello` or a number `123`) slips past them and crashes the RDF parser
 * with an uncaught "No scheme found in an absolute IRI" → HTTP 500 instead of an
 * actionable 400.
 */
export function validateQuadObjectTerms(
  label: string,
  quads: ReadonlyArray<{ object: string }>,
): string | null {
  const badIndex = quads.findIndex((q) => {
    const object = q.object.trim();
    return !object.startsWith('"') && !isSafeIri(object);
  });
  if (badIndex === -1) return null;
  return `Invalid "${label}[${badIndex}].object": RDF object must be a quoted literal term or absolute IRI`;
}

/**
 * KA-number-floor reconcile resilience (follow-up to the "KA create 500-on-429"
 * fix). If `e` is a **transient** reconcile failure — the chain RPC couldn't serve
 * the one-time-per-author floor read (e.g. a 429 after the bounded retry in
 * `allocator.ts` is exhausted) — send a retryable **503** and return true;
 * otherwise return false so the caller falls through to its normal mapping.
 *
 * The transient-vs-deterministic verdict comes from `retryable` (derived from
 * `isTransientChainError`): the typed `KaFloorReconcileError` carries it, and the
 * finalize/selection re-wrap sites in `dkg-agent-publish.ts` tag the same marker.
 * A deterministic failure (`retryable === false`, e.g. a revert) is NOT a 503 —
 * advertising a retry would be pointless — so it falls through. The legacy
 * message-text match is honored ONLY when the error explicitly marks itself
 * retryable, so a bare re-wrapped message can never force a deterministic error
 * into a retryable 503 (PR #1319 review). Used by every route that can trigger the
 * reconcile (named create, one-shot publish, shared-memory publish, and the
 * WM-verb routes via `respondAssertionError`) so they answer consistently.
 */
export function respondIfReconcileUnavailable(res: ServerResponse, e: any): boolean {
  const msg = e?.message ?? String(e);
  const isTyped = e?.code === "KA_FLOOR_RECONCILE_UNAVAILABLE";
  // Message-text fallback (for errors re-wrapped on the way up) is accepted only
  // when the error explicitly carries a retryable marker — never for a bare
  // message, which might be hiding a deterministic revert.
  const isMarkedLegacyTransient =
    e?.retryable === true && /failed to reconcile KA-number floor/i.test(msg);
  if ((!isTyped && !isMarkedLegacyTransient) || e?.retryable === false) {
    return false;
  }
  jsonResponse(res, 503, {
    error: msg,
    code: "KA_FLOOR_RECONCILE_UNAVAILABLE",
    retryable: true,
  });
  return true;
}

/**
 * Strip http(s) URLs from a chain error message before it is returned in an
 * HTTP response body. The adapter's multi-provider `RPC_ENDPOINTS_EXHAUSTED`
 * message embeds `this.rpcUrls.join(', ')`, and with default-backup inheritance
 * an operator-set private `chain.rpcUrl` may carry an API key — so a response
 * body must never echo raw RPC URLs (the failover logger is already host-only).
 */
export function sanitizeRpcMessage(msg: string): string {
  return msg.replace(/https?:\/\/[^\s,)'"]+/gi, "[rpc]");
}

/**
 * Maps a TRANSPORT-level chain RPC failure to a RETRYABLE HTTP status,
 * keyed STRICTLY on `err.code` (never message text):
 *   - `RPC_ENDPOINTS_EXHAUSTED`   → 503 (all configured endpoints failed over)
 *   - `RPC_RECEIPT_LOOKUP_FAILED` → 503 (receipt lookup failed on every endpoint)
 *   - `TIMEOUT`                   → 504 (receipt wait / RPC request timed out)
 *
 * Returns `undefined` for anything else. On-chain reverts (`CALL_EXCEPTION`),
 * `INSUFFICIENT_FUNDS`, and application errors carry NO `RPC_*`/`TIMEOUT`
 * transport code (the chain adapter only stamps these on the multi-RPC
 * failover loops), so they fall through to each route's own mapping — which
 * preserves the #988 contract that a genuine publish/on-chain failure stays
 * 5xx/4xx and is NEVER down-classified by message text.
 *
 * Shared chokepoint for `/api/context-graph/register`, the `/vm/publish`
 * catch, `respondAssertionError` (WM-verb writes), the SWM→VM publish
 * auto-register leg, and the top-level daemon catch, so EVERY chain-write
 * surface answers a transient RPC outage with the SAME retryable status
 * instead of a generic 500 (or, in the auto-register leg, a misleading 400).
 * Mirrors the failover engine's own multi-RPC awareness at the HTTP boundary.
 */
export function classifyChainRpcTransportStatus(
  err: unknown,
): { status: number; body: Record<string, unknown> } | undefined {
  if (!isChainRpcTransportError(err)) return undefined;
  const { code } = err;
  const msg = sanitizeRpcMessage(typeof err.message === "string" ? err.message : "");
  const txHash = typeof err.txHash === "string" && err.txHash ? err.txHash : "";
  // Exhaustive over ChainRpcTransportCode: a new code added to the boundary
  // without a case here is a COMPILE error (the `never` default), so the
  // classifier can never silently inherit timeout/504 semantics for a new code.
  switch (code) {
    case "RPC_ENDPOINTS_EXHAUSTED":
      return { status: 503, body: { error: msg || "Configured chain RPC endpoints were exhausted.", code } };
    case "RPC_RECEIPT_LOOKUP_FAILED":
      return {
        status: 503,
        body: {
          error: msg || "Transaction receipt lookup failed on all configured chain RPC endpoints.",
          code,
          ...(txHash ? { txHash } : {}),
        },
      };
    case "RPC_TIMEOUT":
      // Internal, chain-namespaced timeout code. Expose the public/legacy
      // `code: "TIMEOUT"` in the 504 body (clients key on that), keeping the
      // wire contract stable while the boundary stays namespaced internally.
      return {
        status: 504,
        body: { error: msg || "Chain transaction timed out.", code: "TIMEOUT", ...(txHash ? { txHash } : {}) },
      };
    default: {
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}

/**
 * Single responder for a transient chain-RPC transport failure: maps it to a
 * retryable 503/504 (via {@link classifyChainRpcTransportStatus}), writes the
 * response, and returns true. Returns false (writing nothing) for any
 * non-transport error so the caller falls through to its own mapping.
 * `extraBody` adds route-specific fields to the response body (e.g. the identity
 * route's `{ identityId, hasIdentity }`). The canonical transport fields
 * (`error`, `code`, `txHash`) are merged LAST so a caller can never shadow them
 * — `extraBody` may only ADD fields, keeping this responder the single source of
 * truth for the transport response shape. Use this instead of repeating the
 * classify→jsonResponse branch in every chain-write catch.
 */
export function respondIfChainRpcTransportError(
  res: ServerResponse,
  err: unknown,
  extraBody?: Record<string, unknown>,
): boolean {
  const transport = classifyChainRpcTransportStatus(err);
  if (!transport) return false;
  jsonResponse(res, transport.status, extraBody ? { ...extraBody, ...transport.body } : transport.body);
  return true;
}

/**
 * route handlers across the
 * daemon return errors as `{ error: err.message }`, and `err.message`
 * sometimes carries the *first frame* of a stack — e.g. node's built-in
 * `TypeError`s embed `(/abs/path/file.js:line:col)` directly in the
 * message, and ethers/libp2p re-throw with file paths spliced into the
 * message too. CodeQL flags every reachable `res.end(JSON.stringify(...))`
 * sink for this; rather than auditing all 40+ call sites individually we
 * scrub the egress here so a malformed callsite physically cannot leak
 * server-internal paths or `at <fn> (path:line:col)` frames to the wire.
 *
 * The redaction is deliberately narrow:
 *   1. Strip `\n   at <fn> (...)` continuation lines (Node.js v8 stack
 *      frame format).
 *   2. Replace any absolute filesystem path containing a line:col suffix
 *      with `<redacted-path>` — covers the common `(/Users/.../foo.ts:12:34)`
 *      and `at /Users/.../foo.ts:12:34` patterns produced by Error.stack.
 *   3. Leave purely human messages untouched (no file path, no line:col).
 */
function stripStackFrames(input: string): string {
  return input
    // Multi-frame stack: drop everything from the first newline that
    // begins with whitespace + "at " onwards.
    .replace(/\n\s+at [\s\S]*$/m, '')
    // Absolute POSIX path with optional :line:col (with or without
    // surrounding parens). Matches `/Users/.../foo.ts:12:34` and
    // `/usr/.../foo.ts`.
    //
    // CodeQL js/redos (alert 56): a previous revision of this regex
    // used `(?:[^\s()]+\/)+[^\s()]+`, where the inner class
    // `[^\s()]` includes `/` itself. That made the partition between
    // segments ambiguous (the engine could explore many ways to
    // split `/!/!/!/.txt` across the alternatives) and produced
    // catastrophic backtracking on adversarial inputs starting with
    // `/` and many repetitions of `!/`. Excluding `/` from the
    // segment class makes the tokenisation unambiguous: every
    // character belongs to exactly one branch, so backtracking is
    // impossible. The bounded `{0,2}` on the line:col suffix is
    // the same shape as the original two `(?::\d+)?` groups but
    // expressed without the redundant alternation.
    .replace(/\(?\/(?:[^/\s()]+\/)+[^/\s()]+\.(?:js|ts|cjs|mjs|jsx|tsx)(?::\d+){0,2}\)?/g, '<redacted-path>')
    // Windows-style absolute path with optional :line:col
    // (defence-in-depth even though the daemon doesn't run on
    // Windows in CI). CodeQL js/redos (alert 57): same fix as above
    // — exclude the separator chars `\` and `/` from the inner
    // segment class so each character has exactly one role.
    .replace(/\(?[A-Za-z]:[\\/](?:[^\\/\s()]+[\\/])+[^\\/\s()]+\.(?:js|ts|cjs|mjs|jsx|tsx)(?::\d+){0,2}\)?/g, '<redacted-path>');
}

const ERROR_SHAPED_KEYS = new Set(['error', 'message', 'detail', 'details']);

function scrubResponseBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubResponseBody);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (ERROR_SHAPED_KEYS.has(k) && typeof v === 'string') {
        // Conventional error fields → scrub stack-frame patterns.
        // Successful-response fields with the same key would also be
        // scrubbed, which is acceptable: they should never contain stack
        // traces and `<redacted-path>` is harmless on legitimate strings
        // that don't match the pattern (the regex never fires).
        out[k] = stripStackFrames(v);
      } else if (v !== null && typeof v === 'object') {
        // Recurse into arrays/objects so nested error fields (common in
        // batch / aggregate responses) are scrubbed too.
        out[k] = scrubResponseBody(v);
      } else {
        // Leaf primitives (string/number/bool/bigint/null) outside the
        // error-shaped key set are passed through untouched. This keeps
        // success-shape fields like `filePath`, `uri`, `contextGraphId`
        // — which legitimately contain `/` — pristine.
        out[k] = v;
      }
    }
    return out;
  }
  // Top-level non-object values (string/number/etc.) — leave alone.
  // We never scrub a bare string at the top level because callers pass
  // structured objects; bare strings would be ambiguous re: error vs
  // legitimate identifier.
  return value;
}

export function jsonResponse(
  res: ServerResponse,
  status: number,
  data: unknown,
  corsOrigin?: string | null,
  extraHeaders?: Record<string, string>,
): void {
  const origin =
    corsOrigin !== undefined
      ? corsOrigin
      : (((res as any).__corsOrigin as string | null) ?? null);
  const scrubbed = scrubResponseBody(data);
  const rawBody = JSON.stringify(scrubbed, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  // CodeQL js/stack-trace-exposure (alert 47): the structural scrub in
  // `scrubResponseBody` already neutralises stack-frame patterns inside
  // error-shaped fields, but CodeQL's data-flow analysis cannot always
  // follow the recursive descent through `Array.isArray` / `Object.entries`
  // — it sees `err.message` flowing into `data` and `data` flowing into
  // `res.end(body)` and conservatively flags every reachable callsite.
  // A direct `String.prototype.replace` between the JSON serialisation
  // and the response sink is the canonical sanitiser the CodeQL query
  // recognises, so we do one final last-mile pass on the serialised body.
  //
  // The
  // previous last-mile pass only matched `\n   at <fn> (...)` — a v8
  // continuation line as it appears INSIDE a JSON-escaped string.
  // CodeQL's data-flow analysis still flagged the `res.end(body)`
  // sink because the regex did not sanitise the additional stack-
  // shaped patterns it recognises:
  //   - bare "at <fn> (...)" frames at the head of an err.message
  //     (no leading newline — surfaced by libp2p / ethers wrappers
  //     that splice the first frame straight into the message);
  //   - top-level multi-frame Error.stack copies that did make it
  //     through the structural scrub via a non-error-shaped key.
  //
  // The replacement chain below targets ONLY recognisable stack-frame
  // tokens (`at <fn> (...)` shapes) at the egress boundary; it does
  // NOT touch bare absolute paths because legitimate non-error
  // response fields (`filePath`, `path`, `endpoint`, …) routinely
  // contain `/`-delimited identifiers and absolute paths that MUST be
  // preserved. Path-with-line:col redaction stays inside
  // `stripStackFrames`, which only runs on the curated
  // `ERROR_SHAPED_KEYS` set. On already-clean payloads every regex
  // misses, so `body === rawBody` and there is no observable
  // behaviour change.
  //
  // — http-utils.ts:328). The earlier
  // shape `\s+at\s+(?:[^\s()"]+\s+)?\([^)"\n]+\)` recognised any
  // `(stuff)` after an `at <word>` token, so a perfectly-legitimate
  // payload like `{"text":"meet at lunch (cafeteria)"}` matched the
  // ` at lunch (cafeteria)` slice and the response degraded to
  // `{"text":"meet"}`. The fix is to require the parenthesised body
  // to actually look like a v8 stack frame location:
  //   - either contain `:NUM:NUM` (the file:line:col suffix that
  //     every real frame carries — `at fn (file.js:10:20)`); OR
  //   - be one of the special sentinels v8 emits without a location
  //     (`<anonymous>`, `native`, `eval at ...`).
  // The async-continuation shape `(index N)` from
  // `at async Promise.all (index 0)` does NOT match — but those
  // continuation lines are always interleaved with real `:line:col`
  // frames in a stack trace, so the surrounding pass still removes
  // the parent stack and the lone continuation is harmless.
  //
  // ReDoS safety: every alternative is anchored by literal tokens
  // (`:`, `<anonymous>`, `native`) and each character class has a
  // unique role per branch — the same anti-backtracking shape as
  // the existing `stripStackFrames` regex (CodeQL alerts 56 / 57).
  //
  // http-utils.ts:343). The previous
  // revision applied this last-mile regex chain to EVERY response
  // body unconditionally. That meant successful 2xx payloads like
  // a `/api/query` SELECT result that legitimately carries a string
  // literal containing v8-frame-shaped text (e.g. an indexed user
  // tweet, an issue title that copy-pastes a stack trace, a SPARQL
  // literal embedding source-position metadata) would have those
  // substrings silently elided from the response — the data
  // returned to the client would not match what the route handler
  // actually emitted, with NO indication of the rewrite. CodeQL's
  // js/stack-trace-exposure data-flow concern is about `err.message`
  // → `data` → `res.end(body)`, which is exclusively an error-path
  // concern. Successful responses do not have err.message reaching
  // the response sink (no `try/catch` injects err.message into a
  // 2xx body in this codebase), so the pacifier only needs to run
  // on error responses (status >= 400). Scoping it there preserves
  // the CodeQL silence on the flagged sink while making
  // success-path payload corruption impossible.
  const isErrorResponse = status >= 400;
  const body = isErrorResponse
    ? rawBody
        .replace(/\\n\s+at [^"\n]+/g, "")
        .replace(
          /\s+at\s+(?:[^\s()"]+\s+)?\((?:[^)"\n]*?:\d+(?::\d+)?|<anonymous>|native|eval[^)"\n]*)\)/g,
          "",
        )
        .replace(/\s+at\s+[^\s()":]+:\d+:\d+/g, "")
    : rawBody;
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsHeaders(origin),
    ...(extraHeaders ?? {}),
  });
  res.end(body);
}

export function safeDecodeURIComponent(
  encoded: string,
  res: ServerResponse,
): string | null {
  try {
    return decodeURIComponent(encoded);
  } catch {
    jsonResponse(res, 400, { error: "Malformed percent-encoding in URL path" });
    return null;
  }
}

export function safeParseJson(
  body: string,
  res: ServerResponse,
): Record<string, any> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    jsonResponse(res, 400, { error: "Invalid JSON in request body" });
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    jsonResponse(res, 400, { error: "Request body must be a JSON object" });
    return null;
  }
  return parsed as Record<string, any>;
}

export function validateOptionalSubGraphName(
  subGraphName: unknown,
  res: ServerResponse,
): boolean {
  if (subGraphName === undefined || subGraphName === null) return true;
  if (typeof subGraphName === "string" && subGraphName === "") {
    jsonResponse(res, 400, {
      error:
        "subGraphName must be a non-empty string (omit the field for root graph)",
    });
    return false;
  }
  if (typeof subGraphName !== "string") {
    jsonResponse(res, 400, { error: "subGraphName must be a string" });
    return false;
  }
  const v = validateSubGraphName(subGraphName);
  if (!v.valid) {
    jsonResponse(res, 400, { error: `Invalid "subGraphName": ${v.reason}` });
    return false;
  }
  return true;
}

export function validateRequiredContextGraphId(
  contextGraphId: unknown,
  res: ServerResponse,
): boolean {
  if (!contextGraphId) {
    jsonResponse(res, 400, { error: 'Missing "contextGraphId"' });
    return false;
  }
  if (typeof contextGraphId !== "string") {
    jsonResponse(res, 400, { error: '"contextGraphId" must be a string' });
    return false;
  }
  const v = validateContextGraphId(contextGraphId);
  if (!v.valid) {
    jsonResponse(res, 400, { error: `Invalid "contextGraphId": ${v.reason}` });
    return false;
  }
  return true;
}

const CONTEXT_GRAPH_URI_PREFIX = "did:dkg:context-graph:";

export function normalizeContextGraphIdOrUri(contextGraphId: string): string {
  return contextGraphId.startsWith(CONTEXT_GRAPH_URI_PREFIX)
    ? contextGraphId.slice(CONTEXT_GRAPH_URI_PREFIX.length)
    : contextGraphId;
}

type ExistingContextGraphRow = {
  id?: unknown;
  uri?: unknown;
  creator?: unknown;
  curator?: unknown;
  accessPolicy?: unknown;
  onChainId?: unknown;
  isSystem?: unknown;
  subscribed?: unknown;
  synced?: unknown;
};

function normalizeContextGraphCallerAddress(
  callerAgentAddress?: string | null,
): string | null {
  if (!callerAgentAddress) return null;
  const didPrefix = "did:dkg:agent:";
  const address = callerAgentAddress.startsWith(didPrefix)
    ? callerAgentAddress.slice(didPrefix.length)
    : callerAgentAddress;
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? address : null;
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function isWalletScopedContextGraphId(id: string): boolean {
  return /^0x[0-9a-fA-F]{40}\//.test(id);
}

function isShadowLikeBareContextGraphRow(row: ExistingContextGraphRow): boolean {
  const id = typeof row.id === "string" ? row.id : "";
  if (!id || id.includes("/")) return false;
  return (
    typeof row.creator !== "string" &&
    typeof row.curator !== "string" &&
    typeof row.accessPolicy !== "string" &&
    typeof row.onChainId !== "string" &&
    row.subscribed !== true
  );
}

async function contextGraphRowIsWritable(
  agent: {
    contextGraphHasLocalContent?: (contextGraphId: string) => Promise<boolean>;
    contextGraphExists?: (contextGraphId: string) => Promise<boolean>;
  },
  row: ExistingContextGraphRow,
): Promise<boolean> {
  if (row.isSystem === true || (row.subscribed === true && row.synced === true)) {
    return true;
  }
  const id = typeof row.id === "string" ? row.id : "";
  if (!id) return false;
  if (agent.contextGraphHasLocalContent && await agent.contextGraphHasLocalContent(id)) {
    return true;
  }
  if (
    row.subscribed !== true &&
    !isShadowLikeBareContextGraphRow(row) &&
    agent.contextGraphExists
  ) {
    return agent.contextGraphExists(id);
  }
  return false;
}

function rejectKnownNonWritableContextGraph(
  res: ServerResponse,
  raw: string,
): null {
  jsonResponse(res, 400, {
    code: "CONTEXT_GRAPH_NOT_WRITABLE",
    error:
      `Context graph "${raw}" is known but is not locally synced for writes. ` +
      `Subscribe/sync the context graph first, then retry the write.`,
  });
  return null;
}

function contextGraphValidationUnavailable(
  res: ServerResponse,
  message: string,
): null {
  jsonResponse(res, 503, {
    code: "CONTEXT_GRAPH_VALIDATION_UNAVAILABLE",
    error: `Failed to validate contextGraphId against known context graphs: ${message}`,
  });
  return null;
}

function hasActiveSyncedSubscription(probe: ContextGraphWritePreflightProbe): boolean {
  return (
    probe.inMemorySubscription?.subscribed === true &&
    probe.inMemorySubscription.synced === true
  );
}

function hasAnySyncedSubscription(probe: ContextGraphWritePreflightProbe): boolean {
  return (
    hasActiveSyncedSubscription(probe) ||
    (probe.persistedSubscription?.subscribed === true && probe.persistedSubscription.synced === true)
  );
}

function exactProbeIsLocallyWritable(
  probe: ContextGraphWritePreflightProbe,
  requireLocalWritable: boolean,
): boolean {
  // Typed boundary: never trust store-derived facts when the store was down.
  // (`exists !== true` below already blocks a bare `undefined`, but gating on
  // the required discriminant makes the "only-when-available" contract
  // explicit and future-proofs the predicate against new fact reads.)
  if (!probe.storeAvailable) return false;
  // Store-derived probe facts are tri-state (`undefined` = the store read
  // failed); only an explicit `true` counts as positive evidence here.
  if (probe.exists !== true) return false;
  if (!requireLocalWritable) {
    return hasActiveSyncedSubscription(probe) || probe.hasLocalContent === true || probe.declarationFound === true;
  }
  return hasActiveSyncedSubscription(probe) || probe.hasLocalContent === true;
}

function exactProbeCanFastAccept(
  probe: ContextGraphWritePreflightProbe,
  requireLocalWritable: boolean,
  callerAgentAddress: string | null,
): boolean {
  if (!exactProbeIsLocallyWritable(probe, requireLocalWritable)) return false;
  if (!callerAgentAddress) return probe.accessPolicy === "public";
  return probe.callerAuthorized === true;
}

function exactProbeIsAuthoritativeBearerDeny(
  probe: ContextGraphWritePreflightProbe,
  callerAgentAddress: string | null,
): boolean {
  // An authoritative deny requires trustworthy store-derived facts
  // (declaration + private policy + caller-not-authorized). With the store
  // down these are UNKNOWN, so refuse to synthesize a deny from them.
  return (
    probe.storeAvailable &&
    !!callerAgentAddress &&
    probe.exists === true &&
    probe.declarationFound === true &&
    probe.accessPolicy === "private" &&
    probe.callerAuthorized === false
  );
}

function exactProbeIsStaleSubscription(probe: ContextGraphWritePreflightProbe): boolean {
  // `!probe.exists` / `!probe.hasLocalContent` are truthy for UNKNOWN
  // (`undefined`) facts too, so this must only run against an AVAILABLE
  // store — otherwise a store outage would masquerade as a stale
  // subscription and reject a live write. The required `storeAvailable`
  // discriminant enforces that at the boundary.
  return (
    probe.storeAvailable &&
    hasAnySyncedSubscription(probe) &&
    !probe.exists &&
    !probe.hasLocalContent
  );
}

function rejectUnknownContextGraph(
  res: ServerResponse,
  raw: string,
): null {
  jsonResponse(res, 400, {
    code: "CONTEXT_GRAPH_NOT_FOUND",
    error:
      `Unknown contextGraphId "${raw}". Write operations must target an existing ` +
      `context graph. Use /api/context-graph/list or dkg_list_context_graphs and ` +
      `pass the canonical id (for curated graphs, "<curatorAddress>/<slug>") ` +
      `or full did:dkg:context-graph:... URI.`,
  });
  return null;
}

const writePreflightRescueLog = new Logger('daemon-http');

/** Bound for the last-resort on-chain rescue eth_call, so an RPC stack that
 *  hangs on connect cannot stall a write route that is already degraded.
 *  Exported so tests can drive the timeout branch without waiting the full
 *  production window; production callers never pass an override so the
 *  default behaviour is unchanged. */
export const WRITE_PREFLIGHT_CHAIN_RESCUE_TIMEOUT_MS = 5_000;

/**
 * Track B (write-preflight resilience) — last-resort write-target acceptance
 * when BOTH validation legs failed (the exact preflight probe AND
 * listContextGraphs), i.e. the local store is unavailable and the daemon would
 * otherwise 503 every write until it recovers.
 *
 * The store-free accept DECISION lives behind the agent/preflight boundary:
 * this helper delegates to the agent's high-level
 * `validateWriteTargetDuringStoreOutage`, which OWNS the on-chain access-policy
 * semantics (registry onChainId + `isContextGraphActiveOnChain` + public
 * `getContextGraphAccessPolicy`). The daemon only bounds that call with a
 * timeout and emits the WARN log — it never assembles chain-policy meaning
 * itself.
 *
 * Why the agent requires positive PUBLIC proof (not just an in-memory
 * subscription): an active subscription proves the node HOSTS/tracks the CG,
 * but carries NO access-policy and NO per-caller authorization. The healthy
 * write-preflight denies an authenticated-but-unauthorized caller of a PRIVATE
 * CG (`exactProbeIsAuthoritativeBearerDeny`, accessPolicy `private`); that
 * verdict comes from the local `_meta` allowlist, which is exactly what's
 * unavailable while the store is down. Accepting a subscribed PRIVATE CG here
 * would silently convert that DENY into an accept for any authenticated caller.
 *
 * Anything short of that proof — chain says not-active/non-public, throws, times
 * out, or the adapter lacks a read — keeps today's fail-closed 503 verbatim.
 * This never converts an existing DENY into an accept: it runs only when the
 * exact probe was UNAVAILABLE (threw or degraded) AND the list leg threw, only
 * ever admits an id the registry ALREADY tracks (never a raw unknown candidate
 * → shadow-CG fail-closed holds), and only when that id is provably public (no
 * per-caller preflight deny exists to convert).
 */
async function rescueWriteTargetWithoutStore(
  agent: {
    validateWriteTargetDuringStoreOutage?: (contextGraphId: string) => Promise<boolean>;
  },
  candidateId: string,
  unavailableMessage: string,
  timeoutMs: number = WRITE_PREFLIGHT_CHAIN_RESCUE_TIMEOUT_MS,
): Promise<boolean> {
  if (typeof agent.validateWriteTargetDuringStoreOutage !== 'function') return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const activePublic = await Promise.race([
      agent.validateWriteTargetDuringStoreOutage(candidateId),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
        // Allow the process to exit even if the chain promise never settles.
        timer.unref?.();
      }),
    ]);
    if (activePublic !== true) return false;
  } catch {
    // RPC failure / contract absent — keep the fail-closed 503.
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
  writePreflightRescueLog.warn(
    createOperationContext('resolve'),
    `write preflight: accepting context graph "${candidateId}" via positive on-chain proof it is an active PUBLIC context graph — local store unavailable (${unavailableMessage})`,
  );
  return true;
}

/**
 * The outcome of the EXACT write-preflight probe leg, as a single discriminated
 * value so the list-fallback leg branches on one result instead of a cluster of
 * distant mutable booleans (otReviewAgent #1408):
 *   - `accept`        — fast-accept; the caller returns the candidate id.
 *   - `rejectUnknown` — a definitive, store-backed deny of a non-bare id; the
 *                       caller returns 404.
 *   - `deferReject`   — a definitive deny of a BARE id; continue to the list leg
 *                       and reject only if that leg ALSO misses (a name may
 *                       resolve differently there).
 *   - `unavailable`   — the probe threw or degraded (`storeUnavailable`); this
 *                       is the ONLY verdict that makes the both-legs-failed
 *                       store-free rescue eligible. `errorMessage` feeds the 503.
 *   - `continueToList`— no probe, or a definitive miss with nothing to carry.
 */
type ExactPreflightDecision =
  | { kind: "accept" }
  | { kind: "rejectUnknown" }
  | { kind: "deferReject" }
  | { kind: "unavailable"; errorMessage: string }
  | { kind: "continueToList" };

/**
 * Run the exact write-preflight probe and reduce it to one {@link
 * ExactPreflightDecision}. Owns the probe interpretation (fast-accept,
 * degraded-store, authoritative deny) so `resolveRequiredWriteContextGraphId`
 * never re-synchronises availability/deferral/diagnostic flags across branches.
 * Deliberately takes no `ServerResponse` — HTTP responses stay with the caller.
 */
async function evaluateExactWritePreflight(
  agent: {
    probeContextGraphWritePreflight?: (
      contextGraphId: string,
      opts?: { callerAgentAddress?: string | null },
    ) => Promise<ContextGraphWritePreflightProbe>;
  },
  candidateId: string,
  opts: {
    callerAgentAddress: string | null;
    requireLocalWritable: boolean;
    isBareCandidateId: boolean;
  },
): Promise<ExactPreflightDecision> {
  if (!agent.probeContextGraphWritePreflight) return { kind: "continueToList" };
  const { callerAgentAddress, requireLocalWritable, isBareCandidateId } = opts;
  try {
    const probe = await agent.probeContextGraphWritePreflight(candidateId, {
      callerAgentAddress,
    });
    // Fast-accept wins even under a degraded store (it never rests on UNKNOWN
    // store fields), so check it before any deny/unavailable interpretation.
    if (exactProbeCanFastAccept(probe, requireLocalWritable, callerAgentAddress)) {
      return { kind: "accept" };
    }
    if (probe.storeUnavailable === true) {
      // The probe survived a store failure and degraded its store-derived
      // fields to UNKNOWN. Deny-ish verdicts are NOT trustworthy from unknowns
      // (that would turn a store outage into a 400), so carry the store error
      // for the both-legs-failed 503 and leave the verdict to the list/rescue.
      return {
        kind: "unavailable",
        errorMessage: probe.storeErrorMessage ?? "local store unavailable",
      };
    }
    // Store answered definitively — a deny-ish verdict is authoritative. Bare
    // ids defer (the list leg may resolve the name); qualified ids reject now.
    if (
      exactProbeIsStaleSubscription(probe) ||
      exactProbeIsAuthoritativeBearerDeny(probe, callerAgentAddress)
    ) {
      return isBareCandidateId ? { kind: "deferReject" } : { kind: "rejectUnknown" };
    }
    return { kind: "continueToList" };
  } catch (err) {
    // The exact probe could not answer local existence at all (store down / read
    // broke). The ONLY degraded case that makes the both-legs-failed rescue
    // eligible: there is no authoritative local-miss verdict to override.
    return {
      kind: "unavailable",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Resolve a write target to a known, canonical context graph id.
 *
 * The storage layer auto-materializes named graphs on first insert, so syntax
 * validation is not enough for mutation routes. This helper fail-closes before
 * callers reach agent/publisher/storage code that would create a shadow CG.
 */
export async function resolveRequiredWriteContextGraphId(
  agent: {
    listContextGraphs(opts?: {
      callerAgentAddress?: string | null;
    }): Promise<ExistingContextGraphRow[]>;
    contextGraphHasLocalContent?: (contextGraphId: string) => Promise<boolean>;
    contextGraphExists?: (contextGraphId: string) => Promise<boolean>;
    probeContextGraphWritePreflight?: (
      contextGraphId: string,
      opts?: { callerAgentAddress?: string | null },
    ) => Promise<ContextGraphWritePreflightProbe>;
    /**
     * High-level store-outage rescue decision (owns the on-chain
     * active+public policy semantics). The daemon calls ONLY this method for
     * the both-legs-failed rescue — it never assembles chain-policy meaning
     * locally.
     */
    validateWriteTargetDuringStoreOutage?: (contextGraphId: string) => Promise<boolean>;
  },
  contextGraphId: unknown,
  res: ServerResponse,
  opts: {
    callerAgentAddress?: string | null;
    requireLocalWritable?: boolean;
    allowLocalExactFallback?: boolean;
    /**
     * Test-only seam: override the store-outage rescue eth_call timeout so the
     * timeout branch can be exercised without waiting the full production
     * window. Production callers never pass this, so the default is unchanged.
     */
    chainRescueTimeoutMs?: number;
  } = {},
): Promise<string | null> {
  if (!validateRequiredContextGraphId(contextGraphId, res)) return null;

  const raw = (contextGraphId as string).trim();
  const candidateId = normalizeContextGraphIdOrUri(raw);
  const requireLocalWritable = opts.requireLocalWritable !== false;
  const candidateValidation = validateContextGraphId(candidateId);
  if (!candidateValidation.valid) {
    jsonResponse(res, 400, {
      error: `Invalid "contextGraphId": ${candidateValidation.reason}`,
    });
    return null;
  }

  const callerAgentAddress = normalizeContextGraphCallerAddress(
    opts.callerAgentAddress,
  );
  const isBareCandidateId = !candidateId.includes("/");
  // Exact write-preflight leg reduced to ONE decision (see
  // ExactPreflightDecision) so this resolver never keeps availability, deferral
  // and diagnostic-text flags in sync across distant branches.
  const exactDecision = await evaluateExactWritePreflight(agent, candidateId, {
    callerAgentAddress,
    requireLocalWritable,
    isBareCandidateId,
  });
  if (exactDecision.kind === "accept") return candidateId;
  if (exactDecision.kind === "rejectUnknown") {
    return rejectUnknownContextGraph(res, raw);
  }
  // Immutable carry-forward for the list leg. Track B (rescue gating): the
  // store-free on-chain rescue may run ONLY on an `unavailable` verdict — the
  // exact probe THREW or degraded (`storeUnavailable`) and so has no
  // authoritative local-miss to override. A definitive local miss (any other
  // kind) keeps the fail-closed 503 if the list leg then fails.
  const deferredExactProbeReject = exactDecision.kind === "deferReject";
  const exactProbeUnavailable = exactDecision.kind === "unavailable";
  const exactProbeErrorMessage =
    exactDecision.kind === "unavailable" ? exactDecision.errorMessage : null;

  let contextGraphs: ExistingContextGraphRow[];
  try {
    contextGraphs = callerAgentAddress
      ? await agent.listContextGraphs({ callerAgentAddress })
      : await agent.listContextGraphs();
  } catch (err) {
    const listMessage = err instanceof Error ? err.message : String(err);
    const message = exactProbeErrorMessage
      ? `exact preflight failed: ${exactProbeErrorMessage}; list validation failed: ${listMessage}`
      : listMessage;
    // BOTH legs failed. Before surfacing the 503, try the store-free rescue —
    // but ONLY when the exact probe itself was UNAVAILABLE (it threw or
    // degraded to `storeUnavailable`). If the exact probe SUCCEEDED with a
    // definitive local miss and only the list leg threw, that probe is
    // authoritative for local existence: the on-chain rescue must NOT override
    // it. Accepting there would let an id that the store definitively lacks
    // slip through on chain state alone. So gate on `exactProbeUnavailable`.
    // When it runs, the rescue accepts only on positive on-chain proof the id
    // the daemon already tracks is an active PUBLIC context graph; everything
    // else keeps the legacy 503 verbatim.
    if (
      exactProbeUnavailable &&
      (await rescueWriteTargetWithoutStore(
        agent,
        candidateId,
        message,
        opts.chainRescueTimeoutMs,
      ))
    ) {
      return candidateId;
    }
    return contextGraphValidationUnavailable(res, message);
  }

  const knownIds = contextGraphs
    .map((row) => (typeof row.id === "string" ? row.id : ""))
    .filter((id) => id.length > 0);

  const exact = contextGraphs.find((row) => {
    const id = typeof row.id === "string" ? row.id : "";
    const uri = typeof row.uri === "string" ? row.uri : "";
    return id === candidateId || uri === raw;
  });
  let exactWritable = false;
  if (exact?.id && typeof exact.id === "string") {
    try {
      exactWritable = await contextGraphRowIsWritable(agent, exact);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jsonResponse(res, 500, {
        error: `Failed to validate contextGraphId local writability: ${message}`,
      });
      return null;
    }
  }
  if (isBareCandidateId) {
    const suffixMatches = uniqueStrings(
      knownIds.filter((id) =>
        isWalletScopedContextGraphId(id) && id.endsWith(`/${candidateId}`),
      ),
    );
    if (exact?.id && typeof exact.id === "string" && suffixMatches.length > 0 && exactWritable) {
      if (!deferredExactProbeReject) return exact.id;
    }
    if (
      exact?.id &&
      typeof exact.id === "string" &&
      suffixMatches.length > 0 &&
      !deferredExactProbeReject &&
      !isShadowLikeBareContextGraphRow(exact)
    ) {
      if (requireLocalWritable && !exactWritable) {
        return rejectKnownNonWritableContextGraph(res, raw);
      }
      return exact.id;
    }
    if (suffixMatches.length === 1) {
      const canonicalContextGraphId = suffixMatches[0];
      jsonResponse(res, 400, {
        code: "CONTEXT_GRAPH_ID_NOT_CANONICAL",
        error:
          `Context graph id "${candidateId}" matches a curated context graph. ` +
          `Use canonical contextGraphId "${canonicalContextGraphId}".`,
        canonicalContextGraphId,
      });
      return null;
    }
    if (suffixMatches.length > 1) {
      jsonResponse(res, 400, {
        code: "CONTEXT_GRAPH_ID_AMBIGUOUS",
        error:
          `Context graph id "${candidateId}" matches multiple context graphs. ` +
          `Use one of the canonical contextGraphIds from canonicalContextGraphIds.`,
        canonicalContextGraphIds: suffixMatches,
      });
      return null;
    }
    if (deferredExactProbeReject) {
      return rejectUnknownContextGraph(res, raw);
    }
    if (exact?.id && typeof exact.id === "string") {
      if (requireLocalWritable && !exactWritable) {
        return rejectKnownNonWritableContextGraph(res, raw);
      }
      return exact.id;
    }
  }

  if (exact?.id && typeof exact.id === "string") {
    if (requireLocalWritable && !exactWritable) {
      return rejectKnownNonWritableContextGraph(res, raw);
    }
    return exact.id;
  }

  if (opts.allowLocalExactFallback && agent.contextGraphExists) {
    try {
      if (await agent.contextGraphExists(candidateId)) {
        return candidateId;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jsonResponse(res, 500, {
        error: `Failed to validate contextGraphId local existence: ${message}`,
      });
      return null;
    }
  }

  return rejectUnknownContextGraph(res, raw);
}

export function validateEntities(entities: unknown, res: ServerResponse): boolean {
  if (entities === undefined || entities === null || entities === "all")
    return true;
  if (typeof entities === "string") {
    jsonResponse(res, 400, {
      error: '"entities" must be "all" or an array of entity URIs',
    });
    return false;
  }
  if (
    !Array.isArray(entities) ||
    entities.length === 0 ||
    !entities.every((e: unknown) => typeof e === "string" && e.length > 0)
  ) {
    jsonResponse(res, 400, {
      error:
        '"entities" must be "all" or a non-empty array of non-empty strings',
    });
    return false;
  }
  return true;
}

export function validateConditions(conditions: unknown, res: ServerResponse): boolean {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    jsonResponse(res, 400, {
      error:
        '"conditions" must be a non-empty array (use the knowledge asset lifecycle routes for unconditional writes)',
    });
    return false;
  }
  for (let i = 0; i < conditions.length; i++) {
    const c = conditions[i];
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      jsonResponse(res, 400, { error: `conditions[${i}] must be an object` });
      return false;
    }
    if (typeof c.subject !== "string" || c.subject.length === 0) {
      jsonResponse(res, 400, {
        error: `conditions[${i}].subject must be a non-empty string`,
      });
      return false;
    }
    if (!isSafeIri(c.subject)) {
      jsonResponse(res, 400, {
        error: `conditions[${i}].subject contains characters unsafe for SPARQL IRIs`,
      });
      return false;
    }
    if (typeof c.predicate !== "string" || c.predicate.length === 0) {
      jsonResponse(res, 400, {
        error: `conditions[${i}].predicate must be a non-empty string`,
      });
      return false;
    }
    if (!isSafeIri(c.predicate)) {
      jsonResponse(res, 400, {
        error: `conditions[${i}].predicate contains characters unsafe for SPARQL IRIs`,
      });
      return false;
    }
    if (!("expectedValue" in c)) {
      jsonResponse(res, 400, {
        error: `conditions[${i}].expectedValue is required (use null for "must not exist")`,
      });
      return false;
    }
    if (c.expectedValue !== null && typeof c.expectedValue !== "string") {
      jsonResponse(res, 400, {
        error: `conditions[${i}].expectedValue must be a string or null`,
      });
      return false;
    }
  }
  return true;
}

export const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB — default for data-heavy endpoints (publish, update)
export const SMALL_BODY_BYTES = 256 * 1024; // 256 KB — for settings, connect, chat, and other small payloads
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB — for import-file document uploads (PDFs, DOCX, etc.)

/**
 * In-memory extraction job tracking record. Populated at import-file time
 * and queried by the extraction-status endpoint. Records are kept in a
 * bounded, TTL-pruned map keyed by the target assertion URI (which is
 * unique per agent × contextGraph × assertionName × subGraphName).
 */
export interface ImportFileExtractionPayload {
  status: "completed" | "skipped" | "failed";
  tripleCount: number;
  pipelineUsed: string | null;
  mdIntermediateHash?: string;
  error?: string;
  code?: string;
  limitBytes?: number;
  actualBytes?: number;
  subject?: string;
  predicate?: string;
  graph?: string;
  // #1101: when status === "skipped", explain WHY extraction was skipped so
  // callers don't have to guess (the dominant cause is an unrecognized
  // content type with no registered converter).
  skipReason?: string;
}

export function buildImportFileResponse(args: {
  assertionUri: string;
  fileHash: string;
  rootEntity?: string;
  detectedContentType: string;
  extraction: ImportFileExtractionPayload;
}) {
  return {
    assertionUri: args.assertionUri,
    fileHash: args.fileHash,
    ...(args.rootEntity ? { rootEntity: args.rootEntity } : {}),
    detectedContentType: args.detectedContentType,
    extraction: {
      status: args.extraction.status,
      tripleCount: args.extraction.tripleCount,
      pipelineUsed: args.extraction.pipelineUsed,
      ...(args.extraction.mdIntermediateHash
        ? { mdIntermediateHash: args.extraction.mdIntermediateHash }
        : {}),
      ...(args.extraction.error ? { error: args.extraction.error } : {}),
      ...(args.extraction.code ? { code: args.extraction.code } : {}),
      ...(args.extraction.limitBytes != null ? { limitBytes: args.extraction.limitBytes } : {}),
      ...(args.extraction.actualBytes != null ? { actualBytes: args.extraction.actualBytes } : {}),
      ...(args.extraction.subject ? { subject: args.extraction.subject } : {}),
      ...(args.extraction.predicate ? { predicate: args.extraction.predicate } : {}),
      ...(args.extraction.graph ? { graph: args.extraction.graph } : {}),
      ...(args.extraction.skipReason ? { skipReason: args.extraction.skipReason } : {}),
    },
  };
}

export function unregisteredSubGraphError(
  contextGraphId: string,
  subGraphName: string,
): string {
  return `Sub-graph "${subGraphName}" has not been registered in context graph "${contextGraphId}". Call createSubGraph() first.`;
}

export function readBody(
  req: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<string> {
  // When `httpAuthGuard` ran the
  // eager pre-handler drain for a body-carrying signed request, the
  // wire bytes are already buffered on `req.__dkgPrebufferedBody`
  // and the underlying stream is exhausted. Re-attaching `data`
  // listeners would observe nothing and the resulting `'end'` would
  // resolve to an empty body — which then ALSO bypasses the
  // post-body HMAC check (since the eager drain already flipped
  // `pending.verified = true`, `enforceSignedRequestPostBody` is a
  // no-op). Routes that legitimately need the body (e.g. PUT
  // /api/settings/...) would receive an empty payload instead of
  // their JSON, which would silently corrupt config writes.
  //
  // Fix: if a prebuffer is present, resolve from it directly
  // (re-checking the size limit so callers that lower `maxBytes`
  // still get the same 413). The signed-request HMAC was already
  // verified by the eager drain, so re-running
  // `enforceSignedRequestPostBody` here would be redundant — but we
  // call it anyway to preserve the centralised invariant that
  // EVERY body-reading site flows through the verifier.
  const prebuffered = (req as IncomingMessage & {
    __dkgPrebufferedBody?: Buffer;
  }).__dkgPrebufferedBody;
  if (Buffer.isBuffer(prebuffered)) {
    if (prebuffered.length > maxBytes) {
      return Promise.reject(new PayloadTooLargeError(maxBytes));
    }
    try {
      enforceSignedRequestPostBody(req, prebuffered);
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.resolve(prebuffered.toString());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    const onData = (c: Buffer) => {
      if (rejected) return;
      total += c.length;
      if (total > maxBytes) {
        rejected = true;
        req.removeListener("data", onData);
        req.resume();
        setTimeout(() => req.destroy(), 5_000); // close after giving time for 413 response
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(c);
    };
    req.on("data", onData);
    req.on("end", () => {
      if (rejected) return;
      const buf = Buffer.concat(chunks);
      // enforce the post-body
      // signed-request HMAC check here, centrally, so every route that
      // reads a body automatically validates the signature against the
      // actual bytes. Previously httpAuthGuard only pre-validated the
      // headers and stashed `__dkgSignedAuth`, but no caller invoked
      // verifyHttpSignedRequestAfterBody — which meant a valid bearer
      // token plus an arbitrary x-dkg-signature still reached the
      // handler with the body-binding guarantee silently disabled.
      try {
        enforceSignedRequestPostBody(req, buf);
      } catch (err) {
        reject(err);
        return;
      }
      resolve(buf.toString());
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

/**
 * Buffer variant of `readBody` that returns raw bytes. Use for binary payloads
 * like multipart/form-data uploads where `.toString()` would corrupt content.
 */
export function readBodyBuffer(
  req: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<Buffer> {
  // See `readBody()` above for
  // the rationale — when the eager drain inside `httpAuthGuard` has
  // already buffered the body, the underlying stream is exhausted
  // and we must resolve from the prebuffer instead of re-attaching
  // listeners. The signed-request HMAC check is still routed
  // through `enforceSignedRequestPostBody` so the post-body
  // invariant ("every body reader runs the verifier") is preserved
  // verbatim.
  const prebuffered = (req as IncomingMessage & {
    __dkgPrebufferedBody?: Buffer;
  }).__dkgPrebufferedBody;
  if (Buffer.isBuffer(prebuffered)) {
    if (prebuffered.length > maxBytes) {
      return Promise.reject(new PayloadTooLargeError(maxBytes));
    }
    try {
      enforceSignedRequestPostBody(req, prebuffered);
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.resolve(prebuffered);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    const onData = (c: Buffer) => {
      if (rejected) return;
      total += c.length;
      if (total > maxBytes) {
        rejected = true;
        req.removeListener("data", onData);
        req.resume();
        setTimeout(() => req.destroy(), 5_000);
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(c);
    };
    req.on("data", onData);
    req.on("end", () => {
      if (rejected) return;
      const buf = Buffer.concat(chunks);
      // See readBody() for the rationale — the signed-request post-body
      // check must run here too so multipart / binary routes cannot be
      // used to bypass the HMAC / body-binding check.
      try {
        enforceSignedRequestPostBody(req, buf);
      } catch (err) {
        reject(err);
        return;
      }
      resolve(buf);
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

// ─── CORS / rate-limit / validation helpers ───────────────────────────


export function buildCorsAllowlist(
  config: DkgConfig,
  boundPort: number,
): CorsAllowlist {
  const raw = config.corsOrigins;
  if (raw === "*") return "*";
  if (typeof raw === "string" && raw.trim().length > 0) return [raw.trim()];
  if (Array.isArray(raw)) {
    const origins = raw.filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    if (origins.length > 0) return origins;
  }
  // Default: derive from apiHost
  const host = config.apiHost ?? "127.0.0.1";
  if (host === "0.0.0.0") return "*"; // backward-compatible
  return [
    `http://127.0.0.1:${boundPort}`,
    `http://localhost:${boundPort}`,
    `http://[::1]:${boundPort}`,
  ];
}

export function resolveCorsOrigin(
  req: IncomingMessage,
  allowlist: CorsAllowlist,
): string | undefined {
  if (allowlist === "*") return "*";
  const origin = req.headers.origin;
  if (!origin) return undefined;
  return allowlist.includes(origin) ? origin : undefined;
}

export function corsHeaders(origin?: string | null): Record<string, string> {
  if (!origin) return {};
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  if (origin !== "*") headers["Vary"] = "Origin";
  return headers;
}

export class HttpRateLimiter {
  private _max: number;
  private _exempt: Set<string>;
  private _hits = new Map<string, { count: number; resetAt: number }>();
  private _timer: ReturnType<typeof setInterval>;

  constructor(requestsPerMinute: number, exemptPaths: string[] = []) {
    this._max = requestsPerMinute;
    this._exempt = new Set(exemptPaths);
    // Sweep expired buckets every 60s
    this._timer = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this._hits) {
        if (now >= bucket.resetAt) this._hits.delete(key);
      }
    }, 60_000);
    if (this._timer.unref) this._timer.unref();
  }

  isAllowed(ip: string, pathname: string): boolean {
    if (this._exempt.has(pathname)) return true;
    const now = Date.now();
    let bucket = this._hits.get(ip);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + 60_000 };
      this._hits.set(ip, bucket);
    }
    bucket.count += 1;
    return bucket.count <= this._max;
  }

  destroy(): void {
    clearInterval(this._timer);
    this._hits.clear();
  }
}

/**
 * Read-only view of {@link InFlightLimiter}'s admission-control counters. This
 * is what `/api/status` (and the plugin-facing `RequestContext`) consume, so
 * route/plugin code can read inFlight/max/rejectedTotal without gaining access
 * to the mutating `tryAcquire()`/`release()` and corrupting slot accounting.
 */
export interface AdmissionStatsView {
  /** Requests currently holding a slot. */
  readonly inFlight: number;
  /** Effective concurrency cap; 0 disables the limiter (always admits). */
  readonly max: number;
  /** Monotonic count of requests shed (503) since boot. */
  readonly rejectedTotal: number;
}

/**
 * Bounds the number of HTTP requests being processed concurrently by the
 * daemon, independent of client IP. This is admission control, not rate
 * limiting: the single-process daemon funnels every request onto one event
 * loop (and, on the embedded store backend, one Oxigraph worker thread), so a
 * burst of concurrent in-flight requests — including local/loopback traffic
 * that bypasses {@link HttpRateLimiter} — can pile pending work onto the heap
 * and stall the node. When the cap is reached, callers should shed load with a
 * 503 + Retry-After rather than queue unboundedly.
 *
 * `tryAcquire()` must be paired with exactly one `release()` in a `finally`.
 */
export class InFlightLimiter implements AdmissionStatsView {
  private _inFlight = 0;
  private _rejectedTotal = 0;
  private readonly _max: number;

  constructor(max: number) {
    // A non-positive cap disables the limiter (always admits).
    this._max = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  }

  get inFlight(): number {
    return this._inFlight;
  }

  get max(): number {
    return this._max;
  }

  /** Monotonic count of requests shed (tryAcquire returned false) — for metrics/logging. */
  get rejectedTotal(): number {
    return this._rejectedTotal;
  }

  /** Returns true and reserves a slot, or false if at capacity (shed load). */
  tryAcquire(): boolean {
    if (this._max > 0 && this._inFlight >= this._max) {
      this._rejectedTotal += 1;
      return false;
    }
    this._inFlight += 1;
    return true;
  }

  release(): void {
    if (this._inFlight > 0) this._inFlight -= 1;
  }
}

/**
 * Parse a base-10 integer from an env-style string. Returns null for
 * `undefined`, empty/whitespace, or any non-integer text — so malformed input
 * falls through to the next source instead of becoming `NaN`/`0`.
 */
function parseIntOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const t = value.trim();
  if (t === '' || !/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve an integer setting from an env var (highest precedence), then a
 * config value, then a fallback. Malformed / empty / NaN inputs are IGNORED
 * (fall through) rather than silently disabling the setting — a typo like
 * `DKG_MAX_INFLIGHT=abc` or an empty string yields the documented default, not
 * `NaN`/`0`.
 *
 * Pass `allowNonPositive` when `<= 0` is a meaningful value (e.g. "disable the
 * cap"): then ANY integer is accepted, so `0` or a negative flows through to
 * disable rather than falling back to the default. Without it the minimum
 * accepted value is 1. (Named for what it does — it admits negatives too, not
 * just zero.)
 */
export function resolveIntSetting(
  envValue: string | undefined,
  configValue: number | undefined,
  fallback: number,
  opts: { allowNonPositive?: boolean } = {},
): number {
  const accepts = (n: number | null | undefined): n is number =>
    typeof n === 'number' && Number.isInteger(n) && (opts.allowNonPositive === true || n >= 1);
  const fromEnv = parseIntOrNull(envValue);
  if (accepts(fromEnv)) return fromEnv;
  if (accepts(configValue)) return configValue;
  return fallback;
}

/** Minimal shape of the bits of `http.Server` that {@link applyServerLimits} sets. */
export interface ServerLimitsTarget {
  maxConnections: number;
  headersTimeout: number;
}

/**
 * Resolve and APPLY the socket-level limits to an HTTP server: `maxConnections`
 * (cap simultaneous sockets) and `headersTimeout` (kill slow-header
 * connections). `requestTimeout` is intentionally left at the Node default so
 * legitimately long publishes / SPARQL queries aren't truncated. Extracted from
 * the daemon so the resolution precedence AND the assignment are unit-testable.
 */
export function applyServerLimits(
  server: ServerLimitsTarget,
  opts: {
    maxConnectionsEnv?: string;
    maxConnectionsConfig?: number;
    headersTimeoutEnv?: string;
  },
): void {
  server.maxConnections = resolveIntSetting(opts.maxConnectionsEnv, opts.maxConnectionsConfig, 256);
  server.headersTimeout = resolveIntSetting(opts.headersTimeoutEnv, undefined, 60_000);
}

/**
 * Cheap GET/HEAD paths exempt from concurrency admission control — liveness /
 * health / manifest handlers that must stay answerable under load (monitoring,
 * `dkg status`, doctor, MCP setup probes), plus the long-lived `/api/events`
 * SSE stream (which must NOT hold an in-flight slot for the connection's whole
 * lifetime, or a few open dashboard tabs would exhaust the pool).
 *
 * NOTE: this is one of several HTTP path-category tables in the daemon (see
 * `auth.ts` public paths, `isLoopbackRateLimitExemptPath`, and the default
 * rate-limit exempt list in `lifecycle.ts`). Centralizing them behind one
 * source of truth is a worthwhile follow-up; kept local here for now.
 */
const ADMISSION_EXEMPT_GET_PATHS: ReadonlySet<string> = new Set([
  '/api/status',
  '/api/chain/rpc-health',
  '/api/events',
  '/.well-known/skill.md',
  '/.well-known/skill-importer.md',
]);

/**
 * Whether a request bypasses admission control. METHOD-AWARE on purpose: only
 * `OPTIONS` (CORS preflight, any path) and safe `GET`/`HEAD` reads of the cheap
 * liveness/doc/SSE paths bypass. A `POST`/`PUT`/etc. to those same paths is NOT
 * exempt — it falls through to the router/route-plugins and so must still take
 * a slot, otherwise a buggy/authenticated local client could run real work
 * outside the cap via e.g. `POST /api/status`.
 */
export function isAdmissionExempt(method: string | undefined, pathname: string): boolean {
  if (method === 'OPTIONS') return true;
  if ((method === 'GET' || method === 'HEAD') && ADMISSION_EXEMPT_GET_PATHS.has(pathname)) return true;
  return false;
}

/**
 * Apply concurrency admission control to one request. Exempt requests (see
 * {@link isAdmissionExempt}) always pass and take no slot. Otherwise a slot is
 * reserved; on capacity it writes `503` + `Retry-After` (with CORS headers so
 * browsers surface it) and returns `{ admitted: false }`.
 *
 * Ownership model: the slot is released automatically when the RESPONSE
 * completes (`res` `close`), NOT when the request handler returns — route
 * plugins and SSE can return with the response still streaming, and releasing
 * on handler return would free the slot mid-stream and let that work run
 * outside the cap. The release is registered here so callers cannot get it
 * wrong; they only need to honor `admitted`.
 */
export function admitRequest(
  limiter: InFlightLimiter,
  method: string | undefined,
  pathname: string,
  res: ServerResponse,
  corsOrigin: string | null,
): { admitted: boolean } {
  if (isAdmissionExempt(method, pathname)) {
    return { admitted: true };
  }
  if (!limiter.tryAcquire()) {
    res.writeHead(503, {
      'Content-Type': 'application/json',
      'Retry-After': '1',
      ...corsHeaders(corsOrigin),
    });
    res.end(JSON.stringify({ error: 'Server busy, retry shortly' }));
    return { admitted: false };
  }
  // Release exactly once, when the response completes (finish or abort).
  let released = false;
  res.once('close', () => {
    if (released) return;
    released = true;
    limiter.release();
  });
  return { admitted: true };
}

export function isLoopbackClientIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) {
    return normalized.slice('::ffff:'.length).startsWith('127.');
  }
  return normalized.startsWith('127.');
}

export function isLoopbackRateLimitExemptPath(pathname: string): boolean {
  return pathname === '/ui'
    || pathname.startsWith('/ui/')
    || pathname.startsWith('/api/')
    || pathname === '/.well-known/skill.md'
    || pathname === '/.well-known/skill-importer.md';
}

export function shouldBypassRateLimitForLoopbackTraffic(ip: string, pathname: string): boolean {
  return isLoopbackClientIp(ip) && isLoopbackRateLimitExemptPath(pathname);
}

export function isValidContextGraphId(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  if (id.length > 256) return false;
  // CLI-16 (
  // reject path-traversal patterns where it actually matters — i.e.
  // segments that the OS / URL resolver will interpret as the
  // parent / current directory. The character whitelist below
  // allows `.` and `/` because URNs / DIDs / URLs legitimately
  // contain version markers like `v1..2`, schema fragments like
  // `https://example.com/a..b`, etc.
  //
  // The earlier blanket `id.includes('..')` check broke those
  // legitimate identifiers without adding any defence-in-depth: a
  // segment-aware check is both stricter (still rejects every real
  // traversal) and tighter (does not produce false-positive 4xx
  // for valid context-graph IDs that happen to contain `..` inside
  // a single segment).
  for (const seg of id.split("/")) {
    if (seg === "." || seg === "..") return false;
  }
  // Allow URNs, DIDs, simple slug-like identifiers, and URIs
  return /^[\w:/.@\-]+$/.test(id);
}

/**
 * CLI-9 (
 * scrub raw chain-revert payloads from error messages before they
 * reach the HTTP body. Providers (ethers, viem, hardhat) serialise
 * the same revert data under multiple keys: `data="0x…"`, `data=0x…`,
 * `errorData="0x…"`, `errorData=0x…`, and JSON `"data":"0x…"`. The
 * matching set here mirrors `enrichEvmError()` in
 * `packages/chain/src/evm-adapter.ts` so any selector that survived
 * decoding still gets redacted before reaching the operator. Note
 * that we redact AFTER `enrichEvmError` has had a chance to splice
 * the decoded custom-error name in — so the operator still sees the
 * human-readable error, just without the raw selector blob.
 */
export function sanitizeRevertMessage(raw: string): string {
  return raw
    // Quoted variants (data / errorData with `=` or `:`).
    .replace(/((?:errorData|data)\s*[=:]\s*)"0x[0-9a-fA-F]+"/g, '$1"<redacted>"')
    // Unquoted variants (data / errorData with `=` or `:`).
    .replace(/((?:errorData|data)\s*[=:]\s*)0x[0-9a-fA-F]+/g, '$1<redacted>')
    // JSON-shape that ethers' provider error sometimes embeds:
    // `{"data":"0x…","message":"…"}`. The unquoted-data branch above
    // already covers `data:0x…` inside JSON, but JSON keeps quotes.
    .replace(/("data"\s*:\s*)"0x[0-9a-fA-F]+"/g, '$1"<redacted>"')
    .replace(/unknown custom error[^.\n]*\.?/gi, "request rejected by chain")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * CLI-7/9 helper: classify a thrown error as a "client mistake" (4xx)
 * vs an "infrastructure failure" (5xx). The vocabulary is conservative
 * — only well-known not-found / invalid-input / unreachable-peer
 * patterns map to 4xx; everything else stays 5xx so a real internal
 * problem still surfaces via the top-level catch.
 */
export function classifyClientError(
  msg: string,
):
  | { status: 404; sanitized: string }
  | { status: 403; sanitized: string }
  | { status: 400; sanitized: string }
  | { status: 504; sanitized: string }
  | null {
  const sanitized = sanitizeRevertMessage(msg);
  if (
    /\b(not found|does not exist|no such|unknown (policy|contextGraph|context.?graph|peer|verifiable.?memory)|peer is not connected|cannot resolve|no addresses)\b/i.test(
      msg,
    )
  ) {
    return { status: 404, sanitized };
  }
  // pre-fix, the same regex that
  // catches malformed peer-ids ALSO matched `timed out` / `unable to
  // dial`, which downgraded transient transport failures from a
  // retryable 504 to a client-side 400. The CLI / SDK then never
  // retried — even though the next dial attempt would have succeeded.
  // Split the classification so transport-layer transients map to
  // 504 (Gateway Timeout) and only true input-validation problems
  // stay on 400. Order matters: check the transient set first because
  // libp2p sometimes embeds the word "invalid" inside a dial-timeout
  // error string (`invalid response: timed out`) and we want such
  // hybrids classified as transient.
  if (
    /\b(timed? ?out|timeout|deadline (exceeded|expired)|unable to dial|could not dial|connection (refused|reset|closed)|aborted|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)\b/i.test(
      msg,
    )
  ) {
    return { status: 504, sanitized };
  }
  if (
    /\b(invalid (peer|peerId|multihash|base|batchId|verifiableMemoryId|contextGraphId|policyUri|contextGraphId)|could not parse|parse (peer|peerId)|peer (id|ID) (is not valid|invalid)|malformed|bad request|incorrect length)\b/i.test(
      msg,
    )
  ) {
    return { status: 400, sanitized };
  }
  // multiformats / @multiformats/multibase throws "Non-base58btc
  // character" / "Non-base32 character" / "Unknown base" when handed
  // a malformed peer-id / multihash / CID. These are unambiguous
  // client-side input errors — surfacing them as 500 misleads
  // operators into thinking the daemon itself is broken.
  if (/Non-base[0-9]+(btc|hex|z)? character|Unknown base|expected (base|prefix|multibase)/i.test(msg)) {
    return { status: 400, sanitized };
  }
  // Last-resort heuristic: libp2p / multiformats throws errors with
  // codes like ERR_INVALID_PEER_ID / ERR_INVALID_MULTIHASH that don't
  // include human-readable English. Match the canonical ERR_INVALID_*
  // shape so a fresh dependency-version upgrade doesn't silently
  // start returning 500 on what's plainly a malformed-input 400.
  if (/ERR_INVALID_(PEER|MULTIHASH|MULTIADDR|CID|BASE)/.test(msg)) {
    return { status: 400, sanitized };
  }
  if (
    /\b(not admitted|network identity proof rejected|NETWORK_ADMISSION_REJECTED)\b/i.test(msg)
  ) {
    return { status: 403, sanitized };
  }
  if (
    /\b(network identity probe failed|network admission probe failed|NETWORK_ADMISSION_PROBE_FAILED|protocol selection failed|could not negotiate)\b/i.test(msg) ||
    /not synchronously deliverable \(queued\)/i.test(msg)
  ) {
    return { status: 504, sanitized };
  }
  return null;
}

export function shortId(peerId: string): string {
  if (peerId.length > 16) return peerId.slice(0, 8) + "..." + peerId.slice(-4);
  return peerId;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function deriveBlockExplorerUrl(chainId?: string): string | undefined {
  if (!chainId) return undefined;
  const id = chainId.includes(":") ? chainId.split(":")[1] : chainId;
  switch (id) {
    case "84532":
      return "https://sepolia.basescan.org";
    case "8453":
      return "https://basescan.org";
    case "1":
      return "https://etherscan.io";
    case "11155111":
      return "https://sepolia.etherscan.io";
    default:
      return undefined;
  }
}
