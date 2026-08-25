// Calibration telemetry (G10) — Stage 2's raw material, instrumented from
// day one. `nsm calibration export` emits per-period JSON built ONLY from
// the journals both seats already keep; nothing new is measured. Schema in
// docs/CALIBRATION.md; watch-items from the continuation prompt included
// (checkpoint interval statistics + divergence rate, ceiling-hit frequency,
// boundary switch requests).

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allowances, readJournal, readPlans, subsHome } from "./journal.js";
import { readAsks } from "./asks.js";
import { checkpointChain, lastAgreedSeq } from "./checkpoint.js";
import { readStatements } from "./statement.js";
import { pendingSwitches } from "./plan.js";

export interface CalibrationExport {
  schema: "nsm-calibration/1";
  exportedAt: string;
  periods: Array<{
    planId: string; periodId: string; cycle: number; startedAt: string; expiresAt: string;
    volumes: Array<{ offeringId: string; seller: string; unit: string; consumedUnits: number; guaranteedUnits: number }>;
    unusedAllowanceRatio: number;        // Σ unused value ÷ Σ paid value at frozen asks
    ceilingHits: number;                 // exhausted meters this period
    switchRequests: number;              // boundary switches queued
    perKey: Record<string, number>;      // keyId → units (I2's projection)
  }>;
  askDistribution: Array<{ offeringId: string; seller: string; unit: string; askMicroPerUnit: number; effectiveFromCycle: number }>;
  buyerConcentration: { pairs: number; topPairShare: number };  // per-pair share of total units
  statements: { total: number; agreed: number; disputed: number; resolved: number; disputeRate: number };
  checkpoints: Array<{ pair: string; emitted: number; lastAgreedSeq: number; divergenceRate: number }>;
}

export function exportCalibration(home: string, now: Date): CalibrationExport {
  const plans = readPlans(home);
  const j = readJournal(home);

  const periods = plans.map((plan) => {
    const rows = allowances(home, plan);
    const mine = j.filter((e) => e.planId === plan.planId);
    let paid = 0, unused = 0;
    for (const a of plan.allocations) {
      const r = rows.find((x) => x.offeringId === a.offeringId && x.seller === a.seller)!;
      paid += a.allocationMicroTrac;
      unused += Math.max(0, r.guaranteedUnits - r.consumedUnits) * a.frozenAskMicroPerUnit;
    }
    const perKey: Record<string, number> = {};
    for (const e of mine.filter((x) => x.kind === "consumed")) {
      if (e.keyId) perKey[e.keyId] = (perKey[e.keyId] ?? 0) + (e.units ?? 0);
    }
    return {
      planId: plan.planId, periodId: plan.periodId, cycle: plan.cycle,
      startedAt: plan.startedAt, expiresAt: plan.expiresAt,
      volumes: rows.map((r) => ({ offeringId: r.offeringId, seller: r.seller, unit: r.unit,
                                  consumedUnits: r.consumedUnits, guaranteedUnits: r.guaranteedUnits })),
      unusedAllowanceRatio: paid === 0 ? 0 : Math.round((unused / paid) * 1000) / 1000,
      ceilingHits: rows.filter((r) => r.state === "exhausted").length,
      switchRequests: pendingSwitches(home, plan.planId).length,
      perKey,
    };
  });

  // buyer concentration: units per pair across every call log
  const perPair: Record<string, number> = {};
  const sh = subsHome(home);
  for (const f of existsSync(sh) ? readdirSync(sh) : []) {
    const m = f.match(/^calls-(.+)\.jsonl$/);
    if (!m) continue;
    for (const line of readFileSync(join(sh, f), "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(line) as { phase: string; units: number };
      if (e.phase !== "void") perPair[m[1]] = (perPair[m[1]] ?? 0) + e.units;
    }
  }
  const totalUnits = Object.values(perPair).reduce((s, v) => s + v, 0);
  const topPairShare = totalUnits === 0 ? 0
    : Math.round((Math.max(...Object.values(perPair), 0) / totalUnits) * 1000) / 1000;

  const sts = readStatements(home);
  const disputed = sts.filter((s) => s.resolution === "disputed").length;
  const resolved = sts.filter((s) => s.resolution === "resolved").length;

  const checkpoints = Object.keys(perPair).map((pair) => {
    const chain = checkpointChain(home, pair);
    const agreed = lastAgreedSeq(home, pair);
    return { pair, emitted: chain.length, lastAgreedSeq: agreed,
             divergenceRate: chain.length === 0 ? 0 : Math.round(((chain.length - agreed) / chain.length) * 1000) / 1000 };
  });

  return {
    schema: "nsm-calibration/1",
    exportedAt: now.toISOString(),
    periods,
    askDistribution: readAsks(home).map((a) => ({ offeringId: a.offeringId, seller: a.seller, unit: a.unit,
      askMicroPerUnit: a.askMicroPerUnit, effectiveFromCycle: a.effectiveFromCycle })),
    buyerConcentration: { pairs: Object.keys(perPair).length, topPairShare },
    statements: { total: sts.length, agreed: sts.filter((s) => s.resolution === "agreed").length,
                  disputed, resolved,
                  disputeRate: sts.length === 0 ? 0 : Math.round(((disputed + resolved) / sts.length) * 1000) / 1000 },
    checkpoints,
  };
}
