// Gate I0 — the wiring-config parser, as its own PURE module.
//
// Split out after Bo's I0 block (event fe9485f0): the first parser lived inline
// in the adapter, which (a) meant his clean-room verifier could not execute it —
// the adapter drags in the daemon http-utils graph — and (b) contained four
// fail-open defects he found by reading it:
//
//   * Math.min(Number("bogus"), 16) is NaN, and `inFlight >= NaN` is always
//     false — a garbage maxConcurrent silently DISABLED the concurrency cap
//     while the backend reported itself configured;
//   * timeoutMs accepted non-finite/fractional/zero/negative values into
//     runtime behaviour instead of rejecting the config;
//   * the loopback regex was not anchored: "http://localhost.evil" passed
//     config-time validation (the per-request check stopped the SSRF, but the
//     config was wrongly marked configured, and hostname string "localhost" is
//     not a resolved-address loopback proof anyway);
//   * the digest check was startsWith("sha256:"), so "sha256:x" passed as a
//     content-addressed pin.
//
// Rules, all fail-CLOSED — an invalid value present in the file is a rejection,
// never a default:
//   * baseUrl: parsed with new URL(); http: only; hostname EXACTLY the literal
//     "127.0.0.1" (no "localhost" — a name is a resolver's opinion, an address
//     is not); no credentials, query, fragment, or path; optional port.
//   * modelId: non-empty string.
//   * specialTokenIdRanges: non-empty array of [a,b] integer pairs, a<=b, span
//     and total bounded.
//   * expectedTokenizerBundleDigest: exactly sha256: + 64 lowercase hex.
//   * timeoutMs / maxConcurrent: FINITE INTEGERS within explicit bounds;
//     defaults apply only when the key is ABSENT.
//   * unknown keys are rejected — a typo'd key is a config the operator did not
//     mean, and guessing at intent is how caps get silently dropped.
//
// This module imports nothing beyond the language, so it bundles standalone and
// the audit bundle's verifier RUNS its gates rather than reading them.

export interface WiredBackendConfig {
  baseUrl: string;
  modelId: string;
  specialTokenIds: number[];
  expectedTokenizerBundleDigest: string;
  timeoutMs: number;
  maxConcurrent: number;
}

export type ParseOutcome =
  | { ok: true; cfg: WiredBackendConfig }
  | { ok: false; reason: string };

export const WIRING_LIMITS = Object.freeze({
  timeoutMsMin: 1_000,
  timeoutMsMax: 600_000,
  timeoutMsDefault: 120_000,
  maxConcurrentMin: 1,
  maxConcurrentMax: 16,
  maxConcurrentDefault: 2,
  maxRangeSpan: 10_000,
  maxSpecialTokens: 20_000,
});

const KNOWN_KEYS = new Set([
  "baseUrl", "modelId", "specialTokenIdRanges", "expectedTokenizerBundleDigest",
  "timeoutMs", "maxConcurrent",
]);

/** A finite integer within [min, max] — or a rejection. NaN never leaks. */
function boundedInt(value: unknown, name: string, min: number, max: number, absentDefault: number): { ok: true; n: number } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, n: absentDefault };
  const n = typeof value === "number" ? value : NaN;   // "120000" the string is NOT a number the operator typed as one
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, reason: `${name} must be a finite integer, got ${JSON.stringify(value)}` };
  if (n < min || n > max) return { ok: false, reason: `${name} ${n} outside [${min}, ${max}]` };
  return { ok: true, n };
}

export function parseInferenceBackendConfig(raw: unknown): ParseOutcome {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "config must be a JSON object" };
  }
  const cfg = raw as Record<string, unknown>;

  for (const k of Object.keys(cfg)) {
    if (!KNOWN_KEYS.has(k)) return { ok: false, reason: `unknown key "${k}" — refusing to guess intent` };
  }

  // ── baseUrl: URL-parsed, literal-loopback, nothing else riding along ──
  if (typeof cfg.baseUrl !== "string") return { ok: false, reason: "baseUrl must be a string" };
  let u: URL;
  try { u = new URL(cfg.baseUrl); } catch { return { ok: false, reason: "baseUrl is not a parseable URL" }; }
  if (u.protocol !== "http:") return { ok: false, reason: `baseUrl protocol must be http:, got ${u.protocol}` };
  if (u.hostname !== "127.0.0.1") return { ok: false, reason: `baseUrl host must be the literal 127.0.0.1, got "${u.hostname}"` };
  if (u.username || u.password) return { ok: false, reason: "baseUrl must not carry credentials" };
  if (u.search || u.hash) return { ok: false, reason: "baseUrl must not carry a query or fragment" };
  if (u.pathname !== "/" && u.pathname !== "") return { ok: false, reason: `baseUrl must not carry a path, got "${u.pathname}"` };

  // ── modelId ──
  if (typeof cfg.modelId !== "string" || cfg.modelId.length === 0) {
    return { ok: false, reason: "modelId required (non-empty string)" };
  }

  // ── special-token ranges ──
  const ranges = cfg.specialTokenIdRanges;
  if (!Array.isArray(ranges) || ranges.length === 0) {
    return { ok: false, reason: "specialTokenIdRanges required — an empty special set would bill control tokens" };
  }
  const specialTokenIds: number[] = [];
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length !== 2) return { ok: false, reason: "each specialTokenIdRange must be [from, to]" };
    const [a, b] = r as [unknown, unknown];
    if (typeof a !== "number" || typeof b !== "number" || !Number.isInteger(a) || !Number.isInteger(b)) {
      return { ok: false, reason: "specialTokenIdRanges must hold integers" };
    }
    if (a < 0 || b < a) return { ok: false, reason: `bad range [${a}, ${b}]` };
    if (b - a > WIRING_LIMITS.maxRangeSpan) return { ok: false, reason: `range [${a}, ${b}] wider than ${WIRING_LIMITS.maxRangeSpan}` };
    for (let id = a; id <= b; id++) specialTokenIds.push(id);
    if (specialTokenIds.length > WIRING_LIMITS.maxSpecialTokens) {
      return { ok: false, reason: `more than ${WIRING_LIMITS.maxSpecialTokens} special tokens` };
    }
  }

  // ── the bundle pin: exactly sha256: + 64 lowercase hex ──
  const digest = cfg.expectedTokenizerBundleDigest;
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    return { ok: false, reason: "expectedTokenizerBundleDigest must be exactly sha256:<64 lowercase hex>" };
  }

  // ── numeric bounds: NaN and friends are rejections, never defaults ──
  const t = boundedInt(cfg.timeoutMs, "timeoutMs", WIRING_LIMITS.timeoutMsMin, WIRING_LIMITS.timeoutMsMax, WIRING_LIMITS.timeoutMsDefault);
  if (!t.ok) return t;
  const m = boundedInt(cfg.maxConcurrent, "maxConcurrent", WIRING_LIMITS.maxConcurrentMin, WIRING_LIMITS.maxConcurrentMax, WIRING_LIMITS.maxConcurrentDefault);
  if (!m.ok) return m;

  return {
    ok: true,
    cfg: {
      baseUrl: `http://127.0.0.1${u.port ? `:${u.port}` : ""}`,   // normalized: nothing survives but scheme, literal host, port
      modelId: cfg.modelId,
      specialTokenIds,
      expectedTokenizerBundleDigest: digest,
      timeoutMs: t.n,
      maxConcurrent: m.n,
    },
  };
}
