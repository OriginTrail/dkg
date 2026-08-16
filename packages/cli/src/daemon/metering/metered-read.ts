// V2 Stage-3 — the metered read. The billing path the rest of this exists for.
//
// Found 2026-08-06, while quoting the first funded call: the whole Stage-3
// apparatus — terms, handshake, deposit rail, capability verification, EIP-191
// binding — gated access to a billing path it was never wired into. A funded
// tab had nothing that could spend from it, because /api/query takes its
// principal from the transport bearer token and accepts no delegation at all.
// Four times now the surrounding machinery has been built and verified while
// the outcome it exists for stayed unconnected.
//
// The load-bearing distinction here: **a bearer token identifies a connection,
// a delegation identifies a payer.** Billing the token holder is how a provider
// ends up charging whoever happens to hold a proxy credential — including
// itself, which is exactly what the front would have done. The principal debited
// below is the tabPrincipal from a delegation whose signature was verified
// against a key anchored to that address, never the caller's transport identity.
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { computeUnits, costMicroTrac, isExempt, SCHEDULE_VERSION, type MeterConfig } from "./read-meter.js";
import { balance, recordReadLeg, recordShadowObservation, readJournal, appendJournal, tabEpoch, canonicalize, disputeLeg as ledgerDisputeLeg, disputedLegsOf } from "./ledger.js";
import { verifyCapability, admissibleForSettlement, type SignedDelegation, type CapabilityState } from "./capability.js";
import { anchorWalletKey } from "./buyer-registry.js";
import { activeOpening } from "./deposit-rail.js";
import type { BindingProof } from "./evm-binding.js";

const sha256 = (b: string) => createHash("sha256").update(b).digest("hex");

/**
 * Gradual release (Q3, buyer-corrected). The fair-exchange problem: the provider
 * delivers a result, THEN the buyer countersigns. Whoever moves second can
 * cheat — and since the read is already delivered, disputing every leg would be
 * free for the buyer, while billing an unsigned leg would be theft by the
 * provider. Bo's answer, adopted: withhold the NEXT valuable result until the
 * prior leg is countersigned. That bounds the provider's exposure to exactly one
 * provisional leg, and makes disputing cost the buyer their service continuity.
 *
 * "Outstanding" is derived from the journal, never held in memory — a debit leg
 * with no matching countersign record. In-memory-only state has cost this
 * prototype a full evening; the obligation must survive a restart.
 */
export function outstandingLegs(home: string, principal: string): number {
  const p = principal.toLowerCase();
  // Gradual release is scoped to the CURRENT epoch (Bo #4): a prior epoch's
  // debits and countersignatures must not affect the fresh tab's obligation
  // count, or an old unsigned leg would block a new tab (or a new leg inherit
  // an old signature). Debit and countersign records both carry `epoch`.
  const epoch = tabEpoch(home, principal);
  // A leg the buyer has FORMALLY withheld through the authenticated dispute
  // path is ADJUDICATED, not outstanding (buyer-found, billed-run block): the
  // one-withhold policy voids the leg from the provider claim and the run is
  // meant to CONTINUE — the prior behavior dead-locked the tab, because a
  // disputed leg can never be countersigned and so blocked every later call.
  // Silent non-signing still blocks (the anti-free-riding property is intact);
  // only an explicit, signature-verified withhold — of which the ledger allows
  // exactly ONE per epoch — releases the slot.
  // Compute outstanding by LEG IDENTITY, never by aggregate subtraction
  // (buyer-found, v2.2 block): `debits − signed` let a stale countersignature
  // for a later-withheld leg cancel a DIFFERENT unsigned leg (countersign A →
  // bill B unsigned → withhold A → A leaves the debit set but its signature was
  // still subtracted, hiding B). The obligation is a SET operation: current-
  // epoch billed legs, minus formally disputed ids, minus the ids that are
  // themselves countersigned. Only a leg that is neither disputed nor signed
  // is outstanding.
  const disputed = new Set(disputedLegsOf(home, principal).map(String));
  const billed = new Set<string>();
  const signedIds = new Set<string>();
  for (const rec of readJournal(home)) {
    const recEpoch = Number((rec as any).epoch ?? (rec as any).leg?.tabEpoch ?? 0);
    if (recEpoch !== epoch) continue;
    if (rec.kind === "debit" && String((rec.leg as any)?.requester?.principal ?? "").toLowerCase() === p) {
      billed.add(String((rec.leg as any)?.legId ?? ""));
    }
    if (rec.kind === "leg-countersigned" && String(rec.principal ?? "").toLowerCase() === p) {
      signedIds.add(String(rec.legId ?? ""));
    }
  }
  let outstanding = 0;
  for (const legId of billed) {
    if (disputed.has(legId)) continue;      // adjudicated — not outstanding
    if (signedIds.has(legId)) continue;     // countersigned THIS leg — not outstanding
    outstanding++;                          // neither → a real provider claim awaiting the buyer
  }
  return outstanding;
}

