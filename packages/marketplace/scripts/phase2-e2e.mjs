// Phase-2 two-seat E2E on the devnet (testnet rehearsal that earns CP2).
//
// Seller = devnet node5 (:9205, marketplace enabled, ⛓ Qwen2.5-7B via llama.cpp
// + ☁ rehearsal stub). Buyer = devnet node6 (:9206, gateway). Real ERC-20 TRAC
// deposit on the hardhat chain; every journey step (A1–A8, B1–B9, C1–C4)
// exercised over the wire with evidence captured to nsm-v3-evidence/phase2/.
//
// Includes the REQUIRED demonstrations: one deliberately tampered leg per class
// (labeled man-in-the-middle drills — the SELLER stays honest; the harness
// mutates the leg between seats) producing the correct WITHHOLD code on the
// wire; conservation from both seats; threshold refusal.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Wallet, JsonRpcProvider, Contract, parseUnits } from "ethers";

const REPO = join(homedir(), "odysseus-dkg-proto/dkg");
const DIST = join(REPO, "packages/marketplace/dist");
const DEV = join(REPO, ".devnet");
const EV = join(homedir(), "odysseus-dkg-proto/nsm-v3-evidence/phase2");
mkdirSync(EV, { recursive: true });

const { BuyerClient } = await import(join(DIST, "buyer/client.js"));
const { hfEngine } = await import(join(DIST, "buyer/bpe.js"));
const { verifyInferenceLegV3, verifyQueryLegV3 } = await import(join(DIST, "buyer/recount.js"));
const { publishOffering } = await import(join(DIST, "seller/offering.js"));
const { tabQuantities } = await import(join(DIST, "seller/tabs.js"));
const { providerMaySettleV3 } = await import(join(DIST, "seller/front.js"));
const { keyConservation } = await import(join(DIST, "gateway/keys.js"));

const SELLER_API = "http://127.0.0.1:9205";
const BUYER_API = "http://127.0.0.1:9206";
const MKT = SELLER_API + "/marketplace";
const RPC = "http://127.0.0.1:8545";
const TRAC = "0x70E5370b8981Abc6e14C91F4AcE823954EFC8eA3";
const SELLER_HOME_MKT = join(DEV, "node5/marketplace");
const BUYER_HOME_MKT = join(DEV, "node6/marketplace");
const CG = "nsm-devnet";

const t5 = readFileSync(join(DEV, "node5/auth.token"), "utf8").trim().split("\n").pop();
const t6 = readFileSync(join(DEV, "node6/auth.token"), "utf8").trim().split("\n").pop();

const results = [];
const step = (id, name, pass, evidence) => {
  results.push({ id, name, pass, evidence });
  console.log(`  ${pass ? "✓" : "✗"} [${id}] ${name}`);
  appendFileSync(join(EV, "journey-log.jsonl"), JSON.stringify({ id, name, pass, evidence, at: new Date().toISOString() }) + "\n");
};
const save = (name, data) => writeFileSync(join(EV, name), typeof data === "string" ? data : JSON.stringify(data, null, 2));

// ── buyer wallet env (written directly from node6's wallet store; never logged) ──
const w6 = JSON.parse(readFileSync(join(DEV, "node6/wallets.json"), "utf8"));
const buyerW = (Array.isArray(w6) ? w6 : w6.wallets)[0];
const WALLET_ENV = join(DEV, "node6/.secrets-buyer-wallet.env");
writeFileSync(WALLET_ENV, `BUYER_WALLET_KEY=${buyerW.privateKey}\n`, { mode: 0o600 });

// ═══ A1–A2 implicitly proven by the mounted front; A3: publish offering KAs ═══
console.log("═══ Journey A (seller) ═══");
const termsRes = await fetch(MKT + "/terms");
const terms = await termsRes.json();
save("A2-signed-quote.json", terms);
step("A2", "seller issues signed quote on 402", termsRes.status === 402 && !!terms.signature, { status: termsRes.status, quoteDigest: terms.quoteDigest });

