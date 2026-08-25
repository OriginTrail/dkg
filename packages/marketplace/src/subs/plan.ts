// Plan lifecycle: purchase (exact ceilings, one provider per offering),
// top-up (extends, refunds nowhere), period-end expiry (journaled, meter
// enters `expired`), start-new-period (only via a new consented payment).
// No auto-renewal exists anywhere in this file or this rail.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AskCommitment, Plan, PlanAllocation } from "./objects.js";
import { activePlan, allowances, appendJournal, readPlans, savePlan, subsHome } from "./journal.js";

export interface PlanRequestLine {
  offeringId: string;
  seller: string;                       // the ONE chosen provider
  allocationMicroTrac: number;
}

/** Exact ceilings: allocation ÷ the chosen provider's frozen ask.
 *  No floor-vs-better distinction — there is no runtime routing. */
export function buildPlan(a: {
  buyer: string;
  periodMs: number;
  cycle: number;
  lines: PlanRequestLine[];
  asks: AskCommitment[];                // current committed asks (frozen here)
  now: Date;
  paymentTxBySeller: Record<string, string>;   // consented, already broadcast
}): Plan {
  const allocations: PlanAllocation[] = a.lines.map((l) => {
    const ask = a.asks.find((x) => x.offeringId === l.offeringId && x.seller === l.seller && x.effectiveFromCycle <= a.cycle);
    if (!ask) throw new Error(`E_NO_COMMITTED_ASK ${l.offeringId}@${l.seller}`);
    return {
      offeringId: l.offeringId, seller: l.seller, unit: ask.unit,
      allocationMicroTrac: l.allocationMicroTrac,
      frozenAskMicroPerUnit: ask.askMicroPerUnit,
    };
  });
  // I4 precondition: one payment per subscribed seller, no more, no less.
  const sellers = [...new Set(allocations.map((x) => x.seller))];
  for (const s of sellers) if (!a.paymentTxBySeller[s]) throw new Error(`E_PAYMENT_MISSING ${s}`);
  for (const s of Object.keys(a.paymentTxBySeller)) if (!sellers.includes(s)) throw new Error(`E_PAYMENT_UNMATCHED ${s}`);
  return {
    planId: "plan_" + randomBytes(8).toString("hex"),
    buyer: a.buyer,
    periodId: "p-" + a.now.toISOString().slice(0, 16),
    periodMs: a.periodMs,
    startedAt: a.now.toISOString(),
    expiresAt: new Date(a.now.getTime() + a.periodMs).toISOString(),
    cycle: a.cycle,
    fundingSource: "trac_payment",
    allocations,
    paymentTxBySeller: a.paymentTxBySeller,
  };
}

export function purchasePlan(home: string, plan: Plan): void {
  savePlan(home, plan);
  for (const [seller, tx] of Object.entries(plan.paymentTxBySeller)) {
    const paid = plan.allocations.filter((x) => x.seller === seller)
      .reduce((s, x) => s + x.allocationMicroTrac, 0);
    appendJournal(home, { kind: "paid", at: plan.startedAt, planId: plan.planId, seller, microTrac: paid, detail: tx });
  }
}

/** Top-up extends one allowance mid-period — a new payment; nothing refundable. */
export function topUp(home: string, plan: Plan, offeringId: string, seller: string, microTrac: number, tx: string, now: Date): number {
  const alloc = plan.allocations.find((x) => x.offeringId === offeringId && x.seller === seller);
  if (!alloc) throw new Error("E_NO_SUCH_ALLOWANCE");
  const units = Math.floor(microTrac / alloc.frozenAskMicroPerUnit);
  appendJournal(home, { kind: "toppedUp", at: now.toISOString(), planId: plan.planId, offeringId, seller, units, microTrac, detail: tx });
  return units;
}

/** Period end: every allowance's remainder expires with an explicit journal
 *  entry — value recognized, never returned. Idempotent. */
export function expirePeriod(home: string, plan: Plan, now: Date): { expiredMicroTrac: number } {
  if (now < new Date(plan.expiresAt)) throw new Error("E_PERIOD_STILL_ACTIVE");
  let total = 0;
  for (const row of allowances(home, plan)) {
    if (row.state === "expired") continue;
    const alloc = plan.allocations.find((x) => x.offeringId === row.offeringId && x.seller === row.seller)!;
    const remainderUnits = Math.max(0, row.guaranteedUnits - row.consumedUnits);
    const micro = Math.round(remainderUnits * alloc.frozenAskMicroPerUnit);
    appendJournal(home, {
      kind: "expired", at: now.toISOString(), planId: plan.planId,
      offeringId: row.offeringId, seller: row.seller, microTrac: micro,
      detail: `period end — ${remainderUnits} ${row.unit} recognized, not returned`,
    });
    total += micro;
  }
  return { expiredMicroTrac: total };
}

/** A new period is a NEW plan built from a NEW consented payment — this
 *  helper only computes the next cycle index; it cannot start anything. */
export function nextCycle(home: string): number {
  const plans = readPlans(home);
  return plans.length ? Math.max(...plans.map((p) => p.cycle)) + 1 : 1;
}

export { activePlan };

// ── provider switch at the boundary ────────────────────────────────────────
// A switch is a note against the NEXT cycle; the current period's provider
// binds until expiry. There is nothing to execute now by design.
export interface BoundarySwitch { planId: string; offeringId: string; toSeller: string; requestedAt: string }

export function requestSwitch(home: string, plan: Plan, offeringId: string, toSeller: string, now: Date): BoundarySwitch {
  // NOT a journal event — Appendix A's journal kinds are closed. Switches
  // are composition state for the NEXT cycle, in their own store.
  const sw: BoundarySwitch = { planId: plan.planId, offeringId, toSeller, requestedAt: now.toISOString() };
  appendFileSync(join(subsHome(home), "switches.jsonl"), JSON.stringify(sw) + "\n");
  return sw;
}

export function pendingSwitches(home: string, planId: string): BoundarySwitch[] {
  const p = join(subsHome(home), "switches.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as BoundarySwitch).filter((s) => s.planId === planId);
}
