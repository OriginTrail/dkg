// P5 subscription journal — append-only, per seat, under
// <home>/subscriptions/. The P4 tab ledger is archived elsewhere and never
// written again. Projections here are the single source for meters, plan
// aggregates (display only), and the I2/I3/I5 checks.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type {
  Allowance, CallLogEntry, JournalEntry, OfferingUnit, Plan,
} from "./objects.js";

export function subsHome(marketplaceHome: string): string {
  const dir = join(marketplaceHome, "subscriptions");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const sha256 = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");

// ── journal ────────────────────────────────────────────────────────────────

export function appendJournal(home: string, e: JournalEntry): void {
  if (e.kind === "consumed" && (!e.offeringId || !e.seller)) {
    // I5 is structural: a consumed entry that names no single allowance
    // cannot be written at all.
    throw new Error("E_I5_CONSUMED_WITHOUT_ALLOWANCE");
  }
  appendFileSync(join(subsHome(home), "journal.jsonl"), JSON.stringify(e) + "\n");
}

export function readJournal(home: string): JournalEntry[] {
  const p = join(subsHome(home), "journal.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as JournalEntry);
}

// ── plans ──────────────────────────────────────────────────────────────────

export function savePlan(home: string, plan: Plan): void {
  appendFileSync(join(subsHome(home), "plans.jsonl"), JSON.stringify(plan) + "\n");
}

export function readPlans(home: string): Plan[] {
  const p = join(subsHome(home), "plans.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Plan);
}

export function activePlan(home: string, now: Date): Plan | null {
  // newest plan whose period contains `now`; nothing renews by itself
  const plans = readPlans(home).filter((p) => new Date(p.startedAt) <= now && now < new Date(p.expiresAt));
  return plans.length ? plans[plans.length - 1] : null;
}

// ── allowance projection (the meters) ──────────────────────────────────────

export function allowances(home: string, plan: Plan): Allowance[] {
  const j = readJournal(home).filter((e) => e.planId === plan.planId);
  return plan.allocations.map((a) => {
    const mine = j.filter((e) => e.offeringId === a.offeringId && e.seller === a.seller);
    const consumed = mine.filter((e) => e.kind === "consumed").reduce((s, e) => s + (e.units ?? 0), 0);
    const topped = mine.filter((e) => e.kind === "toppedUp").reduce((s, e) => s + (e.units ?? 0), 0);
    const expired = mine.some((e) => e.kind === "expired");
    const guaranteed = Math.floor(a.allocationMicroTrac / a.frozenAskMicroPerUnit) + topped;
    const state = expired ? "expired" : consumed >= guaranteed ? "exhausted" : "active";
    return {
      planId: plan.planId, offeringId: a.offeringId, seller: a.seller, unit: a.unit,
      guaranteedUnits: guaranteed, consumedUnits: consumed, state,
    };
  });
}

/** Display aggregate ONLY — never a limit (Part 0). Share of paid value
 *  consumed, at frozen asks. */
export function planSummaryPct(home: string, plan: Plan): number {
  const rows = allowances(home, plan);
  let paid = 0, used = 0;
  for (const a of plan.allocations) {
    const row = rows.find((r) => r.offeringId === a.offeringId && r.seller === a.seller)!;
    paid += a.allocationMicroTrac;
    used += Math.min(row.consumedUnits, row.guaranteedUnits) * a.frozenAskMicroPerUnit;
  }
  return paid === 0 ? 0 : Math.round((used / paid) * 100);
}

// ── invariant checks (continuous, cheap) ───────────────────────────────────

export function checkI2(home: string, plan: Plan): { ok: boolean; detail: string } {
  const j = readJournal(home).filter((e) => e.planId === plan.planId && e.kind === "consumed");
  const total = j.reduce((s, e) => s + (e.units ?? 0), 0);
  const byKey = j.reduce((s, e) => s + (e.keyId ? (e.units ?? 0) : 0), 0);
  const unkeyed = j.filter((e) => !e.keyId).length;
  return { ok: byKey + (total - byKey) === total && unkeyed === 0,
           detail: `total=${total} keyed=${byKey} unkeyedEntries=${unkeyed}` };
}

export function checkI3(home: string, plan: Plan): { ok: boolean; detail: string } {
  // per ceiling per cycle: paid == consumed_value + expired_value
  const j = readJournal(home).filter((e) => e.planId === plan.planId);
  for (const a of plan.allocations) {
    const mine = j.filter((e) => e.offeringId === a.offeringId && e.seller === a.seller);
    const consumedVal = mine.filter((e) => e.kind === "consumed")
      .reduce((s, e) => s + (e.units ?? 0) * a.frozenAskMicroPerUnit, 0);
    const expiredVal = mine.filter((e) => e.kind === "expired")
      .reduce((s, e) => s + (e.microTrac ?? 0), 0);
    const toppedVal = mine.filter((e) => e.kind === "toppedUp")
      .reduce((s, e) => s + (e.units ?? 0) * a.frozenAskMicroPerUnit, 0);
    const paid = a.allocationMicroTrac + toppedVal;
    const closed = mine.some((e) => e.kind === "expired");
    if (closed && Math.abs(paid - (consumedVal + expiredVal)) > a.frozenAskMicroPerUnit) {
      return { ok: false, detail: `${a.offeringId}@${a.seller}: paid=${paid} consumed=${consumedVal} expired=${expiredVal}` };
    }
  }
  return { ok: true, detail: "all closed ceilings balance" };
}

export function checkI5(home: string): { ok: boolean; detail: string } {
  const bad = readJournal(home).filter((e) => e.kind === "consumed" && (!e.offeringId || !e.seller));
  return { ok: bad.length === 0, detail: `${bad.length} consumed entries without a single allowance ref` };
}

// ── hash-chained call log (both seats keep one) ────────────────────────────

export function appendCallLog(home: string, e: Omit<CallLogEntry, "prevDigest" | "digest">): CallLogEntry {
  const p = join(subsHome(home), `calls-${e.pair}.jsonl`);
  const prev = callLogHead(home, e.pair);
  const body = JSON.stringify({ ...e, prevDigest: prev });
  const entry: CallLogEntry = { ...e, prevDigest: prev, digest: sha256(prev + body) };
  appendFileSync(p, JSON.stringify(entry) + "\n");
  return entry;
}

export function readCallLog(home: string, pair: string): CallLogEntry[] {
  const p = join(subsHome(home), `calls-${pair}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CallLogEntry);
}

export function callLogHead(home: string, pair: string): string {
  const log = readCallLog(home, pair);
  return log.length ? log[log.length - 1].digest : "sha256:genesis";
}

/** Verify the chain end to end — the dispute engine's precondition. */
export function verifyCallLogChain(home: string, pair: string): { ok: boolean; brokenAt?: number } {
  const log = readCallLog(home, pair);
  let prev = "sha256:genesis";
  for (let i = 0; i < log.length; i++) {
    const { digest, ...rest } = log[i];
    const body = JSON.stringify({ ...rest, prevDigest: prev });
    void body;
    const expect = sha256(prev + JSON.stringify({ ...rest, prevDigest: prev }));
    if (log[i].prevDigest !== prev || digest !== expect) return { ok: false, brokenAt: i };
    prev = digest;
  }
  return { ok: true };
}

export function unitTotals(home: string, pair: string, periodStartAt?: string, untilAt?: string): Record<string, number> {
  // running totals per offering from the call log — the checkpoint substrate.
  // `untilAt` cuts at a checkpoint's moment: agreement means "AT that
  // instant both seats matched", not "now vs then" (found by drill D2b —
  // in-flight calls after the peer's emit read as spurious divergence).
  const out: Record<string, number> = {};
  for (const e of readCallLog(home, pair)) {
    if (periodStartAt && e.at < periodStartAt) continue;
    if (untilAt && e.at > untilAt) continue;
    if (e.phase === "void") continue;         // no delivery, no decrement
    out[e.offeringId] = (out[e.offeringId] ?? 0) + e.units;
  }
  return out;
}
