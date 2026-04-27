// HTTP request/response utilities extracted from the legacy monolithic
// `daemon.ts`. Body parsing, JSON validators, CORS resolution, the
// loopback rate-limiter, plus small helpers used across route handlers.
// Pure helpers; the rate-limiter class is the only stateful piece and
// is instantiated per-daemon-boot by `runDaemonInner`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PayloadTooLargeError,
  validateContextGraphId,
  validateSubGraphName,
  isSafeIri,
} from '@origintrail-official/dkg-core';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { DkgConfig } from '../config.js';
import { enforceSignedRequestPostBody } from '../auth.js';

// Co-located here because the body parser is their only semantic
// consumer; moving them to `./types.ts` would just add an import
// cycle with no real benefit.
export interface PublishQuad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

export type PublishAccessPolicy = 'public' | 'ownerOnly' | 'allowList';

export interface PublishRequestBody {
  paranetId: string;
  quads: PublishQuad[];
  privateQuads?: PublishQuad[];
  accessPolicy?: PublishAccessPolicy;
  allowedPeers?: string[];
  subGraphName?: string;
}

import type { CorsAllowlist } from './state.js';

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

export function isPublishQuad(value: unknown): value is PublishQuad {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.subject === "string" &&
    typeof v.predicate === "string" &&
    typeof v.object === "string" &&
    typeof v.graph === "string"
  );
}

export function parsePublishRequestBody(
  body: string,
): { ok: true; value: PublishRequestBody } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Body must be a JSON object" };
  }

  const payload = parsed as Record<string, unknown>;
  const { quads, privateQuads, accessPolicy, allowedPeers, subGraphName } =
    payload;
  const paranetId = (payload.contextGraphId ?? payload.paranetId) as unknown;

  if (typeof paranetId !== "string" || paranetId.trim().length === 0) {
    return {
      ok: false,
      error: 'Missing or invalid "contextGraphId" (or legacy "paranetId")',
    };
  }

  if (
    !Array.isArray(quads) ||
    quads.length === 0 ||
    !quads.every(isPublishQuad)
  ) {
    return {
      ok: false,
      error: 'Missing or invalid "quads" (must be a non-empty quad array)',
    };
  }

  if (
    privateQuads !== undefined &&
    (!Array.isArray(privateQuads) || !privateQuads.every(isPublishQuad))
  ) {
    return {
      ok: false,
      error: 'Invalid "privateQuads" (must be a quad array)',
    };
  }

  if (
    accessPolicy !== undefined &&
    accessPolicy !== "public" &&
    accessPolicy !== "ownerOnly" &&
    accessPolicy !== "allowList"
  ) {
    return {
      ok: false,
      error: 'Invalid "accessPolicy" (must be public, ownerOnly, or allowList)',
    };
  }

  if (
    allowedPeers !== undefined &&
    (!Array.isArray(allowedPeers) ||
      !allowedPeers.every((p) => typeof p === "string" && p.trim().length > 0))
  ) {
    return {
      ok: false,
      error: 'Invalid "allowedPeers" (must be an array of non-empty strings)',
    };
  }

  if (
    accessPolicy === "allowList" &&
    (!allowedPeers || allowedPeers.length === 0)
  ) {
    return {
      ok: false,
      error: '"allowList" accessPolicy requires non-empty "allowedPeers"',
    };
  }

  if (accessPolicy !== "allowList" && allowedPeers && allowedPeers.length > 0) {
    return {
      ok: false,
      error: '"allowedPeers" is only valid when "accessPolicy" is "allowList"',
    };
  }

  if (subGraphName !== undefined) {
    if (typeof subGraphName !== "string" || subGraphName.trim().length === 0) {
      return {
        ok: false,
        error: 'Invalid "subGraphName" (must be a non-empty string)',
      };
    }
    const sgValidation = validateSubGraphName(subGraphName);
    if (!sgValidation.valid) {
      return {
        ok: false,
        error: `Invalid "subGraphName": ${sgValidation.reason}`,
      };
    }
  }

  return {
    ok: true,
    value: {
      paranetId,
      quads,
      privateQuads,
      accessPolicy,
      allowedPeers,
      subGraphName: subGraphName as string | undefined,
    },
  };
}

/**
 * PR #229 CodeQL js/stack-trace-exposure: route handlers across the
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
    // Absolute POSIX path with :line:col (with or without surrounding
    // parens). Matches `/Users/.../foo.ts:12:34` and `/usr/...:1:1`.
    .replace(/\(?\/(?:[^\s()]+\/)+[^\s()]+\.(?:js|ts|cjs|mjs|jsx|tsx)(?::\d+)?(?::\d+)?\)?/g, '<redacted-path>')
    // Windows-style absolute path with :line:col (defence-in-depth even
    // though the daemon doesn't run on Windows in CI).
    .replace(/\(?[A-Za-z]:[\\/](?:[^\s()]+[\\/])+[^\s()]+\.(?:js|ts|cjs|mjs|jsx|tsx)(?::\d+)?(?::\d+)?\)?/g, '<redacted-path>');
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
): void {
  const origin =
    corsOrigin !== undefined
      ? corsOrigin
      : (((res as any).__corsOrigin as string | null) ?? null);
  const scrubbed = scrubResponseBody(data);
  const body = JSON.stringify(scrubbed, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsHeaders(origin),
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
        '"conditions" must be a non-empty array (use /api/shared-memory/write for unconditional writes)',
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
      // PR #229 F2 follow-up (bot review): enforce the post-body
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
    || pathname === '/.well-known/skill.md';
}

export function shouldBypassRateLimitForLoopbackTraffic(ip: string, pathname: string): boolean {
  return isLoopbackClientIp(ip) && isLoopbackRateLimitExemptPath(pathname);
}

export function isValidContextGraphId(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  if (id.length > 256) return false;
  // CLI-16 (BUGS_FOUND.md dup #87) + PR #229 r3146360283 follow-up:
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
 * CLI-9 (BUGS_FOUND.md dup #159) + PR #229 r3146360288 follow-up:
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
  | { status: 400; sanitized: string }
  | { status: 504; sanitized: string }
  | null {
  const sanitized = sanitizeRevertMessage(msg);
  if (
    /\b(not found|does not exist|no such|unknown (policy|paranet|context.?graph|peer|verified.?memory)|peer is not connected|cannot resolve|no addresses)\b/i.test(
      msg,
    )
  ) {
    return { status: 404, sanitized };
  }
  // PR #229 bot review (daemon.ts:1952): pre-fix, the same regex that
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
    /\b(invalid (peer|peerId|multihash|base|batchId|verifiedMemoryId|contextGraphId|policyUri|paranetId)|could not parse|parse (peer|peerId)|peer (id|ID) (is not valid|invalid)|malformed|bad request|incorrect length)\b/i.test(
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