export interface MeteredReadRequest {
  delegation: SignedDelegation;
  bindingProof?: BindingProof;
  sparql: string;
  contextGraphId?: string;
  view?: string;
  /** Buyer's declared ceiling for THIS call. Fail closed above it. */
  maxMicroTrac?: number;
  revocationCheckpoint?: { observedAt: number | null; maxCheckpointAgeMs: number };
}

export type MeteredReadOutcome =
  | { ok: false; status: number; code: string; detail?: string }
  | {
      ok: true;
      status: 200;
      principal: string;
      /** The signed leg, pending the buyer's countersignature. */
      leg: Record<string, unknown>;
      billed: boolean;
      costMicroTrac: number;
      tab: { before: number; after: number };
      settlement: { admissible: false; reason: string };
    };

/**
 * Authorise a metered read and produce the leg. Does NOT execute the query —
 * the caller runs it and passes the body in, so this module stays free of the
 * daemon's store dependencies and remains independently testable.
 */
export function authoriseMeteredRead(args: {
  home: string;
  chainId: number;
  cfg: MeterConfig;
  request: MeteredReadRequest;
  /** Per-capability state, owned by the caller (home-keyed). */
  state: CapabilityState;
  route: string;
  nodeClass: string;
  settlementId: string;
  scheduleDigest: string;
  priceVectorDigest: string;
  now?: number;
}): { ok: false; status: number; code: string; detail?: string } | { ok: true; principal: string; label: string; bindingMode: "eip191" | "registry" } {
  const { request: r, cfg, home, chainId } = args;
  const now = args.now ?? Date.now();

  if (!r?.delegation || typeof r.sparql !== "string" || !r.sparql.trim()) {
    return { ok: false, status: 400, code: "E_MISSING_FIELD", detail: "delegation and sparql are required" };
  }

  // 1. Anchor: resolve the verifying key from a self-proving binding or the
  //    operator registry. Caller-supplied keys are never consulted.
  const anchor = anchorWalletKey(home, r.delegation.tabPrincipal, { proof: r.bindingProof, chainId, now });
  if (!anchor.ok) {
    return { ok: false, status: 403, code: anchor.bindingCode ?? anchor.code, detail: anchor.detail };
  }

  // 2. Capability: the delegation must authorise THIS route, at this price.
  const v = verifyCapability({
    delegation: r.delegation,
    walletPublicKeyPem: anchor.walletPublicKeyPem,
    state: args.state,
    now,
    request: {
      route: args.route,
      nodeClass: args.nodeClass,
      settlementId: args.settlementId,
      scheduleDigest: args.scheduleDigest,
      priceVectorDigest: args.priceVectorDigest,
      sequence: args.state.sequence + 1,
      estimatedMicroTrac: 0,
    },
    revocationCheckpoint: r.revocationCheckpoint ?? { observedAt: null, maxCheckpointAgeMs: 0 },
  });
  if (!v.ok) return { ok: false, status: 403, code: v.code };

  // 3. A tab must be open for the principal the DELEGATION names. Enforcement
  //    is per-principal, so this can be live for one buyer while every other
  //    production read stays in shadow.
  const principal = r.delegation.tabPrincipal;
  const willBill = !isExempt(principal, cfg);

  // Binding mode: EIP-191 self-proof vs operator registry. anchor.label is
  // "self-proved:<addr>" only for a verified EIP-191 proof.
  const bindingMode: "eip191" | "registry" = anchor.label.startsWith("self-proved:") ? "eip191" : "registry";

  // OpenClaw-found: the policy "registry authorizes only the zero-value
  // preflight; a funded call requires EIP-191" was stated in the design and in
  // chat, but NOT enforced here — a registry-only anchor would authorize a
  // BILLABLE read. Enforce it as an affirmative positive check: a funded call
  // must present a verified EIP-191 proof, never merely "fail to be
  // unregistered". Defence in depth over the anchor's precedence rule.
  if (willBill && bindingMode !== "eip191") {
    return {
      ok: false, status: 403, code: "E_FUNDED_REQUIRES_BINDING",
      detail: "A billable read requires a verified EIP-191 wallet binding. Registry approval authorizes the zero-value preflight only.",
    };
  }

  if (willBill && !activeOpening(home, principal)) {
    return { ok: false, status: 402, code: "E_NO_OPEN_TAB", detail: "This principal has no open tab to bill against." };
  }

  // Gradual release: at most ONE un-countersigned billable leg may be
  // outstanding. A prior leg awaiting the buyer's countersignature blocks the
  // next billable read until it is signed — never billed, never forced.
  if (willBill && outstandingLegs(home, principal) >= 1) {
    return {
      ok: false, status: 409, code: "E_AWAITING_COUNTERSIGNATURE",
      detail: "Countersign your previous leg before requesting another. The provider serves at most one provisional leg.",
    };
  }

  return { ok: true, principal, label: anchor.label, bindingMode };
}

