// v3.5 leg lifecycle — the v3 incident, codified so it never needs improvising.
//
//   pending-delivery ──delivered──▶ delivered ──▶ countersigned | withheld
//         │
//         └── deadline missed ──▶ voided  (billing auto-reversed)
//
// v3's billed-but-undelivered leg (leg_27796e2b, 258µ) had no honest state:
// the buyer could neither countersign (no bytes) nor withhold (no provable
// violation). v3.5 makes the gray case first-class:
//   · a leg is born PENDING-DELIVERY with a deadline; billing happened at
//     serve-time (unchanged, atomic with the debit), but is PROVISIONAL
//   · DELIVERED is appended only when the response bytes are durably on their
//     way to the buyer (direct: response written; lane: response KA publish
//     succeeded — the exact step that failed in v3)
//   · a pending leg past its deadline AUTO-VOIDS: a compensating ledger credit
//     reverses the debit, and the leg can never be countersigned or withheld
//   · countersign/withhold are only legal FROM delivered
//   · close treats voided as decided (nothing owed, nothing disputed)
//
// Idempotency keys ride the same file: the first serve under (tabId, key)
// records the mapping; a retry with the same key returns the SAME leg and
// response digest without re-serving or re-billing — at-most-once billing
// across retries (kills v3's 258µ duplicate class).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { credit } from "../core/ledger.js";

export type LegState = "pending-delivery" | "delivered" | "countersigned" | "withheld" | "voided";

// NSM_TEST_DEADLINE_MS: fixture seam — drills need deadlines that expire in
// milliseconds, not minutes. Live runs never set it.
const testOverride = Number(process.env.NSM_TEST_DEADLINE_MS ?? NaN);
export const DELIVERY_DEADLINE_MS: Record<string, number> = {
  direct: Number.isFinite(testOverride) ? testOverride : 60_000,   // interactive
  lane: Number.isFinite(testOverride) ? testOverride : 300_000,    // gossip
};

const legsPath = (home: string) => join(home, "legs.jsonl");
const idempoPath = (home: string) => join(home, "idempotency.jsonl");

function appendLine(p: string, rec: Record<string, unknown>): void {
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(rec) + "\n");
}
function readLines(p: string): Array<Record<string, unknown>> {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; }
  });
}

/** Current lifecycle state of a leg (last-writer-wins over the event log). */
export function legState(home: string, legId: string): { state: LegState; code?: string; deadline?: string } {
  let state: LegState = "pending-delivery";
  let code: string | undefined;
  let deadline: string | undefined;
  for (const r of readLines(legsPath(home))) {
    if (r.legId !== legId) continue;
    switch (r.type) {
      case "leg": deadline = r.deliveryDeadline as string | undefined; break;
      case "delivered": if (state === "pending-delivery") state = "delivered"; break;
      case "countersign": state = "countersigned"; break;
      case "withhold": state = "withheld"; code = String(r.code); break;
      case "voided": state = "voided"; break;
    }
  }
  return { state, code, deadline };
}

/** Mark a leg delivered — call ONLY after the response is durably outbound. */
export function markDelivered(home: string, legId: string, transport: string): void {
  appendLine(legsPath(home), { type: "delivered", legId, transport, at: new Date().toISOString() });
}

/**
 * Sweep pending legs past their delivery deadline: append `voided` and reverse
 * the serve-time debit with a compensating credit. Idempotent — a leg voids at
 * most once (state check), and the credit carries the legId for audit.
 * Returns the voided legIds.
 */
export function sweepExpiredDeliveries(home: string, now = Date.now()): string[] {
  const rows = readLines(legsPath(home));
  const voided: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.type !== "leg" || seen.has(String(r.legId))) continue;
    seen.add(String(r.legId));
    const st = legState(home, String(r.legId));
    if (st.state !== "pending-delivery") continue;
    const deadline = Date.parse(String(r.deliveryDeadline ?? ""));
    if (!Number.isFinite(deadline) || now < deadline) continue;
    const cost = Number((r.pricing as { costMicroTrac?: number })?.costMicroTrac ?? 0);
    const principal = String(r.principal);
    appendLine(legsPath(home), { type: "voided", legId: r.legId, reason: "delivery-deadline-missed", at: new Date(now).toISOString() });
    if (cost > 0) {
      credit(home, principal, cost, { kind: "nsm-v35-void-reversal", legId: r.legId, reason: "delivery-deadline-missed" });
    }
    voided.push(String(r.legId));
  }
  return voided;
}

// ── idempotency ──

export interface IdempoRecord { tabId: string; key: string; legId: string; responseDigest: string; at: string }

/** Look up a prior serve for (tabId, idempotencyKey). */
export function idempoLookup(home: string, tabId: string, key: string): IdempoRecord | null {
  for (const r of readLines(idempoPath(home))) {
    if (r.tabId === tabId && r.key === key) return r as unknown as IdempoRecord;
  }
  return null;
}

/** Record the mapping after a successful first serve. */
export function idempoRecord(home: string, rec: IdempoRecord): void {
  appendLine(idempoPath(home), rec as unknown as Record<string, unknown>);
}
