// Statements — the once-per-period reconciliation, and the ONLY Verifiable
// Memory publish in the clean path (I6). Agreement → one co-signed
// statement KA into the pair CG, referencing the checkpoint-chain root.
// Disagreement → the dispute engine recounts the divergent interval over
// the hash-chained logs; the resolution is recorded IN the statement.
// An UNRESOLVED mid-period divergence publishes an interim dispute
// statement immediately rather than waiting for period close.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CallLogEntry, OfferingUnit, Statement, StatementItem } from "./objects.js";
import { readCallLog, subsHome, unitTotals, verifyCallLogChain } from "./journal.js";
import { chainRoot } from "./checkpoint.js";

const sha256 = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");

export interface SeatTotals { totals: Record<string, number>; units: Record<string, OfferingUnit> }

export function seatTotals(home: string, pair: string, periodStartAt: string): SeatTotals {
  const units: Record<string, OfferingUnit> = {};
  for (const e of readCallLog(home, pair)) units[e.offeringId] = e.unit;
  return { totals: unitTotals(home, pair, periodStartAt), units };
}

/** Build the period statement from both seats' totals. Pure — publishing
 *  and signing are the caller's side effects. */
export function buildStatement(a: {
  home: string; pair: string; periodId: string; periodStartAt: string;
  ours: SeatTotals; theirs: SeatTotals;
}): Statement {
  const offerings = new Set([...Object.keys(a.ours.totals), ...Object.keys(a.theirs.totals)]);
  const items: StatementItem[] = [...offerings].sort().map((o) => ({
    offeringId: o,
    unit: a.ours.units[o] ?? a.theirs.units[o] ?? "tokens",
    buyerCount: a.ours.totals[o] ?? 0,
    sellerCount: a.theirs.totals[o] ?? 0,
  }));
  const agreed = items.every((i) => i.buyerCount === i.sellerCount);
  return {
    pair: a.pair, periodId: a.periodId, items,
    checkpointChainRoot: chainRoot(a.home, a.pair),
    resolution: agreed ? "agreed" : "disputed",
  };
}

export function statementDigest(s: Statement): string {
  const body = { pair: s.pair, periodId: s.periodId, items: s.items,
                 checkpointChainRoot: s.checkpointChainRoot, resolution: s.resolution,
                 resolutionDetail: s.resolutionDetail ?? null };
  return sha256(JSON.stringify(body));
}

export function saveStatement(home: string, s: Statement): void {
  appendFileSync(join(subsHome(home), "statements.jsonl"), JSON.stringify(s) + "\n");
}

export function readStatements(home: string): Statement[] {
  const p = join(subsHome(home), "statements.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Statement);
}

/** I6 audit: in the clean path exactly one statement KA per pair per period
 *  reaches VM; checkpoints never do; interim publishes only on unresolved
 *  divergence. `vmPublishes` = records of what actually went to VM. */
export function checkI6(vmPublishes: { pair: string; periodId: string; kind: "statement" | "interim-dispute" | "checkpoint" }[],
                        cleanPairsPeriods: { pair: string; periodId: string }[]): { ok: boolean; detail: string } {
  if (vmPublishes.some((p) => p.kind === "checkpoint")) return { ok: false, detail: "a checkpoint reached VM" };
  for (const cp of cleanPairsPeriods) {
    const st = vmPublishes.filter((p) => p.pair === cp.pair && p.periodId === cp.periodId && p.kind === "statement");
    if (st.length !== 1) return { ok: false, detail: `${cp.pair}/${cp.periodId}: ${st.length} statement publishes (need exactly 1)` };
    const interim = vmPublishes.filter((p) => p.pair === cp.pair && p.periodId === cp.periodId && p.kind === "interim-dispute");
    if (interim.length) return { ok: false, detail: `${cp.pair}/${cp.periodId}: interim publish on a CLEAN period` };
  }
  return { ok: true, detail: "clean path: exactly one statement KA per pair per period" };
}

// ── dispute engine — the demoted P4 verifiers' new home ────────────────────
// Recount over the hash-chained logs, scoped to the divergent interval when
// checkpoints identified one, else the whole period.

export interface DisputeFinding {
  offeringId: string;
  ourCount: number;
  theirClaim: number;
  confirmed: number;                    // recount over OUR chained log
  discrepantCalls: string[];            // callIds present in their log, absent/different in ours
  verdict: "our-count-confirmed" | "our-log-broken";
}

export function recountInterval(home: string, a: {
  pair: string; periodStartAt: string; offeringId: string;
  theirClaim: number; theirCalls?: CallLogEntry[];   // peer's log slice, if shared
}): DisputeFinding {
  const chain = verifyCallLogChain(home, a.pair);
  if (!chain.ok) {
    return { offeringId: a.offeringId, ourCount: 0, theirClaim: a.theirClaim,
             confirmed: 0, discrepantCalls: [], verdict: "our-log-broken" };
  }
  const mine = readCallLog(home, a.pair)
    .filter((e) => e.offeringId === a.offeringId && e.at >= a.periodStartAt && e.phase !== "void");
  const confirmed = mine.reduce((s, e) => s + e.units, 0);
  const ourIds = new Map(mine.map((e) => [e.callId, e.units]));
  const discrepant: string[] = [];
  for (const t of a.theirCalls ?? []) {
    if (t.offeringId !== a.offeringId || t.phase === "void") continue;
    const ours = ourIds.get(t.callId);
    if (ours === undefined || ours !== t.units) discrepant.push(t.callId);
  }
  return { offeringId: a.offeringId, ourCount: confirmed, theirClaim: a.theirClaim,
           confirmed, discrepantCalls: discrepant, verdict: "our-count-confirmed" };
}

/** Fold dispute findings into the statement — resolution recorded, never
 *  silently replaced. */
export function resolveStatement(s: Statement, findings: DisputeFinding[]): Statement {
  const detail = findings.map((f) =>
    `${f.offeringId}: recount over hash-chained log confirmed ${f.confirmed} (claim ${f.theirClaim})` +
    (f.discrepantCalls.length ? `; discrepant calls: ${f.discrepantCalls.join(",")}` : "")).join(" · ");
  return { ...s, resolution: "resolved", resolutionDetail: detail };
}