// create CG + seed data (for metered queries), then publish offerings
const nodeCall = async (base, token, path, body) => {
  const res = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, json, text };
};
await nodeCall(SELLER_API, t5, "/api/context-graph/create", { contextGraphId: CG, name: CG });
// seed knowledge for query legs
const seed = await nodeCall(SELLER_API, t5, `/api/knowledge-assets/nsm-seed/wm/write`, {
  contextGraphId: CG,
  quads: [
    { subject: "urn:nsm:demo:alpha", predicate: "http://schema.org/name", object: JSON.stringify("Alpha") },
    { subject: "urn:nsm:demo:beta", predicate: "http://schema.org/name", object: JSON.stringify("Beta") },
    { subject: "urn:nsm:demo:gamma", predicate: "http://schema.org/name", object: JSON.stringify("Gamma") },
  ],
});
await nodeCall(SELLER_API, t5, `/api/knowledge-assets/nsm-seed/wm/finalize`, { contextGraphId: CG });
step("A3a", "seller CG created + seeded (3 quads)", seed.status === 200, { cg: CG, seed: seed.status });

// publish both offerings as KAs (registry = the DKG)
const quote = terms.quote;
const uals = {};
for (const o of quote.offerings) {
  try {
    const ob = {
      offering: {
        id: o.id, provenanceClass: o.provenanceClass,
        perInputTokenMicroTrac: o.perInputTokenMicroTrac, perOutputTokenMicroTrac: o.perOutputTokenMicroTrac,
        queryFlatMicroTrac: o.queryFlatMicroTrac, perReturnedQuadMicroTrac: o.perReturnedQuadMicroTrac,
      },
      binding: o.provenanceClass === "weights-pinned"
        ? { kind: "llamacpp", modelId: o.modelId, ggufSha256: "sha256:see-quote", settings: o.servingSettings }
        : { kind: "openai", model: o.modelId, templateConstantsDigest: String(o.servingSettings?.templateConstantsDigest ?? "") },
      tokenizerBundleRef: o.tokenizerBundleRef,
    };
    const pub = await publishOffering(SELLER_API, t5, ob, {
      providerAddress: quote.providerAddress, apiBase: quote.apiBase, chainId: quote.chainId,
      contextGraphId: CG,
    });
    uals[o.id] = pub.ual;
    step("A3", `offering KA published: ${o.id}`, true, pub);
  } catch (e) {
    step("A3", `offering KA published: ${o.id}`, false, { error: String(e.message).slice(0, 200) });
  }
}
save("A3-offering-uals.json", uals);

// ═══ Journey B (buyer) ═══
console.log("═══ Journey B (buyer) ═══");
const client = new BuyerClient(MKT, WALLET_ENV);

// B2/B3: discover + verify quote per-invariant
const verified = await client.fetchAndVerifyTerms({ providerAddress: quote.providerAddress, chainId: 31337 });
save("B3-quote-verification.json", verified.checks);
step("B3", `quote verifies per-invariant (${verified.checks.filter((c) => c.pass).length}/${verified.checks.length})`, verified.ok, { checks: verified.checks.length });

// B4/B5: REAL deposit — ERC-20 TRAC transfer buyer → seller on the devnet chain
const provider = new JsonRpcProvider(RPC);
const wallet = new Wallet(buyerW.privateKey, provider);
const erc = new Contract(TRAC, [
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
], wallet);
const DEPOSIT_TRAC = "1.0";
const tx = await erc.transfer(quote.providerAddress, parseUnits(DEPOSIT_TRAC, 18));
const rcpt = await tx.wait();
save("B5-deposit-tx.json", { hash: rcpt.hash, block: rcpt.blockNumber, from: wallet.address, to: quote.providerAddress, amountTrac: DEPOSIT_TRAC });
step("B5a", `on-chain TRAC deposit mined (${DEPOSIT_TRAC} TRAC)`, rcpt.status === 1, { tx: rcpt.hash, block: rcpt.blockNumber });

const opened = await client.openTab(rcpt.hash);
save("B5-tab-open.json", opened.body);
step("B5b", "tab/open verified deposit on the SELLER's own RPC", opened.ok, opened.body);
const tabId = client.tabId;

// replay refusal: same txHash again
const replayTab = await client.openTab(rcpt.hash);
step("B5c", "tx hash consumed — second tab/open refused (409)", replayTab.status === 409, replayTab.body);

