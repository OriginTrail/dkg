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

// ── checkpoints: cadence, divergence narrowing, freshness (G16) ────────────
console.log("— checkpoints —");
const { DEFAULT_CADENCE, jitteredThresholds, noteBillableCall, emitCheckpoint, checkpointChain,
        verifyPeerCheckpoint, lastAgreedSeq, freshness, chainRoot } = await import(join(DIST, "subs/checkpoint.js"));
const { mkdtempSync: mkT } = await import("node:fs");
const B = mkT(join((await import("node:os")).tmpdir(), "v5b-"));   // buyer seat
const S = mkT(join((await import("node:os")).tmpdir(), "v5s-"));   // seller seat
const PAIR = "0xbuyer~0xseller", PERIOD = "p-test", P0 = "2026-08-25T12:00:00.000Z";

const th = jitteredThresholds(PAIR, DEFAULT_CADENCE);
ok("D-ck-1 jitter is deterministic per pair and within ±20%",
   th.calls === jitteredThresholds(PAIR, DEFAULT_CADENCE).calls
   && th.calls >= 80 && th.calls <= 120 && th.activeMs >= 12*60000 && th.activeMs <= 18*60000);

// both seats log identical calls; cadence fires on the jittered call count
const compressed = { everyCalls: 5, everyActiveMs: 60_000, jitterPct: 0.2 };
const cth = jitteredThresholds(PAIR, compressed);
let fired = 0;
for (let i = 0; i < cth.calls; i++) {
  for (const seat of [B, S]) appendCallLog(seat, { callId: `q${i}`, at: P0, pair: PAIR, offeringId: "qwen14b", unit: "tokens", units: 10, phase: "delivery", requestDigest: `sha256:${i}`, responseDigest: `sha256:x${i}` });
  if (noteBillableCall(B, PAIR, new Date(P0), compressed)) fired++;
}
ok("D-ck-2 cadence fires exactly once at the jittered call threshold (compressed-period scaling)", fired === 1);

const cpB = emitCheckpoint(B, { pair: PAIR, periodId: PERIOD, periodStartAt: P0, now: new Date(P0) });
const vS = verifyPeerCheckpoint(S, cpB, { periodStartAt: P0 });
ok("D-ck-3 identical logs → checkpoints agree; agreement recorded", vS.kind === "agree" && lastAgreedSeq(S, PAIR) === 1);
ok("D-ck-4 freshness line feed: agree ✓ with a checked-ago age", freshness(S, PAIR, new Date("2026-08-25T12:04:00Z")).agree === true);

// seller inflates: 90 extra units logged only on the seller seat
appendCallLog(S, { callId: "inflate", at: P0, pair: PAIR, offeringId: "qwen14b", unit: "tokens", units: 90, phase: "delivery", requestDigest: "sha256:inf", responseDigest: "sha256:infx" });
const cpS = emitCheckpoint(S, { pair: PAIR, periodId: PERIOD, periodStartAt: P0, now: new Date(P0) });
const vB = verifyPeerCheckpoint(B, cpS, { periodStartAt: P0 });
ok("D-ck-5 divergence flagged within ONE checkpoint interval, scope = that interval",
   vB.kind === "diverged" && vB.offerings.includes("qwen14b") && vB.interval.fromSeq === lastAgreedSeq(B, PAIR) + 1);

// ── statements + dispute + I6 (G8) ─────────────────────────────────────────
console.log("— statements & dispute —");
const { seatTotals, buildStatement, statementDigest, saveStatement, checkI6, recountInterval, resolveStatement } = await import(join(DIST, "subs/statement.js"));
const stClean = buildStatement({ home: B, pair: PAIR, periodId: PERIOD, periodStartAt: P0,
  ours: seatTotals(B, PAIR, P0), theirs: seatTotals(B, PAIR, P0) });
ok("D-st-1 identical counts → agreed statement referencing the checkpoint chain root",
   stClean.resolution === "agreed" && stClean.checkpointChainRoot === chainRoot(B, PAIR));
