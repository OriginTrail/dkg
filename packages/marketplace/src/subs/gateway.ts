// Subscription-aware gateway admission — the buyer-side choke point every
// /v1/chat/completions and /v1/query call passes through.
//
// This is a LOOKUP, not a router: a request names a model; the plan named
// exactly ONE provider for it at purchase. There is no price comparison
// here, no fallback — if the chosen provider fails, the call charges
// nothing and says so (the caller may switch models; switching providers
// lands at the next cycle).

import type { Allowance, OfferingUnit, Plan } from "./objects.js";
import { allowances, appendCallLog, appendJournal } from "./journal.js";
import { noteBillableCall, emitCheckpoint, type CadenceConfig, DEFAULT_CADENCE } from "./checkpoint.js";

export interface ForkOption { offeringId: string; pctLeft: number }

export type Admission =
  | { ok: true; allowance: Allowance; pair: string }
  | { ok: false; status: 402; body: {
        error: "no_active_ceiling";
        offeringId: string;
        fork: { topUp: true; switch: ForkOption[] };   // no wait option exists
        expiresAt?: string;
      } }
  | { ok: false; status: 402; body: { error: "no_active_plan"; fork: { startNewPeriod: true } } };

const pairId = (buyer: string, seller: string) => `${buyer.toLowerCase()}~${seller.toLowerCase()}`;

/** Admission: does this key's plan carry an active ceiling for the offering? */
export function admit(home: string, a: { plan: Plan | null; offeringId: string }): Admission {
  if (!a.plan) return { ok: false, status: 402, body: { error: "no_active_plan", fork: { startNewPeriod: true } } };
  const rows = allowances(home, a.plan);
  const row = rows.find((r) => r.offeringId === a.offeringId);
  if (!row || row.state !== "active") {
    // the fork's switch line: every OTHER active meter remains usable
    const switchable: ForkOption[] = rows
      .filter((r) => r.offeringId !== a.offeringId && r.state === "active")
      .map((r) => ({ offeringId: r.offeringId, pctLeft: Math.max(0, Math.round((1 - r.consumedUnits / r.guaranteedUnits) * 100)) }));
    return { ok: false, status: 402, body: {
      error: "no_active_ceiling", offeringId: a.offeringId,
      fork: { topUp: true, switch: switchable }, expiresAt: a.plan.expiresAt } };
  }
  return { ok: true, allowance: row, pair: pairId(a.plan.buyer, row.seller) };
}

/** Delivery happened: decrement exactly one allowance (I5), extend the
 *  hash-chained call log, tick the checkpoint cadence. Both seats call
 *  this with their OWN counts. */
export function recordDelivery(home: string, a: {
  plan: Plan; allowance: Allowance; callId: string; units: number; unit: OfferingUnit;
  phase?: "admission" | "delivery";                  // queries decrement in two phases
  requestDigest: string; responseDigest?: string; keyId: string; now: Date;
  periodStartAt?: string; cadence?: CadenceConfig;
  sign?: (digest: string) => string;
}): { checkpointEmitted: boolean } {
  const pair = pairId(a.plan.buyer, a.allowance.seller);
  appendJournal(home, {
    kind: "consumed", at: a.now.toISOString(), planId: a.plan.planId,
    offeringId: a.allowance.offeringId, seller: a.allowance.seller,
    units: a.units, keyId: a.keyId, callId: a.callId, phase: a.phase ?? "delivery",
  });
  appendCallLog(home, {
    callId: a.callId, at: a.now.toISOString(), pair,
    offeringId: a.allowance.offeringId, unit: a.unit, units: a.units,
    phase: a.phase ?? "delivery",
    requestDigest: a.requestDigest, responseDigest: a.responseDigest, keyId: a.keyId,
  });
  const due = noteBillableCall(home, pair, a.now, a.cadence ?? DEFAULT_CADENCE);
  if (due) {
    emitCheckpoint(home, {
      pair, periodId: a.plan.periodId,
      periodStartAt: a.periodStartAt ?? a.plan.startedAt, now: a.now, sign: a.sign,
    });
  }
  return { checkpointEmitted: due };
}

/** The chosen provider failed: NOTHING is charged, and the error says so.
 *  A void entry keeps the call log honest without touching any meter. */
export function recordProviderFailure(home: string, a: {
  plan: Plan; allowance: Allowance; callId: string; unit: OfferingUnit;
  requestDigest: string; now: Date; reason: string;
}): { status: 502; body: { error: "provider_unreachable"; provider: string; charged: 0; detail: string } } {
  const pair = pairId(a.plan.buyer, a.allowance.seller);
  appendCallLog(home, {
    callId: a.callId, at: a.now.toISOString(), pair,
    offeringId: a.allowance.offeringId, unit: a.unit, units: 0, phase: "void",
    requestDigest: a.requestDigest,
  });
  return { status: 502, body: {
    error: "provider_unreachable", provider: a.allowance.seller, charged: 0,
    detail: `${a.reason} — this call charged nothing; provider switches take effect at the next period` } };
}