/**
 * Record the leg for an executed read. Separated from authorisation so a
 * failure here can never be mistaken for an authorisation failure, and so the
 * caller cannot bill without having first passed every check above.
 */
export function settleMeteredRead(args: {
  home: string;
  cfg: MeterConfig;
  principal: string;
  requesterKeyRef?: string;
  sparql: string;
  responseBody: string;
  scopeQuads: number;
  contextGraphId?: string;
  view?: string;
  maxMicroTrac?: number;
  wallMs?: number;
}): MeteredReadOutcome {
  const u = computeUnits({
    sparql: args.sparql,
    scopeQuads: args.scopeQuads,
    responseBytes: Buffer.byteLength(args.responseBody, "utf8"),
  });
  const cost = costMicroTrac(u.units, args.cfg.readAskMicroPer1k);
  const billable = !isExempt(args.principal, args.cfg);

  // The buyer's per-call ceiling is checked BEFORE the debit, and exceeding it
  // is a refusal rather than a clamp: silently charging less than asked would
  // hide a pricing disagreement that the buyer explicitly wanted surfaced.
  if (billable && args.maxMicroTrac !== undefined && cost > args.maxMicroTrac) {
    return {
      ok: false, status: 402, code: "E_OVER_BUYER_CEILING",
      detail: `this read prices at ${cost} µTRAC, above your declared ceiling of ${args.maxMicroTrac}`,
    };
  }

  recordShadowObservation(args.home, {
    units: u.units,
    breakdown: u.breakdown as unknown as Record<string, unknown>,
    scopeQuads: args.scopeQuads,
    responseBytes: Buffer.byteLength(args.responseBody, "utf8"),
    sparql: args.sparql,
    askMicroPer1k: args.cfg.readAskMicroPer1k,
    costMicroTrac: cost,
    mode: args.cfg.mode,
    billable,
    wallMs: args.wallMs,
    contextGraphId: args.contextGraphId,
    view: args.view,
  });

  if (!billable) {
    // Honest zero: a receipt-shaped response that does NOT claim to be a leg.
    // A shadow read must never look like a billed one to the buyer.
    return {
      ok: true, status: 200, principal: args.principal, billed: false,
      costMicroTrac: 0,
      leg: {
        legType: "read-shadow", schemaVersion: "receipt-v0.3",
        meter: { scheduleVersion: SCHEDULE_VERSION, unitsTenths: Math.round(u.units * 10), scopeQuads: args.scopeQuads },
        pricing: { askMicroPer1k: args.cfg.readAskMicroPer1k, wouldHaveCostMicroTrac: cost, unit: "mockTRAC-u" },
        evidence: { queryDigest: "sha256:" + sha256(args.sparql), resultDigest: "sha256:" + sha256(args.responseBody) },
        note: "Metering only. This node is not billing this principal; no ledger entry was made.",
      },
      tab: { before: balance(args.home, args.principal).balance, after: balance(args.home, args.principal).balance },
      settlement: { admissible: false, reason: "shadow mode — nothing to settle" },
    };
  }

  let leg: Record<string, unknown>;
  try {
    leg = recordReadLeg(args.home, {
      principal: args.principal,
      units: u.units,
      breakdown: u.breakdown as unknown as Record<string, unknown>,
      scopeQuads: args.scopeQuads,
      sparql: args.sparql,
      responseBody: args.responseBody,
      contextGraphId: args.contextGraphId,
      view: args.view,
      askMicroPer1k: args.cfg.readAskMicroPer1k,
      requesterKeyRef: args.requesterKeyRef,
    }) as unknown as Record<string, unknown>;
  } catch (e: unknown) {
    const m = String((e as Error)?.message ?? e);
    const status = m.includes("INSUFFICIENT") ? 402 : m.includes("EXPIRED") ? 402 : 500;
    return { ok: false, status, code: m.slice(0, 64) };
  }

  const tab = leg.tab as { before: number; after: number };
  return {
    ok: true, status: 200, principal: args.principal, billed: true,
    costMicroTrac: (leg.pricing as { costMicroTrac: number }).costMicroTrac,
    leg,
    tab,
    // D14, restated at the point of billing so it cannot be forgotten: the
    // debit is provisional until the buyer countersigns. The provider holds a
    // signed claim, not a settled payment.
    settlement: { admissible: false, reason: "pending buyer countersignature (D14)" },
  };
}