const stBad = buildStatement({ home: B, pair: PAIR, periodId: PERIOD, periodStartAt: P0,
  ours: seatTotals(B, PAIR, P0), theirs: seatTotals(S, PAIR, P0) });
ok("D-st-2 inflated seller count → reconciliation fails (disputed)", stBad.resolution === "disputed");
const sellerLog = (await import(join(DIST, "subs/journal.js"))).readCallLog(S, PAIR);
const finding = recountInterval(B, { pair: PAIR, periodStartAt: P0, offeringId: "qwen14b",
  theirClaim: seatTotals(S, PAIR, P0).totals["qwen14b"], theirCalls: sellerLog });
ok("D-st-3 per-call recount confirms our count and names the discrepant call",
   finding.verdict === "our-count-confirmed" && finding.discrepantCalls.includes("inflate"));
const stResolved = resolveStatement(stBad, [finding]);
ok("D-st-4 resolution recorded IN the statement, digest changes with it",
   stResolved.resolution === "resolved" && statementDigest(stResolved) !== statementDigest(stBad));
saveStatement(B, stResolved);

// I6 cadence cost audit
ok("D-i6-1 clean path: exactly one statement KA per pair per period",
   checkI6([{ pair: PAIR, periodId: PERIOD, kind: "statement" }], [{ pair: PAIR, periodId: PERIOD }]).ok);
ok("D-i6-2 a checkpoint reaching VM fails the audit",
   !checkI6([{ pair: PAIR, periodId: PERIOD, kind: "statement" }, { pair: PAIR, periodId: PERIOD, kind: "checkpoint" }], [{ pair: PAIR, periodId: PERIOD }]).ok);
ok("D-i6-3 interim publish on a CLEAN period fails; on a divergent one it is allowed",
   !checkI6([{ pair: PAIR, periodId: PERIOD, kind: "statement" }, { pair: PAIR, periodId: PERIOD, kind: "interim-dispute" }], [{ pair: PAIR, periodId: PERIOD }]).ok
   && checkI6([{ pair: PAIR, periodId: PERIOD, kind: "statement" }, { pair: PAIR, periodId: PERIOD, kind: "interim-dispute" }], []).ok);

// ── gateway admission: 402 fork, no-fallback, both-sides hooks (G22) ───────
console.log("— gateway admission —");
const { admit, recordDelivery, recordProviderFailure } = await import(join(DIST, "subs/gateway.js"));
const G = mkT(join((await import("node:os")).tmpdir(), "v5g-"));
seedAsk(G, { seller: OKF, offeringId: "qwen14b", unit: "tokens", askMicroPerUnit: 0.6, effectiveFromCycle: 1 });
seedAsk(G, { seller: OKF, offeringId: "okf-knowledge", unit: "query-units", askMicroPerUnit: 15.24, effectiveFromCycle: 1 });
const gasks = [askInForce(G, "qwen14b", OKF, 1), askInForce(G, "okf-knowledge", OKF, 1)];
const gplan = buildPlan({ buyer: BUYER, periodMs: 3600_000, cycle: 1, now,
  lines: [ { offeringId: "qwen14b", seller: OKF, allocationMicroTrac: 600 },
           { offeringId: "okf-knowledge", seller: OKF, allocationMicroTrac: 152_400 } ],
  asks: gasks, paymentTxBySeller: { [OKF]: "0xgtx" } });
purchasePlan(G, gplan);

ok("D-gw-1 no plan → 402 with start-new-period fork", admit(G, { plan: null, offeringId: "qwen14b" }).body?.error === "no_active_plan");
const adm = admit(G, { plan: gplan, offeringId: "qwen14b" });
ok("D-gw-2 active ceiling admits and names the ONE chosen provider", adm.ok === true && adm.allowance.seller === OKF);

recordDelivery(G, { plan: gplan, allowance: adm.allowance, callId: "g1", units: 900, unit: "tokens",
  requestDigest: "sha256:g1", responseDigest: "sha256:g1x", keyId: "kA", now });
recordDelivery(G, { plan: gplan, allowance: adm.allowance, callId: "g2", units: 100, unit: "tokens",
  requestDigest: "sha256:g2", responseDigest: "sha256:g2x", keyId: "kA", now });
