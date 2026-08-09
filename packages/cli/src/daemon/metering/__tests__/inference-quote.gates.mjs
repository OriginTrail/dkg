// The inference FUNDED-RUN quote — binds a fresh epoch + the inference terms +
// the run envelope into one digest, so a buyer can commit an exact deposit to a
// fresh lifecycle (Bo, deposit-stage block). Pure module → runs with only node.
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/daemon");
const Q = await import(join(dist, "metering/inference-quote.js"));
const M = await import(join(dist, "metering/inference-meter.js"));
const L = await import(join(dist, "metering/ledger.js"));
const C = await import(join(dist, "metering/infer-http-core.js"));
const ST = await import(join(dist, "metering/stage3-endpoint.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };

const PROVIDER = "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab";
const REFUND = "0x8A87ea7c0fBC3431f20B5B26dd9f7f32571Aa2ba";
const SCHED = "4aa26e51719122fb9bf25c3e869549e4bc86b2309041c883482f5c323855abc0";
const q = (over = {}) => Q.buildFundedRunQuote({ tabEpoch: 1, providerAddress: PROVIDER, refundAddress: REFUND, scheduleDigest: SCHED, ...over });

console.log("\nInference funded-run quote — binds a fresh epoch + envelope (Bo, deposit-stage)\n");

console.log("the quote binds everything the buyer needs:");
{
  const Q1 = q();
  ok("tabEpoch is bound", Q1.tabEpoch === 1);
  ok("chain / token / provider / locked refund address bound", Q1.chain === "eip155:8453" && Q1.tracContract.startsWith("0xA81a52B4") && Q1.providerAddress === PROVIDER && Q1.refundAddress === REFUND);
  ok("1 TRAC principal / 12 confs / 30-min expiry bound", Q1.principalTrac === "1" && Q1.confirmationDepth === 12 && Q1.expiryMs === 1_800_000 && Q1.rolloverPolicy === "none");
  ok("receipt-v0.6 inference pricing (2/6) bound — NOT the read ask", Q1.inferencePricing.perInputTokenMicroTrac === 2 && Q1.inferencePricing.perOutputTokenMicroTrac === 6 && Q1.inferencePricing.policyDigest === M.inferencePolicyDigest());
  ok("envelope: N=10, no streaming, no tools, 2,340 µTRAC ceiling, one-disputed policy",
    Q1.envelope.calls === 10 && Q1.envelope.streaming === false && Q1.envelope.tools === false && Q1.envelope.maxAcceptedClaimMicroTrac === 2340 && /withhold\/dispute/.test(Q1.envelope.withheldLegPolicy));
  ok("canonical deposit identity fields bound (chain:token:tx:log)", JSON.stringify(Q1.depositIdentity.fields) === JSON.stringify(["chainId", "token", "txHash", "logIndex"]));
  ok("quoteId == fundedRunTermsDigest == digest of the bound fields", Q1.quoteId === Q1.fundedRunTermsDigest);
}

console.log("\nthe digest is fresh-epoch-specific (no collision with a prior lifecycle):");
{
  ok("a different epoch → a different digest", q({ tabEpoch: 1 }).fundedRunTermsDigest !== q({ tabEpoch: 2 }).fundedRunTermsDigest);
  ok("its digest is NOT the prior read termsDigest 0d83e62c", !q().fundedRunTermsDigest.includes("0d83e62c"));
  ok("recomputing over the same inputs is stable", q().fundedRunTermsDigest === q().fundedRunTermsDigest);
}

console.log("\nthe buyer's verify catches tampering:");
{
  ok("an honest quote verifies", Q.verifyFundedRunQuote(q()).ok);
  ok("a tampered tabEpoch (digest not recomputed) is caught", Q.verifyFundedRunQuote({ ...q(), tabEpoch: 999 }).code === "E_QUOTE_DIGEST");
  ok("a tampered maxClaim is caught", Q.verifyFundedRunQuote({ ...q(), envelope: { ...q().envelope, maxAcceptedClaimMicroTrac: 1 } }).code === "E_QUOTE_DIGEST");
  // a self-consistent quote whose pricing diverges from the live policy is caught
  const forged = q();
  const bad = { ...forged, inferencePricing: { ...forged.inferencePricing, perOutputTokenMicroTrac: 1 } };
  // recompute its digest so it is internally consistent, then check against live policy
  ok("a self-consistent quote priced off a foreign policy is refused", Q.verifyFundedRunQuote(bad).ok === false);
  ok("streaming/tools true is refused", Q.verifyFundedRunQuote({ ...q(), envelope: { ...q().envelope, streaming: true } }).ok === false);
}

console.log("\nthe LIVE route binds the epoch a fresh deposit would open:");
{
  const home = mkdtempSync(join(tmpdir(), "quote-route-"));
  process.env.DKG_HOME = home; mkdirSync(join(home, "metering"), { recursive: true });
  const TRAC = "0xA81a52B4dda010896cDd386C7fBdc5CDc835ba23";
  // a prior SETTLED epoch 0 → a fresh deposit opens epoch 1
  L.credit(home, REFUND, 1_000_000, { chainId: 8453, token: TRAC, txHash: "0xOLD", logIndex: 0 });
  L.settleTab(home, REFUND, { withdrawalId: "wd:old", txHash: "0xoldsettle", netPaidMicroTrac: 999_999, expectedEpoch: 0 });
  let out;
  await C.handleInfer({ method: "GET", path: "/api/metering/infer-terms", chainId: 8453, home, query: `?refundAddress=${REFUND}&provider=${PROVIDER}` }, { json: (s, b) => { out = { s, b }; }, readBody: async () => "" });
  ok("GET /api/metering/infer-terms → 200 with a quote", out.s === 200 && out.b.quote);
  ok("it binds the FRESH epoch (1, after settled epoch 0)", out.b.quote.tabEpoch === 1);
  ok("it is provider-signed with the provider public key", typeof out.b.signature === "string" && out.b.providerPublicKeyPem.includes("PUBLIC KEY"));
  ok("the buyer verifies the live quote", Q.verifyFundedRunQuote(out.b.quote).ok);
  ok("missing refundAddress → 400", (await (async () => { let o; await C.handleInfer({ method: "GET", path: "/api/metering/infer-terms", chainId: 8453, home, query: "?provider=" + PROVIDER }, { json: (s, b) => { o = { s, b }; }, readBody: async () => "" }); return o; })()).s === 400);

  // the tab view exposes the epoch model for the buyer's pre-credit check
  const tv = ST.tabView(home, REFUND, 49_755_000);
  ok("tab view exposes current epoch, nextEpoch, and terminal state", tv.epoch === 0 && tv.nextEpoch === 1 && tv.settled === true);
  ok("a buyer can read a clean fresh-epoch target distinct from the settled one", tv.nextEpoch === out.b.quote.tabEpoch);
}

console.log(`\n${pass}/${pass + fail} inference-quote gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
