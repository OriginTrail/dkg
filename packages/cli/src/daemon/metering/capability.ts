// V2-B2a — capability authentication (ratified D14, as amended by the
// round-1 red-team from Blackbox / Hermes / OpenClaw).
//
// THE CENTRAL RULE: containment is enforced at SETTLEMENT, not by the serving
// node's goodwill. A serving node can always *claim* work; what it cannot do
// is make that claim settle. Every check below exists to bound what a stolen
// capability plus a colluding node can extract.
//
//  (a) receipts without a requester countersignature (or a bounded signed
//      pre-authorization) over the request/quote/receipt digest are
//      INADMISSIBLE for settlement — enforced in `admissibleForSettlement`;
//  (b) the capability binds audience (settlement + node-class allowlist),
//      route/method, schedule + price digests (else a colluding node converts
//      stolen auth into "valid" overpriced fake work), unique capability id,
//      agent URN, absolute expiry, and absolute + rolling-velocity caps;
//  (c) ONE atomic monotonic sequence spans both metered paths (read and
//      inference), which kills concurrent cross-path replay;
//  (d) revocation is monotonic and FAIL-CLOSED on stale journal state: a node
//      must prove it observed a revocation checkpoint no older than
//      `maxCheckpointAgeMs` for its receipts to settle;
//  (e) the session signing key is never embedded in the bearer; bearer-only
//      clients are a lower-trust tier with tighter caps and shorter TTL.
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { canonicalize } from "./ledger.js";

export const CAPABILITY_DOMAIN = "odysseus-dkg:capability:v1";
export const DELEGATION_DOMAIN = "odysseus-dkg:delegation:v1";

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

export type TrustTier = "session-key" | "bearer-only";

/** What the wallet signs. The wallet key never leaves the operator/consumer. */
export interface Delegation {
  domain: typeof DELEGATION_DOMAIN;
  capabilityId: string;          // unique; replay anchor
  tabPrincipal: string;          // the depositing wallet = tab identity
  sessionPublicKeyPem: string;   // (e) never the signing key itself
  agentUrn: string;
  audience: {
    settlement: string;          // settlement authority id
    nodeClasses: string[];       // (b) allowlist, not a single node: avoids
                                 // availability/routing friction (OpenClaw)
  };
  routes: string[];              // e.g. ["POST /api/query", "POST /v1/metered"]
  bindings: {
    scheduleDigest: string;      // (b) stolen auth cannot be repriced
    priceVectorDigest: string;
  };
  caps: {
    absoluteMicroTrac: number;   // total spend ceiling
    windowMicroTrac: number;     // rolling-velocity ceiling
    windowMs: number;
  };
  notBefore: string;             // ISO
  expiresAt: string;             // ISO — short by policy
  tier: TrustTier;
}

export interface SignedDelegation extends Delegation {
  walletSignature: string;       // base64, over CAPABILITY preimage
}

export interface CapabilityState {
  spentMicroTrac: number;
  window: { since: number; spentMicroTrac: number };
  sequence: number;              // (c) ONE sequence across BOTH paths
  revoked: boolean;
}

export function delegationPreimage(d: Delegation | SignedDelegation): Buffer {
  const unsigned = { ...(d as unknown as Record<string, unknown>) };
  delete unsigned.walletSignature;
  return Buffer.concat([Buffer.from(DELEGATION_DOMAIN + "\n"), Buffer.from(canonicalize(unsigned))]);
}

export type VerdictCode =
  | "OK"
  | "E_CAP_EXPIRED"
  | "E_CAP_NOT_YET_VALID"
  | "E_CAP_REVOKED"
  | "E_CAP_BAD_SIGNATURE"
  | "E_CAP_WRONG_AUDIENCE"
  | "E_CAP_WRONG_ROUTE"
  | "E_CAP_SCHEDULE_MISMATCH"
  | "E_CAP_PRICE_MISMATCH"
  | "E_CAP_ABSOLUTE_CAP"
  | "E_CAP_VELOCITY_CAP"
  | "E_CAP_SEQUENCE_REPLAY"
  | "E_CAP_STALE_REVOCATION_STATE"
  | "E_SETTLE_NO_COUNTERSIGNATURE";

export interface VerifyArgs {
  delegation: SignedDelegation;
  walletPublicKeyPem: string;
  state: CapabilityState;
  now: number;
  request: {
    route: string;
    nodeClass: string;
    settlementId: string;
    scheduleDigest: string;
    priceVectorDigest: string;
    sequence: number;            // (c) client-asserted, must be monotonic
    estimatedMicroTrac: number;
  };
  revocationCheckpoint: { observedAt: number | null; maxCheckpointAgeMs: number };
}