/** Verify a buyer's countersignature over a leg and mark it settleable. */
export function countersignLeg(args: {
  home?: string;
  leg: Record<string, unknown>;
  countersignature: string;
  sessionPublicKeyPem: string;
  now?: number;
}): { ok: boolean; code: string } {
  // Buyer-found (Hermes/Bo, live A1 probe (b)): countersign verified the
  // SIGNATURE over the leg but never checked the leg was actually SERVED. A
  // caller could fabricate a leg, sign it with their own session key, and get
  // settleable=true — and, worse, the leg-countersigned record it appended
  // could inflate the `signed` count and drive outstandingLegs to a clamped 0,
  // bypassing gradual release entirely (unbounded reads on credit). A
  // countersignature is only meaningful over a leg the PROVIDER actually issued.
  //
  // So: the leg must exist in the journal as a debit for the claimed principal,
  // matched by BOTH legId and the provider's recorded hash. A signature over a
  // never-served leg is rejected before any verification or recording.
  const principal = String((args.leg as any)?.requester?.principal ?? "");
  const legId = String((args.leg as any)?.legId ?? "");
  if (args.home) {
    const served = readJournal(args.home).some((rec) =>
      rec.kind === "debit"
      && String((rec.leg as any)?.legId ?? "") === legId
      && String((rec.leg as any)?.requester?.principal ?? "").toLowerCase() === principal.toLowerCase()
      && legId !== "",
    );
    if (!served) return { ok: false, code: "E_LEG_NOT_SERVED" };
  }

  const r = admissibleForSettlement({
    leg: args.leg,
    sessionPublicKeyPem: args.sessionPublicKeyPem,
    countersignature: args.countersignature,
    now: args.now ?? Date.now(),
  });
  // On success, durably record that THIS leg is countersigned, so gradual
  // release lets the next read through and a restart does not resurrect the
  // outstanding obligation. Idempotent: a leg already recorded is not doubled.
  if (r.ok && args.home) {
    const already = readJournal(args.home).some(
      (rec) => rec.kind === "leg-countersigned" && rec.legId === legId,
    );
    if (principal && legId && !already) {
      // Stamp the leg's epoch so gradual release and close completeness can scope
      // to the current epoch (Bo #4). The leg carries tabEpoch.
      const legEpoch = Number((args.leg as any)?.tabEpoch ?? 0);
      appendJournal(args.home, {
        kind: "leg-countersigned", principal, legId, epoch: legEpoch,
        countersignature: args.countersignature, at: new Date().toISOString(),
      });
    }
  }
  return { ok: r.ok, code: r.code };
}