const adm2 = admit(G, { plan: gplan, offeringId: "qwen14b" });
ok("D-gw-3 exhausted ceiling → 402 fork: topUp + switch (NO wait option in the body)",
   adm2.ok === false && adm2.body.fork.topUp === true && !("wait" in adm2.body.fork)
   && adm2.body.fork.switch.some((s) => s.offeringId === "okf-knowledge" && s.pctLeft === 100));
ok("D-gw-4 the other meter stays usable after one ceiling hit", admit(G, { plan: gplan, offeringId: "okf-knowledge" }).ok === true);

const qadm = admit(G, { plan: gplan, offeringId: "okf-knowledge" });
const failure = recordProviderFailure(G, { plan: gplan, allowance: qadm.allowance, callId: "gf", unit: "query-units",
  requestDigest: "sha256:gf", now, reason: "connect ECONNREFUSED" });
ok("D-gw-5 provider failure charges NOTHING and says so (no fallback attempted)",
   failure.status === 502 && failure.body.charged === 0 && /charged nothing/.test(failure.body.detail));
ok("D-gw-6 failure did not decrement the meter",
   admit(G, { plan: gplan, offeringId: "okf-knowledge" }).allowance.consumedUnits === 0);
ok("D-gw-7 I2/I5 hold after gateway traffic", checkI2(G, gplan).ok && checkI5(G).ok);

// ── kill-list + probe sweep (rule 2 absolute; G13/G22) ─────────────────────
console.log("— kill-list & probes —");
const { readdirSync, existsSync: fsx, readFileSync: rfx } = await import("node:fs");
const SRC = new URL("../../src/", import.meta.url).pathname;
const DELETED = ["core/deposit-rail.ts", "core/ledger.ts", "core/inference-quote.ts",
  "seller/front.ts", "seller/tabs.ts", "seller/lifecycle.ts",
  "buyer/actions.ts", "buyer/client.ts", "gateway/router.ts", "lane/client.ts", "lane/executor.ts"];
ok("D-kill-1 every tab-rail module is physically deleted", DELETED.every((f) => !fsx(join(SRC, f))));

function allSrc(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__tests__" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...allSrc(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}
const srcFiles = allSrc(SRC);
const refundish = srcFiles.filter((f) => /\brefund|withdraw(al)?\b|\bsettle(ment)?\b/i.test(rfx(f, "utf8"))
  && !/tab-rail deletion|nothing here refunds|refunds nowhere|refund-shaped|have no handlers/.test(rfx(f, "utf8")));
ok("D-kill-2 nothing refund-shaped survives in src (comment-acknowledged mentions only)",
   refundish.length === 0, refundish.join(", "));
const pluginSrc = rfx(join(SRC, "plugin.ts"), "utf8");
const TABPATHS = ["/tab", "/deposit", "/refund", "/withdraw", "/settle", "/credit", "/release"];
ok("D-kill-3 plugin registers NO handler for any tab-rail path",
   TABPATHS.every((p) => !pluginSrc.includes(`BASE + "${p}`)));
ok("D-kill-4 no auto-renewal or reset scheduling anywhere",
   srcFiles.every((f) => !/setInterval[^)]*renew|autoRenew|\brenewPlan\b/i.test(rfx(f, "utf8"))));

// data-copy probe rides along (rider 2 made it part of the fixture suite)
const { execFileSync } = await import("node:child_process");
let probeOk = true;
try { execFileSync(process.execPath, [join(SRC, "../../..", "docs/ui-spec/mockups/p5/copy-probe.mjs")], { stdio: "pipe" }); }
catch { probeOk = false; }
ok("D-copy-1 zero unkeyed strings in the runthrough (copy-probe)", probeOk);

// ── registry, pair CG, calibration (G10/G17/G18) ───────────────────────────
console.log("— registry & calibration —");
const { buildScheduleKaQuads } = await import(join(DIST, "subs/registry.js"));
const { buildOfferingQuads } = await import(join(DIST, "seller/offering.js"));
const { pairId, pairCgId } = await import(join(DIST, "subs/pair-cg.js"));
const { exportCalibration } = await import(join(DIST, "subs/calibration.js"));

