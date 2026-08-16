// P2 route-wiring — the netting endpoints' testable core.
//
// Same architecture as infer-http-core.ts: every decision lives HERE,
// dependency-light and gate-testable; routes/metered-netting.ts is a thin
// adapter. Wiring principles carried from six adversarial review rounds:
//
//  1. TRUST DECISIONS STAY INSIDE THE EXPORTED MUTATIONS. commitClose verifies
//     the buyer countersignature + countersigner keyRef binding itself (P2 v7);
//     these routes add transport plumbing only and CANNOT bypass it.
//  2. ECONOMICS INPUTS ARE NEVER CALLER-SUPPLIED. The settle-gate reads the
//     recorded fee/rate from server-side config (netting-economics.json,
//     canonical decimal strings + provenance note). A caller-supplied fee or
//     rate could manipulate the threshold, so such params are REFUSED, not
//     ignored — a request that tries is told so.
//  3. recordEarnedRelease IS NOT ROUTED HERE AT ALL. It is provider-side
//     bookkeeping bound to confirmed payout evidence, driven by the settlement
//     scripts on loopback — deliberately absent from this surface exactly as
//     the withdrawal routes are absent from the provider front.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  ledgerQuantities, conservationCheck, commitClose, applyRollover,
  providerMaySettle, decToRational, type CloseCommit,
} from "./netting.js";

export interface NettingIo {
  json(status: number, body: unknown): void;
  readBody(): Promise<string>;
}
export interface NettingRequest {
  method: string;
  path: string;
  home: string;
  /** raw query string ("?a=b") for the read-only endpoints. */
  query?: string;
}

/** Recorded economics inputs — provenance-carrying, operator-maintained. */
export interface NettingEconomics {
  feeGweiDecimal: string;      // canonical decimal string (frozen grammar)
  ethTracDecimal: string;      // canonical decimal string (frozen grammar)
  recordedAt: string;          // ISO timestamp the sample was taken
  source: string;              // where fee/rate were sampled (recorded beside, per cost contract)
}
export function loadNettingEconomics(home: string): (NettingEconomics & { configDigest: string }) | null {
  const p = join(home, "metering", "netting-economics.json");
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8");
    const cfg = JSON.parse(raw);
    // validate through the FROZEN grammar — a malformed recorded input fails
    // closed here rather than deep in the threshold math.
    decToRational(String(cfg.feeGweiDecimal));
    decToRational(String(cfg.ethTracDecimal));
    // provenance SCHEMA, not truthiness (review, Hermes wiring #3): recordedAt
    // must parse as a real timestamp; source must be a non-empty string.
    if (typeof cfg.recordedAt !== "string" || Number.isNaN(Date.parse(cfg.recordedAt))) return null;
    if (typeof cfg.source !== "string" || cfg.source.trim().length === 0) return null;
    // TOCTOU binding: the gate result carries the digest of the EXACT config
    // bytes it used, so the settlement that later acts on the verdict can bind
    // to (and audit) the same economics — a read-to-execution config swap is
    // detectable, not silent.
    const configDigest = "sha256:" + createHash("sha256").update(raw).digest("hex");
    return {
      feeGweiDecimal: String(cfg.feeGweiDecimal), ethTracDecimal: String(cfg.ethTracDecimal),
      recordedAt: String(cfg.recordedAt), source: String(cfg.source), configDigest,
    };
  } catch { return null; }
}

/** Resolve a principal to the JOURNAL's recorded form (review, Hermes wiring
 *  #2): the ledger keys tabs by exact string, so a case-variant would open a
 *  SPLIT tab. All four routes resolve case-insensitively to the form the
 *  journal already uses (first record wins); an unknown principal passes
 *  through as given (first writer defines the form). */