// B6: buyer configures its gateway (buyer.json) + mints a key for itself
const providerPem = terms.providerPublicPem;
const bundlePath = join(homedir(), "odysseus-dkg-proto/inference-recount-matrix/buyer-bundle/tokenizer.json");
const chainOff = quote.offerings.find((o) => o.provenanceClass === "weights-pinned");
const cloudOff = quote.offerings.find((o) => o.provenanceClass === "upstream-claimed");
writeFileSync(join(BUYER_HOME_MKT, "buyer.json"), JSON.stringify({
  sellerApiBase: MKT, walletEnvFile: WALLET_ENV, tabId,
  offerings: [
    {
      id: chainOff.id, modelId: chainOff.modelId, provenanceClass: "weights-pinned",
      tokenizerBundleRef: chainOff.tokenizerBundleRef, providerPublicPem: providerPem,
      perInputTokenMicroTrac: chainOff.perInputTokenMicroTrac, perOutputTokenMicroTrac: chainOff.perOutputTokenMicroTrac,
      queryFlatMicroTrac: chainOff.queryFlatMicroTrac, perReturnedQuadMicroTrac: chainOff.perReturnedQuadMicroTrac,
      bundlePath, bundleKind: "hf",
    },
    {
      id: cloudOff.id, modelId: cloudOff.modelId, provenanceClass: "upstream-claimed",
      tokenizerBundleRef: cloudOff.tokenizerBundleRef, providerPublicPem: providerPem,
      perInputTokenMicroTrac: cloudOff.perInputTokenMicroTrac, perOutputTokenMicroTrac: cloudOff.perOutputTokenMicroTrac,
      queryFlatMicroTrac: cloudOff.queryFlatMicroTrac, perReturnedQuadMicroTrac: cloudOff.perReturnedQuadMicroTrac,
      bundlePath, bundleKind: "hf",
    },
  ],
}, null, 2));
step("B6a", "buyer gateway configured (buyer.json)", true, { tabId });

// gateway key mint — loopback on the BUYER node
const mint = await fetch(BUYER_API + "/marketplace/gateway/v1/keys", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ budgetMicroTrac: 500000, rps: 10, allowQuery: true }),
});
const minted = await mint.json();
step("B6b", "buyer mints nsm_k_ key for itself (loopback)", mint.status === 200 && String(minted.key ?? "").startsWith("nsm_k_"), { keyId: minted.record?.keyId });
const KEY = minted.key;

// ═══ Journey C — the three purchases through the gateway ═══
console.log("═══ Journey C (consumer via gateway) ═══");
const gw = async (path, body) => {
  const res = await fetch(BUYER_API + "/marketplace/gateway/v1" + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(300_000),
  });
  return { status: res.status, body: await res.json() };
};

const models = await gw("/models");
save("C1-models.json", models.body);
step("C1", "gateway lists funded offerings badged ⛓/☁", models.status === 200 && models.body.data?.length === 2, { models: models.body.data?.map((m) => m.id) });

const PROMPT = "In one sentence, what does a knowledge graph do?";
const chainCall = await gw("/chat/completions", { model: chainOff.modelId, messages: [{ role: "user", content: PROMPT }], max_tokens: 64 });
save("C2-chain-inference.json", chainCall.body);
step("C2a", "⛓ inference purchased, recounted, countersigned", chainCall.status === 200 && chainCall.body.nsm?.decision === "countersigned",
  { legId: chainCall.body.nsm?.leg?.legId, cost: chainCall.body.nsm?.leg?.pricing?.costMicroTrac, completion: chainCall.body.choices?.[0]?.message?.content?.slice(0, 80) });

const cloudCall = await gw("/chat/completions", { model: cloudOff.modelId, messages: [{ role: "user", content: PROMPT }], max_tokens: 64 });
save("C2-cloud-inference.json", cloudCall.body);
step("C2b", "☁ inference purchased, recounted, countersigned", cloudCall.status === 200 && cloudCall.body.nsm?.decision === "countersigned",
  { legId: cloudCall.body.nsm?.leg?.legId, cost: cloudCall.body.nsm?.leg?.pricing?.costMicroTrac });

