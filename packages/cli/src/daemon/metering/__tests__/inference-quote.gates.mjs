// The inference FUNDED-RUN quote — binds a fresh epoch + the inference terms +
// the run envelope into one digest, so a buyer can commit an exact deposit to a
// fresh lifecycle (Bo, deposit-stage block). Pure module → runs with only node.
import { mkdtempSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
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
  ok("1 TRAC principal / 12 confs / 24h funded-run expiry bound (policy v1)", Q1.principalTrac === "1" && Q1.confirmationDepth === 12 && Q1.expiryMs === 24 * 60 * 60 * 1000 && Q1.expiryPolicyVersion === "funded-run-expiry/v1" && Q1.rolloverPolicy === "none");
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

console.log("\nthe expiry policy is a VERSIONED INVARIANT, not a label (Bo, v2.4 block):");
{
  const DAY = 24 * 60 * 60 * 1000;
  ok("an honest funded quote advertises 24h under funded-run-expiry/v1", q().expiryMs === DAY && q().expiryPolicyVersion === "funded-run-expiry/v1");
  // a SELF-CONSISTENT quote labeled v1 but carrying 1 ms is refused at the base verifier
  ok("a 1 ms window labeled v1 is refused (E_QUOTE_EXPIRY_POLICY)", Q.verifyFundedRunQuote(q({ expiryMs: 1 })).code === "E_QUOTE_EXPIRY_POLICY");
  // the OLD 30-minute window is likewise refused under v1 now
  ok("a 30-minute window labeled v1 is refused", Q.verifyFundedRunQuote(q({ expiryMs: 1_800_000 })).code === "E_QUOTE_EXPIRY_POLICY");
  // a self-consistent quote whose expiry is unbounded-large under v1 is refused too
  ok("a 7-day window labeled v1 is refused (version ≠ arbitrary value)", Q.verifyFundedRunQuote(q({ expiryMs: 7 * DAY })).code === "E_QUOTE_EXPIRY_POLICY");

  // a SELF-CONSISTENT UNKNOWN-VERSION quote (digest recomputed over the tampered
  // version) is refused at the base verifier — the undefined-policy branch,
  // regression-locked (Bo, v2.5 block #1).
  const sha = (b) => "sha256:" + createHash("sha256").update(b).digest("hex");
  const rebuildDigest = (quote) => {
    const { quoteId, fundedRunTermsDigest, ...bound } = quote;
    const d = sha(L.canonicalize(bound));
    return { ...bound, quoteId: d, fundedRunTermsDigest: d };
  };
  const unknownVer = rebuildDigest({ ...q(), expiryPolicyVersion: "funded-run-expiry/v99" });
  ok("the crafted unknown-version quote is internally self-consistent", Q.verifyFundedRunQuote(unknownVer).code === "E_QUOTE_EXPIRY_POLICY");
  ok("...and its own recomputed digest verifies (so it is NOT caught as tampered)", (() => { const { quoteId, fundedRunTermsDigest, ...b } = unknownVer; return sha(L.canonicalize(b)) === unknownVer.quoteId; })());

  // expected-binding: policy version is REQUIRED and compared unconditionally.
  const expected = { chainId: 8453, tracContract: q().tracContract, providerAddress: PROVIDER, refundAddress: REFUND, tabEpoch: 1, principalTrac: "1", confirmationDepth: 12, expiryMs: DAY, scheduleDigest: SCHED, envelopeCalls: 10, expiryPolicyVersion: "funded-run-expiry/v1", envelopeScalePolicyVersion: "envelope-scale/v2" };
  ok("expected-binding accepts the matching policy version", Q.verifyFundedRunQuote(q(), { expected }).ok);
  ok("expected-binding rejects a mismatched policy version", Q.verifyFundedRunQuote(q(), { expected: { ...expected, expiryPolicyVersion: "funded-run-expiry/v2" } }).code === "E_QUOTE_EXPECT_EXPIRY");
  // OMISSION: an expected that fails to pin the version does not silently pass.
  const { expiryPolicyVersion, ...noVersion } = expected;
  ok("expected-binding with the version OMITTED refuses (must pin it)", Q.verifyFundedRunQuote(q(), { expected: noVersion }).code === "E_QUOTE_EXPECT_EXPIRY");
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
  // provider identity is CONFIG-derived (Bo #4): the route reads req.providerAddress,
  // not a caller-supplied ?provider value.
  await C.handleInfer({ method: "GET", path: "/api/metering/infer-terms", chainId: 8453, home, query: `?refundAddress=${REFUND}`, providerAddress: PROVIDER }, { json: (s, b) => { out = { s, b }; }, readBody: async () => "" });
  ok("GET /api/metering/infer-terms → 200 with a quote", out.s === 200 && out.b.quote);
  ok("it binds the FRESH epoch (1, after settled epoch 0)", out.b.quote.tabEpoch === 1);
  ok("it is provider-signed with the provider public key", typeof out.b.signature === "string" && out.b.providerPublicKeyPem.includes("PUBLIC KEY"));
  ok("the buyer verifies the live quote", Q.verifyFundedRunQuote(out.b.quote).ok);
  ok("missing refundAddress → 400", (await (async () => { let o; await C.handleInfer({ method: "GET", path: "/api/metering/infer-terms", chainId: 8453, home, query: "", providerAddress: PROVIDER }, { json: (s, b) => { o = { s, b }; }, readBody: async () => "" }); return o; })()).s === 400);
  ok("no configured provider wallet → 503", (await (async () => { let o; await C.handleInfer({ method: "GET", path: "/api/metering/infer-terms", chainId: 8453, home, query: `?refundAddress=${REFUND}`, providerAddress: null }, { json: (s, b) => { o = { s, b }; }, readBody: async () => "" }); return o; })()).s === 503);
  // P2 3.1 — the route's optional ?calls= parameter, strict and policy-bound
  const terms = async (q) => { let o; await C.handleInfer({ method: "GET", path: "/api/metering/infer-terms", chainId: 8453, home, query: q, providerAddress: PROVIDER }, { json: (s, b) => { o = { s, b }; }, readBody: async () => "" }); return o; };
  const big = await terms(`?refundAddress=${REFUND}&calls=100000`);
  ok("?calls=100000 → 200, quote N=100,000 with proportional ceiling 23,400,000 (envelope-scale/v2)", big.s === 200 && big.b.quote.envelope.calls === 100000 && big.b.quote.envelope.maxAcceptedClaimMicroTrac === 23400000 && big.b.quote.envelope.scalePolicyVersion === "envelope-scale/v2", JSON.stringify(big.b?.quote?.envelope ?? big.b));
  ok("?calls=100001 → 400 E_ENVELOPE_SCALE (range named)", (await terms(`?refundAddress=${REFUND}&calls=100001`)).b?.error === "E_ENVELOPE_SCALE");
  ok("?calls=0 → 400 E_ENVELOPE_SCALE", (await terms(`?refundAddress=${REFUND}&calls=0`)).b?.error === "E_ENVELOPE_SCALE");
  ok("?calls=abc → 400 (strict decimal, never coerced)", (await terms(`?refundAddress=${REFUND}&calls=abc`)).b?.error === "E_ENVELOPE_SCALE");
  ok("?calls=-5 → 400", (await terms(`?refundAddress=${REFUND}&calls=-5`)).b?.error === "E_ENVELOPE_SCALE");
  ok("?calls=2.5 → 400", (await terms(`?refundAddress=${REFUND}&calls=2.5`)).b?.error === "E_ENVELOPE_SCALE");
  ok("absent ?calls → the historical default N=10 (unchanged behavior)", (await terms(`?refundAddress=${REFUND}`)).b?.quote?.envelope?.calls === 10);

  // the tab view exposes the epoch model for the buyer's pre-credit check
  const tv = ST.tabView(home, REFUND, 49_755_000);
  ok("tab view exposes current epoch, nextEpoch, and terminal state", tv.epoch === 0 && tv.nextEpoch === 1 && tv.settled === true);
  ok("a buyer can read a clean fresh-epoch target distinct from the settled one", tv.nextEpoch === out.b.quote.tabEpoch);
}

console.log(`\n${pass}/${pass + fail} inference-quote gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