export function resolvePrincipal(home: string, input: string): string | null {
  const want = input.toLowerCase();
  const forms = new Set<string>();
  for (const r of readJournalSafe(home)) {
    const p = String((r as Record<string, unknown>).principal ?? "");
    if (p && p.toLowerCase() === want) forms.add(p);
  }
  // FAIL CLOSED on an already-split ledger (review, Hermes wiring v2 #3):
  // "first record wins" would silently pick one side of the split — instead the
  // ambiguity surfaces for operator repair.
  if (forms.size > 1) return null;
  return forms.size === 1 ? [...forms][0] : input;
}
function readJournalSafe(home: string): Array<Record<string, unknown>> {
  try {
    const p = join(home, "metering", "read-journal.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  } catch { return []; }
}

/** Strict non-coercive protocol integer (review, Hermes wiring #1): the JSON
 *  value must BE a number — strings, booleans, arrays are refused, never
 *  coerced — non-negative, safe, and within the protocol range. */
const MAX_EPOCH = 4_294_967_295;              // 2^32 − 1
const MAX_MICRO_TRAC = 1_000_000_000_000_000; // 1e15 µTRAC = 1e9 TRAC — far above any real tab
export function protoInt(v: unknown, max: number): number | null {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > max) return null;
  return v;
}

const q = (query: string | undefined, key: string) => new URL("http://x" + (query ?? "")).searchParams.get(key);
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** Returns true when the request was a netting route request. */
export async function handleNetting(req: NettingRequest, io: NettingIo): Promise<boolean> {
  // ── GET /api/metering/netting/quantities?principal= — read-only transparency:
  //    the frozen ledger quantities + the live I1 conservation verdict, so a
  //    buyer (or reviewer) can check the identity against its own copy.
  if (req.path === "/api/metering/netting/quantities") {
    if (req.method !== "GET") { io.json(405, { error: "E_METHOD" }); return true; }
    const principal = q(req.query, "principal");
    if (!principal || !ADDR.test(principal)) { io.json(400, { error: "E_MISSING_FIELD", required: ["principal"] }); return true; }
    const rp = resolvePrincipal(req.home, principal);
    if (rp === null) { io.json(409, { error: "E_PRINCIPAL_AMBIGUOUS", detail: "journal holds multiple case-forms of this address — operator repair required" }); return true; }
    const c = conservationCheck(req.home, rp);
    io.json(200, { quantities: c.q, conservation: { ok: c.ok, lhs: c.lhs, rhs: c.rhs } });
    return true;
  }

  // ── GET /api/metering/netting/settle-gate?principal= — the provider-election
  //    threshold verdict from RECORDED economics. Caller-supplied fee/rate are
  //    REFUSED (wiring principle 2).
  if (req.path === "/api/metering/netting/settle-gate") {
    if (req.method !== "GET") { io.json(405, { error: "E_METHOD" }); return true; }
    const sp = new URL("http://x" + (req.query ?? "")).searchParams;
    for (const k of sp.keys()) if (k !== "principal") { io.json(400, { error: "E_CALLER_ECONOMICS_REFUSED", detail: `unexpected parameter '${k}' — fee/rate come from the recorded server config, never the caller` }); return true; }
    const principal = sp.get("principal");
    if (!principal || !ADDR.test(principal)) { io.json(400, { error: "E_MISSING_FIELD", required: ["principal"] }); return true; }
    const econ = loadNettingEconomics(req.home);
    if (!econ) { io.json(503, { error: "E_NO_RECORDED_ECONOMICS", detail: "netting-economics.json absent or invalid — the settle gate fails closed without recorded inputs" }); return true; }
    const rp2 = resolvePrincipal(req.home, principal);
    if (rp2 === null) { io.json(409, { error: "E_PRINCIPAL_AMBIGUOUS" }); return true; }
    const g = providerMaySettle(req.home, rp2, econ.feeGweiDecimal, econ.ethTracDecimal);
    io.json(200, { ...g, economics: econ });
    return true;
  }

  // ── POST /api/metering/close/commit — the buyer's countersigned close.
  //    ALL verification (Ed25519 over the domain-separated body, countersigner
  //    keyRef binding, figure checks, epoch CAS) happens inside commitClose.
  if (req.path === "/api/metering/close/commit") {
    if (req.method !== "POST") { io.json(405, { error: "E_METHOD" }); return true; }
    let body: Record<string, unknown>;
    try { body = JSON.parse((await io.readBody()) || "{}"); } catch { io.json(400, { error: "E_BAD_JSON" }); return true; }
    const required = ["principal", "epoch", "mode", "earnedMicroTrac", "carryMicroTrac", "buyerCountersignature", "sessionPublicKeyPem"];
    const missing = required.filter((k) => body[k] === undefined || body[k] === null);
    if (missing.length) { io.json(400, { error: "E_MISSING_FIELD", required: missing }); return true; }
    if (typeof body.principal !== "string" || !ADDR.test(body.principal)) { io.json(400, { error: "E_BAD_FIELD", detail: "principal" }); return true; }
    if (body.mode !== "rollover" && body.mode !== "settle") { io.json(400, { error: "E_BAD_FIELD", detail: "mode must be rollover|settle" }); return true; }
    // STRICT, non-coercive numeric validation (Hermes wiring #1): values must
    // BE numbers within protocol range — "0", " ", false, [] are refused.
    const epoch = protoInt(body.epoch, MAX_EPOCH);
    const earned = protoInt(body.earnedMicroTrac, MAX_MICRO_TRAC);
    const carry = protoInt(body.carryMicroTrac, MAX_MICRO_TRAC);
    if (epoch === null || earned === null || carry === null) {
      io.json(400, { error: "E_BAD_FIELD", detail: "epoch/earnedMicroTrac/carryMicroTrac must be non-negative protocol-range JSON numbers (no coercion)" }); return true;
    }
    if (typeof body.buyerCountersignature !== "string" || typeof body.sessionPublicKeyPem !== "string") {
      io.json(400, { error: "E_BAD_FIELD", detail: "buyerCountersignature/sessionPublicKeyPem must be strings" }); return true;
    }
    const rp3 = resolvePrincipal(req.home, body.principal);
    if (rp3 === null) { io.json(409, { error: "E_PRINCIPAL_AMBIGUOUS" }); return true; }
    const commit: CloseCommit = {
      principal: rp3, epoch,
      mode: body.mode as "rollover" | "settle",
      earnedMicroTrac: earned, carryMicroTrac: carry,
      buyerCountersignature: body.buyerCountersignature,
      sessionPublicKeyPem: body.sessionPublicKeyPem,
    };
    const r = commitClose(req.home, commit);
    io.json(r.ok ? 200 : 409, r);
    return true;
  }

  // ── POST /api/metering/close/rollover — apply a committed rollover close's
  //    carry. Idempotent (close-digest dedup) and value-conserving; safe for
  //    either seat to trigger.
  if (req.path === "/api/metering/close/rollover") {
    if (req.method !== "POST") { io.json(405, { error: "E_METHOD" }); return true; }
    let body: Record<string, unknown>;
    try { body = JSON.parse((await io.readBody()) || "{}"); } catch { io.json(400, { error: "E_BAD_JSON" }); return true; }
    if (typeof body.principal !== "string" || !ADDR.test(body.principal) || typeof body.closeDigest !== "string" || !body.closeDigest) {
      io.json(400, { error: "E_MISSING_FIELD", required: ["principal", "closeDigest"] }); return true;
    }
    const rp4 = resolvePrincipal(req.home, body.principal);
    if (rp4 === null) { io.json(409, { error: "E_PRINCIPAL_AMBIGUOUS" }); return true; }
    const r = applyRollover(req.home, rp4, body.closeDigest);
    io.json(r.ok ? 200 : 409, r);
    return true;
  }

  return false;
}