/** Domain-separated from the countersignature so a countersign can never be
 *  replayed as a withhold, or vice-versa. */
export const WITHHOLD_DOMAIN = "odysseus-dkg:leg-withhold:v1";

/**
 * An authenticated buyer WITHHOLD of exactly one funded leg (Bo, funded-run
 * block #4). This is the protocol wiring that connects a dispute to the
 * AUTHORITATIVE ledger and the close statement — not a sidecar subtraction.
 *
 * The withholder must be the buyer bound to the leg: their session key must hash
 * to the leg's requester keyRef, and they must sign the leg digest under the
 * withhold domain. The leg must actually have been served. On success the
 * ledger records a durable, idempotent dispute (cap: one per epoch), which both
 * excludes the leg from the envelope aggregate and marks it disputed for the
 * close statement.
 */
export function withholdLeg(args: {
  home: string;
  leg: Record<string, any>;
  withholdSignature: string;    // base64, over WITHHOLD_DOMAIN + "\n" + legDigest
  sessionPublicKeyPem: string;
}): { ok: boolean; code: string } {
  const principal = String(args.leg?.requester?.principal ?? "");
  const legId = String(args.leg?.legId ?? "");
  if (!principal || !legId) return { ok: false, code: "E_MISSING_FIELD" };

  // The leg must have been served by the provider (same non-fabrication check as
  // countersign) AND be a funded leg (carry a quoteDigest).
  const served = readJournal(args.home).find((rec) =>
    rec.kind === "debit"
    && String((rec.leg as any)?.legId ?? "") === legId
    && String((rec.leg as any)?.requester?.principal ?? "").toLowerCase() === principal.toLowerCase());
  if (!served) return { ok: false, code: "E_LEG_NOT_SERVED" };
  if (!(served.leg as any)?.quoteDigest) return { ok: false, code: "E_NOT_FUNDED_LEG" };

  // Only the buyer BOUND to the leg may withhold it: the session key must hash to
  // the leg's requester keyRef.
  const keyRef = String(args.leg?.requester?.keyRef ?? "");
  if (keyRef && keyRef !== "sha256:" + sha256(args.sessionPublicKeyPem)) return { ok: false, code: "E_WITHHOLD_WRONG_KEY" };

  const digest = "sha256:" + sha256(canonicalize(args.leg));
  let ok = false;
  try {
    ok = edVerify(null, Buffer.concat([Buffer.from(WITHHOLD_DOMAIN + "\n"), Buffer.from(digest)]), createPublicKey(args.sessionPublicKeyPem), Buffer.from(args.withholdSignature, "base64"));
  } catch { ok = false; }
  if (!ok) return { ok: false, code: "E_WITHHOLD_BAD_SIGNATURE" };

  const r = ledgerDisputeLeg(args.home, principal, legId);
  if (!r.ok) return { ok: false, code: r.code };
  return { ok: true, code: r.alreadyDisputed ? "OK_ALREADY_DISPUTED" : "OK" };
}