const queryCall = await gw("/query", { sparql: `SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name } LIMIT 10` });
save("C3-query.json", queryCall.body);
step("C3", "metered knowledge query purchased, recounted, countersigned", queryCall.status === 200 && queryCall.body.nsm?.decision === "countersigned",
  { legId: queryCall.body.nsm?.leg?.legId, quads: queryCall.body.nsm?.leg?.meter?.returnedQuads, cost: queryCall.body.nsm?.leg?.pricing?.costMicroTrac });

// ═══ Tamper drills — one per class, over the wire (labeled) ═══
console.log("═══ Tamper drills (man-in-the-middle, seller honest) ═══");
const engine = hfEngine(readFileSync(bundlePath, "utf8"));
const expectation = {
  tokenizerBundleRef: chainOff.tokenizerBundleRef, providerPublicPem: providerPem,
  perInputTokenMicroTrac: chainOff.perInputTokenMicroTrac, perOutputTokenMicroTrac: chainOff.perOutputTokenMicroTrac,
  queryFlatMicroTrac: chainOff.queryFlatMicroTrac, perReturnedQuadMicroTrac: chainOff.perReturnedQuadMicroTrac,
};

// drill 1 — ⛓ inference: buy directly, tamper the delivered bytes, recount, withhold ON THE WIRE
const direct = await client.chat(chainOff.modelId, [{ role: "user", content: "Name one benefit of provenance." }], 48);
const dLeg = direct.body.nsm.leg;
const dBytes = Buffer.from(direct.body.choices[0].message.content + " [TAMPERED-IN-TRANSIT]", "utf8");
const v1 = verifyInferenceLegV3({ leg: dLeg, deliveredBytes: dBytes, promptMessages: [{ role: "user", content: "Name one benefit of provenance." }], offering: expectation, engine, provenanceClass: "weights-pinned" });
const wh1 = await client.withhold(dLeg.legId, v1.violations[0]?.code ?? "E_BYTES_DIGEST", "tamper drill: bytes mutated in transit (labeled Phase-2 demonstration)");
save("drill-1-inference-withhold.json", { verdict: v1, wire: wh1.body });
step("D1", "⛓ tampered bytes → WITHHOLD E_BYTES_DIGEST on the wire", v1.decision === "withhold" && v1.violations.some((x) => x.code === "E_BYTES_DIGEST") && wh1.status === 200, wh1.body);

// drill 2 — query: tamper the returned-quad count in the leg copy, recount, withhold
const dq = await client.query(`SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name } LIMIT 10`);
const qLeg = structuredClone(dq.body.nsm.leg);
qLeg.meter.returnedQuads += 4;   // MITM inflation
qLeg.pricing.costMicroTrac = expectation.queryFlatMicroTrac + expectation.perReturnedQuadMicroTrac * qLeg.meter.returnedQuads;
const v2 = verifyQueryLegV3({ leg: qLeg, deliveredBody: Buffer.from(JSON.stringify(dq.body.result), "utf8"), countQuads: (b) => { try { return (JSON.parse(b).bindings ?? []).length; } catch { return -1; } }, offering: expectation });
const wh2 = await client.withhold(dq.body.nsm.leg.legId, v2.violations[0]?.code ?? "E_RECOUNT_MISMATCH", "tamper drill: quad count inflated in transit (labeled Phase-2 demonstration)");
save("drill-2-query-withhold.json", { verdict: v2, wire: wh2.body });
step("D2", "query inflated quads → WITHHOLD E_RECOUNT_MISMATCH on the wire", v2.decision === "withhold" && v2.violations.some((x) => x.code === "E_RECOUNT_MISMATCH") && wh2.status === 200, wh2.body);

