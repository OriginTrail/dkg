// P5 Phase 4 — Appendix-C drills over the LIVE devnet pair (compressed
// periods). Every drill asserts over the wire; the log is the evidence.
// Usage: node scripts/phase4-drills.mjs [evidenceDir]
import { createRequire } from "node:module";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const require = createRequire(new URL("../package.json", import.meta.url).pathname);
const { JsonRpcProvider, Wallet, Contract } = require("ethers");

const EV = process.argv[2] ?? `${process.env.HOME}/odysseus-dkg-proto/nsm-v5-evidence/phase4`;
mkdirSync(EV, { recursive: true });
const LOG = join(EV, "drill-log.jsonl");
let pass = 0, fail = 0;
const drill = (id, name, ok, evidence = {}) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} [${id}] ${name}`);
  appendFileSync(LOG, JSON.stringify({ id, name, pass: !!ok, evidence, at: new Date().toISOString() }) + "\n");
};

const RPC = new JsonRpcProvider("http://127.0.0.1:8545");
const TOKEN = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const DEPLOYER = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", RPC);
const BUYER = new Wallet("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", RPC);
const SELLER = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";
const REVENUE = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";
const N1 = "http://127.0.0.1:9201", N2 = "http://127.0.0.1:9202";
const N1HOME = `${process.env.HOME}/odysseus-dkg-proto/dkg-v35/.devnet/node1/marketplace`;
const N2HOME = `${process.env.HOME}/odysseus-dkg-proto/dkg-v35/.devnet/node2/marketplace`;
const abi = ["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];
const PAIR = `${BUYER.address.toLowerCase()}~${SELLER.toLowerCase()}`;

const http = async (base, path, init = {}) => {
  const res = await fetch(base + path, { headers: { "content-type": "application/json" }, ...init,
    signal: AbortSignal.timeout(init.timeout ?? 120_000) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const post = (base, path, body, timeout) => http(base, path, { method: "POST", body: JSON.stringify(body), timeout });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the operator-implicit key enforces an rps ceiling (E_RPS) — a real guard;
// the harness paces gateway calls under it
const gw = async (path, body, timeout) => { await sleep(1200); return post(N2, path, body, timeout); };

async function pay(trac) {
  const tokB = new Contract(TOKEN, abi, BUYER);
  const nonce = await RPC.getTransactionCount(BUYER.address, "pending");
  const rc = await (await tokB.transfer(REVENUE, BigInt(trac) * 10n ** 18n, { nonce })).wait();
  const log = rc.logs.find((l) => l.address.toLowerCase() === TOKEN.toLowerCase());
  return { txHash: rc.hash, from: BUYER.address, to: REVENUE, token: TOKEN, amountTrac: String(trac),
    blockNumber: rc.blockNumber, safeHeadBlock: Math.max(rc.blockNumber, await RPC.getBlockNumber()),
    chainId: 31337, logIndex: log.index };
}

const ASKS = [
  { seller: SELLER, offeringId: "qwen7b", unit: "tokens", askMicroPerUnit: 0.5, effectiveFromCycle: 1 },
  { seller: SELLER, offeringId: "devnet-knowledge", unit: "query-units", askMicroPerUnit: 15, effectiveFromCycle: 1 },
];

async function newPlan(lines, periodMs, transfer) {
  const { body } = await post(N2, "/marketplace/subs/plan", {
    buyer: BUYER.address, periodMs, lines, asks: ASKS, paymentTxBySeller: { [SELLER]: transfer.txHash } });
  const enr = await post(N1, "/marketplace/subs/enroll", { plan: body.plan, transfer });
  return { plan: body.plan, enrolled: enr.body.ok === true, enrollDetail: enr.body };
}

// FRESH SEATS: the drills own the devnet pair — wipe subscription state on
// both seats (daemons read files per request; no in-memory state to bounce)
// and reseed the asks, so every run starts from the same ground truth.
const { rmSync } = await import("node:fs");
globalThis.__rmSync = rmSync;
for (const h of [N1HOME, N2HOME]) rmSync(join(h, "subscriptions"), { recursive: true, force: true });
await post(N1, "/marketplace/operate/ask", { offeringId: "qwen7b", unit: "tokens", askMicroPerUnit: 0.5, effectiveFromCycle: 1, currentCycle: 1, seed: true });
await post(N1, "/marketplace/operate/ask", { offeringId: "devnet-knowledge", unit: "query-units", askMicroPerUnit: 15, effectiveFromCycle: 1, currentCycle: 1, seed: true });

// fund buyer once
await (await new Contract(TOKEN, abi, DEPLOYER).transfer(BUYER.address, 50n * 10n ** 18n)).wait();

// ═══ Drill 1 — separate meters + ceiling hit → 402 fork (top up / switch) ═══
console.log("— D1 separate meters & the fork —");
{
  const t = await pay(1);
  // tiny qwen ceiling (200 tokens) + healthy knowledge ceiling
  const { plan, enrolled } = await newPlan([
    { offeringId: "qwen7b", seller: SELLER, allocationMicroTrac: 20 },          // 40 tokens — 2 calls exhaust it
    { offeringId: "devnet-knowledge", seller: SELLER, allocationMicroTrac: 150_000 },
  ], 30 * 60_000, t);
  drill("D1a", "plan enrolled (payment verified at SAFE head)", enrolled, { plan: plan.planId, tx: t.txHash });

  let forked = null;
  const attempts = [];
  for (let i = 0; i < 8 && !forked; i++) {
    const r = await gw("/marketplace/gateway/v1/chat/completions",
      { model: "qwen7b", max_tokens: 64, messages: [{ role: "user", content: `Say ${i} words about graphs.` }] }, 300_000);
    attempts.push({ status: r.status, err: r.body?.error, units: r.body?.nsm?.units });
    if (r.status === 402) forked = r.body;
  }
  drill("D1b", "ceiling hit → 402 fork with topUp + switch, NO wait field",
    forked && forked.fork?.topUp === true && !("wait" in (forked.fork ?? {}))
    && forked.fork.switch.some((s) => s.offeringId === "devnet-knowledge"), { fork: forked?.fork, attempts });
  const q = await gw("/marketplace/gateway/v1/query",
    { offeringId: "devnet-knowledge", sparql: "SELECT ?s WHERE { ?s ?p ?o . } LIMIT 2" });
  drill("D1c", "one ceiling hit leaves the other meter usable", q.status === 200 && q.body.units > 0, { units: q.body.units });

  // top-up extends, refunds nowhere
  const t2 = await pay(1);
  const tu = await post(N2, "/marketplace/subs/topup", { offeringId: "qwen7b", seller: SELLER, microTrac: 1_000_000, tx: t2.txHash, transfer: t2 });
  const chat = await gw("/marketplace/gateway/v1/chat/completions",
    { model: "qwen7b", max_tokens: 32, messages: [{ role: "user", content: "One word: hello?" }] }, 300_000);
  drill("D1d", "top-up extends the one ceiling; serving resumes", tu.body.addedUnits === 2_000_000 && chat.status === 200,
    { added: tu.body.addedUnits, chatStatus: chat.status, chatBody: chat.body });

  // ═══ Drill 2 — checkpoint cadence + divergence narrowed to an interval ═══
  console.log("— D2 checkpoints —");
  for (let i = 0; i < 3; i++) {
    await gw("/marketplace/gateway/v1/query",
      { offeringId: "devnet-knowledge", sparql: `SELECT ?s WHERE { ?s ?p ?o . } LIMIT ${2 + i}` });
  }
  const ck1 = await http(N1, `/marketplace/subs/checkpoints?pair=${PAIR}`);
  drill("D2a", "seller emitted a signed checkpoint at the compressed cadence (3 calls)",
    ck1.body.chain?.length >= 1 && !!ck1.body.chain[ck1.body.chain.length - 1].signature,
    { emitted: ck1.body.chain?.length });
  const latest = ck1.body.chain[ck1.body.chain.length - 1];
  const v1 = await post(N2, "/marketplace/subs/checkpoint", { checkpoint: latest, periodStartAt: plan.startedAt });
  drill("D2b", "buyer verified the peer checkpoint: counts agree", v1.body.kind === "agree", v1.body);
  const fresh = await http(N2, "/marketplace/subs/status");
  drill("D2c", "freshness line feed live on the buyer (Counts agree ✓)",
    fresh.body.freshness?.some((f) => f.agree === true), { freshness: fresh.body.freshness });

  // seller inflates: a call logged only on the seller seat
  const callsFile = join(N1HOME, "subscriptions", `calls-${PAIR}.jsonl`);
  const lines = readFileSync(callsFile, "utf8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  const crypto = await import("node:crypto");
  const body = { callId: "inflate-p4", at: new Date().toISOString(), pair: PAIR, offeringId: "qwen7b",
    unit: "tokens", units: 5000, phase: "delivery", requestDigest: "sha256:inflate", responseDigest: "sha256:inflatex",
    keyId: "wire", prevDigest: last.digest };
  const digest = "sha256:" + crypto.createHash("sha256").update(last.digest + JSON.stringify(body)).digest("hex");
  appendFileSync(callsFile, JSON.stringify({ ...body, digest }) + "\n");
  for (let i = 0; i < 3; i++) {
    await gw("/marketplace/gateway/v1/query",
      { offeringId: "devnet-knowledge", sparql: `SELECT ?s WHERE { ?s ?p ?o . } LIMIT ${4 + i}` });
  }
  const ck2 = await http(N1, `/marketplace/subs/checkpoints?pair=${PAIR}`);
  const inflated = ck2.body.chain[ck2.body.chain.length - 1];
  const v2 = await post(N2, "/marketplace/subs/checkpoint", { checkpoint: inflated, periodStartAt: plan.startedAt });
  drill("D2d", "divergence flagged within ONE checkpoint interval, offenders named",
    v2.body.kind === "diverged" && v2.body.offerings.includes("qwen7b")
    && v2.body.interval.toSeq === inflated.seq, v2.body.interval);

  // ═══ Drill 3 — statement mismatch → dispute → resolution recorded ═══
  console.log("— D3 statements —");
  const sellerTotals = inflated.totals;
  const stmt = await post(N1, "/marketplace/subs/statement", {
    pair: PAIR, periodId: plan.periodId, periodStartAt: plan.startedAt,
    theirTotals: v2.body.ours, theirUnits: { qwen7b: "tokens", "devnet-knowledge": "query-units" } });
  drill("D3a", "inflated seller count → reconciliation fails (disputed statement)",
    stmt.body.statement?.resolution === "disputed", { items: stmt.body.statement?.items });
  // buyer-side dispute: recount over the seller's shared chained log
  const DIST = new URL("../dist/", import.meta.url).pathname;
  const { recountInterval, resolveStatement, statementDigest } = await import(join(DIST, "subs/statement.js"));
  const sellerLog = readFileSync(callsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const finding = recountInterval(N2HOME, { pair: PAIR, periodStartAt: plan.startedAt, offeringId: "qwen7b",
    theirClaim: sellerTotals["qwen7b"], theirCalls: sellerLog });
  drill("D3b", "per-call recount confirms the buyer count and NAMES the injected call",
    finding.verdict === "our-count-confirmed" && finding.discrepantCalls.includes("inflate-p4"),
    { discrepant: finding.discrepantCalls, confirmed: finding.confirmed, claim: finding.theirClaim });
  const resolved = resolveStatement(stmt.body.statement, [finding]);
  const rec = await post(N2, "/marketplace/subs/statement/record", resolved);
  drill("D3c", "resolution recorded in the statement on the buyer seat",
    rec.body.ok === true && resolved.resolution === "resolved", { digest: rec.body.digest });
  void statementDigest;

  // ═══ Drill 4 — ask change lands only at next cycle ═══
  console.log("— D4 ask commitment —");
  const askNow = await post(N1, "/marketplace/operate/ask",
    { offeringId: "qwen7b", unit: "tokens", askMicroPerUnit: 0.4, effectiveFromCycle: 1, currentCycle: 1 });
  const askNext = await post(N1, "/marketplace/operate/ask",
    { offeringId: "qwen7b", unit: "tokens", askMicroPerUnit: 0.4, effectiveFromCycle: 2, currentCycle: 1 });
  const offers = await http(N1, "/marketplace/subs/offers");
  const q7 = offers.body.offers.find((o) => o.offeringId === "qwen7b");
  drill("D4a", "current-cycle ask edit refused; queued ask visible, current unchanged",
    askNow.status === 400 && askNext.status === 200
    && q7.ask.askMicroPerUnit === 0.5 && q7.queuedAsk?.askMicroPerUnit === 0.4, { ask: q7.ask, queued: q7.queuedAsk });
  // the seller advances ITS pricing cycle → the queued ask becomes the advertised one,
  // while the existing subscriber keeps its frozen 0.5 to period end
  await post(N1, "/marketplace/operate/cycle/advance", {});
  const offers2 = await http(N1, "/marketplace/subs/offers");
  const q7b = offers2.body.offers.find((o) => o.offeringId === "qwen7b");
  const frozen = (await http(N2, "/marketplace/subs/status")).body.plan.allocations.find((a) => a.offeringId === "qwen7b");
  drill("D4b", "cycle advance: queued ask now advertised; existing subscriber keeps the frozen price",
    q7b.ask.askMicroPerUnit === 0.4 && frozen.frozenAskMicroPerUnit === 0.5, { advertised: q7b.ask, frozen: frozen.frozenAskMicroPerUnit });
  // reset the pricing for the rest of the sweep: queue 0.5 at cycle 3 and advance again
  await post(N1, "/marketplace/operate/ask", { offeringId: "qwen7b", unit: "tokens", askMicroPerUnit: 0.5, effectiveFromCycle: 3 });
  await post(N1, "/marketplace/operate/cycle/advance", {});

  // ═══ Drill 5 — provider failure charges nothing (no fallback) ═══
  console.log("— D5 provider offline —");
  const before = (await http(N2, "/marketplace/subs/status")).body.meters.find((m) => m.offeringId === "qwen7b");
  // point the buyer at a dead endpoint to simulate the chosen provider offline
  const bc = JSON.parse(readFileSync(join(N2HOME, "subs-buyer.json"), "utf8"));
  const orig = bc.sellers[SELLER].apiBase;
  bc.sellers[SELLER].apiBase = "http://127.0.0.1:59999";
  writeFileSync(join(N2HOME, "subs-buyer.json"), JSON.stringify(bc, null, 2));
  const dead = await gw("/marketplace/gateway/v1/chat/completions",
    { model: "qwen7b", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }, 60_000);
  bc.sellers[SELLER].apiBase = orig;
  writeFileSync(join(N2HOME, "subs-buyer.json"), JSON.stringify(bc, null, 2));
  const after = (await http(N2, "/marketplace/subs/status")).body.meters.find((m) => m.offeringId === "qwen7b");
  drill("D5a", "chosen provider offline → 502, charged 0, says so, NO fallback",
    dead.status === 502 && dead.body.charged === 0 && /charged nothing/.test(dead.body.detail ?? ""), dead.body);
  drill("D5b", "the meter did not move on the failure", before.consumedUnits === after.consumedUnits,
    { before: before.consumedUnits, after: after.consumedUnits });
  const sw = await post(N2, "/marketplace/subs/switch", { offeringId: "qwen7b", toSeller: "0x0000000000000000000000000000000000000009" });
  drill("D5c", "provider switch recorded for the NEXT cycle, not executed", sw.status === 200 && !!sw.body.requestedAt, sw.body);

  // ═══ Drill 6 — query drills (heavy vs simple, both seats agree) ═══
  console.log("— D6 query cost —");
  const simple = await gw("/marketplace/gateway/v1/query",
    { offeringId: "devnet-knowledge", sparql: "SELECT ?s WHERE { ?s ?p ?o . } LIMIT 2" });
  const heavy = await gw("/marketplace/gateway/v1/query",
    { offeringId: "devnet-knowledge", sparql: `SELECT ?a (COUNT(?c) AS ?n) WHERE { ?a ?p1 ?b . ?b ?p2 ?c . OPTIONAL { ?c ?p4 ?d . } FILTER(?a != ?c) } GROUP BY ?a` });
  drill("D6a", "aggregation-heavy query visibly costs more than a simple lookup",
    heavy.status === 200 && heavy.body.units > simple.body.units * 2, { simple: simple.body.units, heavy: heavy.body.units });

  // ═══ Drill 7 — period end: expiry journaled; new period = new payment ═══
  console.log("— D7 expiry doctrine —");
  const exp = await post(N2, "/marketplace/subs/expire", { planId: plan.planId });
  drill("D7a", "active period cannot be force-expired", exp.status === 400, exp.body);
  // fresh seats for the expiry arc (the D1 plan legitimately outlives it)
  for (const h2 of [N1HOME, N2HOME]) globalThis.__rmSync(join(h2, "subscriptions"), { recursive: true, force: true });
  await post(N1, "/marketplace/operate/ask", { offeringId: "qwen7b", unit: "tokens", askMicroPerUnit: 0.5, effectiveFromCycle: 1, currentCycle: 1, seed: true });
  await post(N1, "/marketplace/operate/ask", { offeringId: "devnet-knowledge", unit: "query-units", askMicroPerUnit: 15, effectiveFromCycle: 1, currentCycle: 1, seed: true });
  const t3 = await pay(1);
  const shortLived = await newPlan([{ offeringId: "qwen7b", seller: SELLER, allocationMicroTrac: 500_000 }], 2_000, t3);
  await new Promise((r) => setTimeout(r, 2_500));
  const exp2 = await post(N2, "/marketplace/subs/expire", { planId: shortLived.plan.planId });
  drill("D7b", "period end journals the remainder as expired (value recognized, not returned)",
    exp2.status === 200 && exp2.body.expiredMicroTrac > 0, exp2.body);
  const noPlan = await gw("/marketplace/gateway/v1/chat/completions",
    { model: "qwen7b", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }, 60_000);
  drill("D7c", "after expiry: 402 with the start-new-period fork — nothing renews",
    noPlan.status === 402, noPlan.body);
  const t4 = await pay(1);
  const renewed = await newPlan([{ offeringId: "qwen7b", seller: SELLER, allocationMicroTrac: 500_000 }], 30 * 60_000, t4);
  drill("D7d", "a NEW period begins only with a NEW consented payment", renewed.enrolled === true, { plan: renewed.plan.planId, detail: renewed.enrollDetail });

  // ═══ Drill 8 — 404 probe sweep on BOTH seats ═══
  console.log("— D8 probes —");
  const probes = ["tab/open", "deposit", "refund", "withdraw", "settle", "credit", "release", "terms", "buyer/fund", "buyer/treasury"];
  let all404 = true;
  for (const base of [N1, N2]) for (const p of probes) {
    const r = await fetch(`${base}/marketplace/${p}`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    if (r.status !== 404) { all404 = false; console.log(`    probe LEAK: ${base}/${p} → ${r.status}`); }
  }
  drill("D8a", "every tab-rail path 404s on both seats (incl. terms + buyer rails)", all404, { probes });

  // ═══ Drill 9 — invariants over the live journals ═══
  console.log("— D9 invariants —");
  const { checkI2, checkI3, checkI5 } = await import(join(DIST, "subs/journal.js"));
  const { readPlans } = await import(join(DIST, "subs/journal.js"));
  const plans = readPlans(N2HOME);
  const i2 = plans.every((p) => checkI2(N2HOME, p).ok);
  const i3 = plans.every((p) => checkI3(N2HOME, p).ok);
  drill("D9a", "I2 (key conservation) holds for every plan on the buyer seat", i2);
  drill("D9b", "I3 (paid == consumed + expired per closed ceiling) holds", i3);
  drill("D9c", "I5 (no cross-offering decrements) holds on BOTH seats",
    checkI5(N2HOME).ok && checkI5(N1HOME).ok);
  drill("D9d", "I4 shape: one payment per seller per period on every plan",
    plans.every((p) => Object.keys(p.paymentTxBySeller).length === new Set(p.allocations.map((a) => a.seller)).size));
}

console.log(`\n${pass}/${pass + fail} Phase-4 drills pass — log: ${LOG}`);
process.exit(fail ? 1 : 0);