const skq = buildScheduleKaQuads(SCHEDULE_V1);
ok("D-reg-1 schedule KA is content-addressed and carries every term",
   skq.urn === `urn:nsm:query-schedule:${scheduleDigest(SCHEDULE_V1)}`
   && skq.quads.filter((q) => q.predicate.includes("per") || q.predicate.includes("base")).length >= 8);

const fakeOb = { offering: { id: "qwen14b", provenanceClass: "weights-pinned",
    perInputTokenMicroTrac: 0, perOutputTokenMicroTrac: 0, queryFlatMicroTrac: 0, perReturnedQuadMicroTrac: 0,
    connector: { kind: "llamacpp" } },
  binding: { kind: "llamacpp", modelId: "qwen14b", ggufSha256: "sha256:w", tokenizerBundleDigest: "sha256:t",
    tokenizerFiles: {}, settings: { seed: 42, temperature: 0, ctx: 4096 } },
  tokenizerBundleRef: "sha256:t" };
const oq = buildOfferingQuads(fakeOb, { providerAddress: OKF, apiBase: "http://x", chainId: 31337,
  ask: { askMicroPerUnit: 0.6, unit: "tokens", effectiveFromCycle: 1 },
  revenueWallet: "0xRev", queryCostScheduleRef: skq.urn, cycle: 3 });
const preds = oq.quads.map((q) => q.predicate);
ok("D-reg-2 offer KA carries committed ask + revenue wallet + subs endpoints",
   preds.some((p) => p.endsWith("askMicroPerUnit")) && preds.some((p) => p.endsWith("revenueWallet"))
   && preds.some((p) => p.endsWith("enrollEndpoint")));
ok("D-reg-3 offer KA carries NO tab-rail endpoints",
   !preds.some((p) => /tabOpen|quoteEndpoint/.test(p)));
ok("D-reg-4 ask updates get a per-cycle KA name (republish-clean)", oq.ka === "nsm-offering-qwen14b-c3");

ok("D-pair-1 pair CG name is derived — both seats agree without coordination",
   pairCgId(pairId("0xB", "0xS")) === pairCgId(pairId("0xb", "0xs"))
   && pairCgId(pairId("0xB", "0xS")).startsWith("nsm-pair-"));

const cal = exportCalibration(G, new Date("2026-08-25T13:00:00Z"));
ok("D-cal-1 calibration export: schema + per-period volumes in native units",
   cal.schema === "nsm-calibration/1" && cal.periods.length === 1
   && cal.periods[0].volumes.some((v) => v.offeringId === "qwen14b" && v.consumedUnits === 1000));
ok("D-cal-2 ceiling-hit + per-key watch-items present",
   cal.periods[0].ceilingHits === 1 && cal.periods[0].perKey["kA"] === 1000);
ok("D-cal-3 ask distribution + concentration + statements fields populated",
   cal.askDistribution.length >= 2 && typeof cal.buyerConcentration.topPairShare === "number"
   && typeof cal.statements.disputeRate === "number");

// ── config loader preserves the P5 fields (bug #2's class, regression) ─────
console.log("— config loader —");
const { loadMarketplaceConfig } = await import(join(DIST, "config.js"));
const CT = mkT(join((await import("node:os")).tmpdir(), "v5c-"));
const { mkdirSync: mkd, writeFileSync: wfx } = await import("node:fs");
mkd(join(CT, "marketplace"), { recursive: true });
wfx(join(CT, "marketplace/config.json"), JSON.stringify({ enabled: true, offerings: [],
  revenueWallet: "0xRev", registryContextGraphId: "nsm-registry", confirmationDepth: 1 }));
const lc = loadMarketplaceConfig(CT);
ok("D-cfg-1 loader preserves revenueWallet/registryCG/confirmationDepth",
   lc.revenueWallet === "0xRev" && lc.registryContextGraphId === "nsm-registry" && lc.confirmationDepth === 1);

console.log(`\n${pass}/${pass + fail} v5 core drills pass`);
process.exit(fail ? 1 : 0);