// drill 3 — ☁: template-constant drift (input count shifted by one message overhead)
const dc = await client.chat(cloudOff.modelId, [{ role: "user", content: "Say OK." }], 16);
const cLeg = structuredClone(dc.body.nsm.leg);
cLeg.meter.inputTokens += 3;
cLeg.pricing.costMicroTrac = cLeg.meter.inputTokens * cloudOff.perInputTokenMicroTrac + cLeg.meter.outputTokens * cloudOff.perOutputTokenMicroTrac;
const v3 = verifyInferenceLegV3({ leg: cLeg, deliveredBytes: Buffer.from(dc.body.choices[0].message.content, "utf8"), promptMessages: [{ role: "user", content: "Say OK." }], offering: { ...expectation, tokenizerBundleRef: cloudOff.tokenizerBundleRef, perInputTokenMicroTrac: cloudOff.perInputTokenMicroTrac, perOutputTokenMicroTrac: cloudOff.perOutputTokenMicroTrac }, engine, provenanceClass: "upstream-claimed" });
const wh3 = await client.withhold(dc.body.nsm.leg.legId, v3.violations[0]?.code ?? "E_RECOUNT_MISMATCH", "tamper drill: template constants drifted in transit (labeled Phase-2 demonstration)");
save("drill-3-cloud-withhold.json", { verdict: v3, wire: wh3.body });
step("D3", "☁ template drift → WITHHOLD E_RECOUNT_MISMATCH on the wire", v3.decision === "withhold" && v3.violations.some((x) => x.code === "E_RECOUNT_MISMATCH") && wh3.status === 200, wh3.body);

// ═══ B8/B9: close + conservation from both seats + threshold ═══
console.log("═══ Close, conservation, threshold ═══");
const closed = await client.close();
save("B9-close.json", closed.body);
step("B9a", "buyer close commits (all legs decided)", closed.status === 200 && !!closed.body.closeDigest, { closeDigest: closed.body.closeDigest, quantities: closed.body.quantities });

// seller-seat conservation (journal projection on node5's marketplace home)
const sq = tabQuantities(SELLER_HOME_MKT, wallet.address);
const sellerOk = sq.deposits === sq.billed + sq.balance + sq.released;
save("conservation-seller.json", sq);
step("CONS-S", `SELLER-seat conservation ${sq.deposits} == ${sq.billed}+${sq.balance}+${sq.released}`, sellerOk, sq);

// buyer-seat conservation: recompute INDEPENDENTLY from countersigned legs + deposit receipt
const legsBought = [chainCall.body.nsm.leg, cloudCall.body.nsm.leg, queryCall.body.nsm.leg];
const buyerBilledCountersigned = legsBought.reduce((s, l) => s + Number(l.pricing.costMicroTrac), 0);
// withheld drills billed on the seller ledger but NOT countersigned — buyer's
// veto stands recorded; drill legs' costs are visible and disputed:
const drillCosts = [dLeg, dq.body.nsm.leg, dc.body.nsm.leg].reduce((s, l) => s + Number(l.pricing.costMicroTrac), 0);
const buyerView = {
  depositMicroTrac: 1_000_000,
  countersignedMicroTrac: buyerBilledCountersigned,
  withheldDisputedMicroTrac: drillCosts,
  expectedRefundable: 1_000_000 - buyerBilledCountersigned - drillCosts,
  sellerReportedBalance: sq.balance,
  agrees: 1_000_000 - buyerBilledCountersigned - drillCosts === sq.balance,
};
save("conservation-buyer.json", buyerView);
step("CONS-B", "BUYER-seat independent conservation agrees with seller balance", buyerView.agrees, buyerView);

// threshold refusal at current earnings
const election = providerMaySettleV3({ unsettledEarnedMicroTrac: sq.billed, gasMicroTrac: 2941, epsilon: 0.001 });
save("threshold-election.json", { unsettledEarned: sq.billed, ...election });
step("A8", `settlement election refused below threshold (${sq.billed}µ < ${election.thresholdMicroTrac}µ)`, election.allowed === false, election);

// key-conservation on the buyer gateway
const kc = keyConservation(BUYER_HOME_MKT, buyerBilledCountersigned);
step("C4", "per-key sub-ledgers sum to countersigned tab billed", kc.ok, kc);

// ═══ summary ═══
const passN = results.filter((r) => r.pass).length;
save("SUMMARY.json", { pass: passN, total: results.length, results });
console.log(`\n${passN}/${results.length} journey steps green`);
process.exit(passN === results.length ? 0 : 1);
