// AskCommitment lifecycle — a seller's ask is a per-period commitment.
// Edits queue for the next cycle boundary; the current cycle's ask is
// immutable once any subscriber froze it. Stored seller-side under
// <home>/subscriptions/asks.jsonl (append-only; latest wins per
// (offering, effectiveFromCycle)).

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AskCommitment } from "./objects.js";
import { subsHome } from "./journal.js";

export function publishAsk(home: string, ask: AskCommitment, currentCycle: number): AskCommitment {
  if (ask.effectiveFromCycle <= currentCycle) {
    // an ask can never take effect mid-cycle — the commitment rule
    throw new Error("E_ASK_EFFECTIVE_THIS_CYCLE");
  }
  if (ask.askMicroPerUnit <= 0) throw new Error("E_ASK_NONPOSITIVE");
  appendFileSync(join(subsHome(home), "asks.jsonl"), JSON.stringify(ask) + "\n");
  return ask;
}

/** Seed the very first commitment for an offering (bootstrap: takes effect
 *  at the named cycle, which may be the current one when no subscriber has
 *  frozen anything yet). */
export function seedAsk(home: string, ask: AskCommitment): AskCommitment {
  if (ask.askMicroPerUnit <= 0) throw new Error("E_ASK_NONPOSITIVE");
  appendFileSync(join(subsHome(home), "asks.jsonl"), JSON.stringify(ask) + "\n");
  return ask;
}

export function readAsks(home: string): AskCommitment[] {
  const p = join(subsHome(home), "asks.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AskCommitment);
}

/** The ask in force for (offering, seller) at a cycle: the latest published
 *  commitment whose effectiveFromCycle <= cycle. */
export function askInForce(home: string, offeringId: string, seller: string, cycle: number): AskCommitment | null {
  const all = readAsks(home).filter(
    (a) => a.offeringId === offeringId && a.seller === seller && a.effectiveFromCycle <= cycle);
  return all.length ? all[all.length - 1] : null;
}

/** The queued next-cycle ask, if any — the Operate editor's "takes effect
 *  next cycle" value and the storefront's NEXT CYCLE column. */
export function queuedAsk(home: string, offeringId: string, seller: string, currentCycle: number): AskCommitment | null {
  const q = readAsks(home).filter(
    (a) => a.offeringId === offeringId && a.seller === seller && a.effectiveFromCycle > currentCycle);
  return q.length ? q[q.length - 1] : null;
}

// ── the seller's pricing cycle (the domain effectiveFromCycle lives in) ────
// Ask commitments are SELLER cycles, not buyer plan counters. The seller
// advances its cycle explicitly (operate action, aligned with its posted
// period cadence); queued asks take effect at that boundary. Subscribers
// who already froze a price keep it until their own period expires.
import { writeFileSync } from "node:fs";

export function sellerCycle(home: string): number {
  const p = join(subsHome(home), "cycle.json");
  if (!existsSync(p)) return 1;
  try { return Math.max(1, (JSON.parse(readFileSync(p, "utf8")) as { cycle: number }).cycle); } catch { return 1; }
}

export function advanceSellerCycle(home: string): number {
  const next = sellerCycle(home) + 1;
  writeFileSync(join(subsHome(home), "cycle.json"), JSON.stringify({ cycle: next }));
  return next;
}
