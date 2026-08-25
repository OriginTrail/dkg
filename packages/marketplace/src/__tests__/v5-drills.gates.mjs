// P5 drill suite — Appendix C as automated gates, accumulated as engine
// modules land. Run: node src/__tests__/v5-drills.gates.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIST = new URL("../../dist/", import.meta.url).pathname;
const { appendJournal, allowances, planSummaryPct, checkI2, checkI3, checkI5,
        appendCallLog, verifyCallLogChain, unitTotals } = await import(join(DIST, "subs/journal.js"));
const { buildPlan, purchasePlan, topUp, expirePeriod, requestSwitch, pendingSwitches, nextCycle } = await import(join(DIST, "subs/plan.js"));
const { seedAsk, publishAsk, askInForce, queuedAsk } = await import(join(DIST, "subs/asks.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${n}${c ? "" : ` — ${d ?? ""}`}`); };

const T = mkdtempSync(join(tmpdir(), "v5-"));
const BUYER = "0xBuyer", OKF = "0xOkf", HERMES = "0xHermes";
const now = new Date("2026-08-25T12:00:00Z");

// ── asks: commitments per cycle ────────────────────────────────────────────
console.log("— ask commitments —");
seedAsk(T, { seller: OKF, offeringId: "qwen14b", unit: "tokens", askMicroPerUnit: 0.6, effectiveFromCycle: 1 });
seedAsk(T, { seller: HERMES, offeringId: "qwen7b", unit: "tokens", askMicroPerUnit: 0.30, effectiveFromCycle: 1 });
seedAsk(T, { seller: OKF, offeringId: "okf-knowledge", unit: "query-units", askMicroPerUnit: 15.24, effectiveFromCycle: 1 });
let threw = false;
try { publishAsk(T, { seller: OKF, offeringId: "qwen14b", unit: "tokens", askMicroPerUnit: 0.5, effectiveFromCycle: 1 }, 1); } catch { threw = true; }
ok("D-ask-1 ask change cannot land in the current cycle", threw);
publishAsk(T, { seller: OKF, offeringId: "qwen14b", unit: "tokens", askMicroPerUnit: 0.5, effectiveFromCycle: 2 }, 1);
ok("D-ask-2 queued ask visible as next-cycle, current unchanged",
   askInForce(T, "qwen14b", OKF, 1).askMicroPerUnit === 0.6 && queuedAsk(T, "qwen14b", OKF, 1).askMicroPerUnit === 0.5);
ok("D-ask-3 queued ask takes effect at its cycle", askInForce(T, "qwen14b", OKF, 2).askMicroPerUnit === 0.5);

// ── plan purchase: exact ceilings, one provider per offering ───────────────
console.log("— plan & ceilings —");
const asks = [askInForce(T, "qwen14b", OKF, 1), askInForce(T, "qwen7b", HERMES, 1), askInForce(T, "okf-knowledge", OKF, 1)];
const plan = buildPlan({
  buyer: BUYER, periodMs: 3600_000, cycle: 1, now,
  lines: [
    { offeringId: "qwen14b", seller: OKF, allocationMicroTrac: 2_700_000 },
    { offeringId: "qwen7b", seller: HERMES, allocationMicroTrac: 800_000 },
    { offeringId: "okf-knowledge", seller: OKF, allocationMicroTrac: 100_000 },
  ],
  asks,
  paymentTxBySeller: { [OKF]: "0xtx-okf", [HERMES]: "0xtx-hermes" },
});
purchasePlan(T, plan);
const rows = () => allowances(T, plan);
ok("D-ceil-1 exact ceiling = allocation ÷ frozen ask (14B)", rows()[0].guaranteedUnits === Math.floor(2_700_000 / 0.6));
ok("D-ceil-2 exact ceiling (7B via hermes, ONE provider)", rows()[1].guaranteedUnits === Math.floor(800_000 / 0.30) && rows()[1].seller === HERMES);
ok("D-ceil-3 query ceiling in query units", rows()[2].guaranteedUnits === Math.floor(100_000 / 15.24) && rows()[2].unit === "query-units");
let missing = false;
try {
  buildPlan({ buyer: BUYER, periodMs: 1, cycle: 1, now, lines: [{ offeringId: "qwen14b", seller: OKF, allocationMicroTrac: 1 }], asks, paymentTxBySeller: {} });
} catch { missing = true; }
ok("D-pay-1 no plan without one payment per subscribed seller (I4 shape)", missing);

// ── separate meters (I5): decrements never cross offerings ─────────────────
console.log("— separate meters —");
appendJournal(T, { kind: "consumed", at: now.toISOString(), planId: plan.planId, offeringId: "qwen14b", seller: OKF, units: 1000, keyId: "k1" });
appendJournal(T, { kind: "consumed", at: now.toISOString(), planId: plan.planId, offeringId: "okf-knowledge", seller: OKF, units: 41, keyId: "k1" });
ok("D-sep-1 inference decrements only its model's meter",
   rows()[0].consumedUnits === 1000 && rows()[1].consumedUnits === 0);
ok("D-sep-2 a query decrements only the knowledge meter", rows()[2].consumedUnits === 41);
let i5threw = false;
try { appendJournal(T, { kind: "consumed", at: now.toISOString(), planId: plan.planId, units: 5 }); } catch { i5threw = true; }
ok("D-sep-3 I5 structural: consumed without a single allowance ref is unwritable", i5threw);
ok("D-sep-4 I5 check clean", checkI5(T).ok);
ok("D-sep-5 plan summary is a display aggregate (34-ish %, not a limit)",
   planSummaryPct(T, plan) === Math.round(((1000 * 0.6 + 41 * 15.24) / 3_600_000) * 100));

// ── one ceiling hit leaves the others usable ───────────────────────────────
appendJournal(T, { kind: "consumed", at: now.toISOString(), planId: plan.planId, offeringId: "qwen7b", seller: HERMES, units: Math.floor(800_000 / 0.30), keyId: "k1" });
ok("D-sep-6 one exhausted meter, others active",
   rows()[1].state === "exhausted" && rows()[0].state === "active" && rows()[2].state === "active");

// ── top-up extends, refunds nowhere ────────────────────────────────────────
console.log("— top-up & expiry doctrine —");
const added = topUp(T, plan, "qwen7b", HERMES, 300_000, "0xtx-topup", now);
ok("D-top-1 top-up extends the one ceiling", added === Math.floor(300_000 / 0.30) && rows()[1].state === "active");
const srcJournal = (await import(join(DIST, "subs/journal.js"))).readJournal(T);
ok("D-top-2 nothing refund-shaped exists in the journal vocabulary",
   srcJournal.every((e) => ["paid", "consumed", "expired", "toppedUp", "disputed"].includes(e.kind)));

// ── period end: expiry journaled, nothing renews ───────────────────────────
let early = false;
try { expirePeriod(T, plan, now); } catch { early = true; }
ok("D-exp-1 cannot expire an active period", early);
const later = new Date(now.getTime() + 3600_001);
const { expiredMicroTrac } = expirePeriod(T, plan, later);
ok("D-exp-2 remainder expires with explicit journal entries, value recognized", expiredMicroTrac > 0);
ok("D-exp-3 meters enter expired state", rows().every((r) => r.state === "expired"));
ok("D-exp-4 expiry idempotent (nothing double-expires)", expirePeriod(T, plan, later).expiredMicroTrac === 0);
ok("D-exp-5 I3 holds on the closed cycle", checkI3(T, plan).ok, checkI3(T, plan).detail);
ok("D-exp-6 no auto-renewal machinery: next cycle is only a number", nextCycle(T) === 2);
ok("D-exp-7 I2 key-conservation holds", checkI2(T, plan).ok, checkI2(T, plan).detail);

// ── provider switch lands only at the boundary ─────────────────────────────
requestSwitch(T, plan, "qwen7b", OKF, later);
ok("D-switch-1 switch recorded for next cycle, not executed", pendingSwitches(T, plan.planId).length === 1
   && pendingSwitches(T, plan.planId)[0].toSeller === OKF);

// ── hash-chained call log ──────────────────────────────────────────────────
console.log("— call-log chain —");
const pair = "0xbuyer~0xokf";
appendCallLog(T, { callId: "c1", at: now.toISOString(), pair, offeringId: "qwen14b", unit: "tokens", units: 500, phase: "delivery", requestDigest: "sha256:r1", responseDigest: "sha256:x1", keyId: "k1" });
appendCallLog(T, { callId: "c2", at: now.toISOString(), pair, offeringId: "okf-knowledge", unit: "query-units", units: 41, phase: "admission", requestDigest: "sha256:r2", keyId: "k1" });
appendCallLog(T, { callId: "c3", at: now.toISOString(), pair, offeringId: "qwen14b", unit: "tokens", units: 700, phase: "void", requestDigest: "sha256:r3" });
ok("D-log-1 chain verifies end to end", verifyCallLogChain(T, pair).ok);
const totals = unitTotals(T, pair);
ok("D-log-2 void (undelivered) counts nothing on either side", totals["qwen14b"] === 500);
ok("D-log-3 running totals per offering (checkpoint substrate)", totals["okf-knowledge"] === 41);

// ── query cost schedule (G19) ──────────────────────────────────────────────
console.log("— query cost schedule —");
const { SCHEDULE_V1, scheduleDigest, analyzeQuery, admissionUnits, deliveryUnits, unitsForOutcome } = await import(join(DIST, "subs/query-cost.js"));
ok("D-q-1 schedule is content-addressed and stable",
   scheduleDigest(SCHEDULE_V1) === scheduleDigest({ ...SCHEDULE_V1 }));
ok("D-q-2 digest changes when any term changes",
   scheduleDigest(SCHEDULE_V1) !== scheduleDigest({ ...SCHEDULE_V1, base: 3 }));
const simple = "SELECT ?s WHERE { ?s <p> ?o . } LIMIT 20";
const heavy = `SELECT ?a (COUNT(?c) AS ?n) WHERE {
  ?a <p1> ?b . ?b <p2>/<p3> ?c . OPTIONAL { ?c <p4> ?d . }
  ?a <p5> ?e . FILTER(?e > 5) } GROUP BY ?a`;
ok("D-q-3 aggregation-heavy query costs visibly more than a simple lookup",
   admissionUnits(heavy) > admissionUnits(simple) * 3, `${admissionUnits(heavy)} vs ${admissionUnits(simple)}`);
ok("D-q-4 missing LIMIT carries the surcharge",
   admissionUnits("SELECT ?s WHERE { ?s <p> ?o . }") === admissionUnits(simple) + SCHEDULE_V1.missingLimitSurcharge);
ok("D-q-5 both seats compute identical units from identical bytes",
   admissionUnits(heavy) === admissionUnits(heavy) && JSON.stringify(analyzeQuery(heavy)) === JSON.stringify(analyzeQuery(heavy)));
const delivered = unitsForOutcome(simple, { kind: "delivered", rows: 200 });
const aborted = unitsForOutcome(heavy, { kind: "aborted", reason: "scan-budget" });
ok("D-q-6 delivery adds per-returned-result weight", delivered.total === delivered.admission + deliveryUnits(200));
ok("D-q-7 guard-aborted query keeps ONLY its admission cost", aborted.delivery === 0 && aborted.total === aborted.admission && aborted.total > 0);

console.log(`\n${pass}/${pass + fail} v5 core drills pass`);
process.exit(fail ? 1 : 0);