/** Fail-closed capability verification. Returns the FIRST failing code. */
export function verifyCapability(a: VerifyArgs): { ok: boolean; code: VerdictCode } {
  const d = a.delegation;
  const fail = (code: VerdictCode) => ({ ok: false, code });

  // (d) fail closed when we cannot prove revocation freshness
  const { observedAt, maxCheckpointAgeMs } = a.revocationCheckpoint;
  if (observedAt === null || a.now - observedAt > maxCheckpointAgeMs) return fail("E_CAP_STALE_REVOCATION_STATE");
  if (a.state.revoked) return fail("E_CAP_REVOKED");

  try {
    const ok = edVerify(null, delegationPreimage(d), createPublicKey(a.walletPublicKeyPem), Buffer.from(d.walletSignature, "base64"));
    if (!ok) return fail("E_CAP_BAD_SIGNATURE");
  } catch { return fail("E_CAP_BAD_SIGNATURE"); }

  if (a.now < Date.parse(d.notBefore)) return fail("E_CAP_NOT_YET_VALID");
  if (a.now > Date.parse(d.expiresAt)) return fail("E_CAP_EXPIRED");

  if (d.audience.settlement !== a.request.settlementId) return fail("E_CAP_WRONG_AUDIENCE");
  if (!d.audience.nodeClasses.includes(a.request.nodeClass)) return fail("E_CAP_WRONG_AUDIENCE");
  if (!d.routes.includes(a.request.route)) return fail("E_CAP_WRONG_ROUTE");

  if (d.bindings.scheduleDigest !== a.request.scheduleDigest) return fail("E_CAP_SCHEDULE_MISMATCH");
  if (d.bindings.priceVectorDigest !== a.request.priceVectorDigest) return fail("E_CAP_PRICE_MISMATCH");

  // (c) one monotonic sequence across BOTH metered paths
  if (a.request.sequence !== a.state.sequence + 1) return fail("E_CAP_SEQUENCE_REPLAY");

  const est = Math.max(0, a.request.estimatedMicroTrac);
  if (a.state.spentMicroTrac + est > d.caps.absoluteMicroTrac) return fail("E_CAP_ABSOLUTE_CAP");
  const inWindow = a.now - a.state.window.since < d.caps.windowMs ? a.state.window.spentMicroTrac : 0;
  if (inWindow + est > d.caps.windowMicroTrac) return fail("E_CAP_VELOCITY_CAP");

  return { ok: true, code: "OK" };
}

/** Advance capability state after a successful, priced request. */
export function chargeCapability(state: CapabilityState, now: number, windowMs: number, micro: number): CapabilityState {
  const fresh = now - state.window.since >= windowMs;
  return {
    ...state,
    spentMicroTrac: state.spentMicroTrac + micro,
    sequence: state.sequence + 1,
    window: fresh ? { since: now, spentMicroTrac: micro } : { since: state.window.since, spentMicroTrac: state.window.spentMicroTrac + micro },
  };
}

/**
 * (a) SETTLEMENT ADMISSIBILITY — the rule that makes node collusion bounded.
 * A leg settles only if the requester's session key countersigned the exact
 * receipt digest (or a bounded pre-authorization covers it).
 */
export function admissibleForSettlement(args: {
  leg: Record<string, any>;
  sessionPublicKeyPem: string;
  countersignature?: string;
  preAuthorization?: { maxMicroTrac: number; signature: string; expiresAt: string };
  now: number;
}): { ok: boolean; code: VerdictCode } {
  const digest = "sha256:" + sha256(canonicalize(args.leg));
  if (args.countersignature) {
    try {
      const ok = edVerify(
        null,
        Buffer.concat([Buffer.from(CAPABILITY_DOMAIN + "\n"), Buffer.from(digest)]),
        createPublicKey(args.sessionPublicKeyPem),
        Buffer.from(args.countersignature, "base64"),
      );
      if (ok) return { ok: true, code: "OK" };
    } catch { /* fall through */ }
    return { ok: false, code: "E_SETTLE_NO_COUNTERSIGNATURE" };
  }
  const pre = args.preAuthorization;
  if (pre && args.now <= Date.parse(pre.expiresAt) && (args.leg.pricing?.costMicroTrac ?? Infinity) <= pre.maxMicroTrac) {
    try {
      const ok = edVerify(
        null,
        Buffer.concat([Buffer.from(CAPABILITY_DOMAIN + "\n"), Buffer.from(canonicalize({ maxMicroTrac: pre.maxMicroTrac, expiresAt: pre.expiresAt }))]),
        createPublicKey(args.sessionPublicKeyPem),
        Buffer.from(pre.signature, "base64"),
      );
      if (ok) return { ok: true, code: "OK" };
    } catch { /* fall through */ }
  }
  return { ok: false, code: "E_SETTLE_NO_COUNTERSIGNATURE" };
}

/**
 * OpenClaw's requirement: a ZERO-VALUE handshake preflight, so revocation and
 * freshness failure modes are exercised before any funded tab exists. Runs the
 * full verification path with estimatedMicroTrac = 0 and never touches a ledger.
 */
export function zeroValuePreflight(a: Omit<VerifyArgs, "request"> & { request: Omit<VerifyArgs["request"], "estimatedMicroTrac"> }) {
  return verifyCapability({ ...a, request: { ...a.request, estimatedMicroTrac: 0 } });
}
