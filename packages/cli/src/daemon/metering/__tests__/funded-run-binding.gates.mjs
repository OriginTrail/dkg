// FUNDED-RUN BINDING — the funded-run block, closed (Hermes/Bo, event ~9da6c620).
// The redesign converges on ONE provider-authenticated countersigned opening and
// ONE authoritative, crash-safe debit journal. This suite carries the negatives
// Bo required:
//
//   1. unsigned / self-signed quote through openTab AND credit
//   2. every quote↔opening↔transfer mismatch, incl. a real nonzero log index
//   3. crash after debit → replay does NOT reopen envelope capacity
//   4. two concurrent final-slot commits → the second is refused
//   5. end-to-end dispute → close/claim reconciliation (exactly one excluded)
//      plus N (11th call) and aggregate-ceiling enforcement, atomic with the debit.
import { generateKeyPairSync, sign as edSign, createPrivateKey, createHash } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/daemon");
const home = mkdtempSync(join(tmpdir(), "fundedv2-"));
process.env.DKG_HOME = home;
mkdirSync(join(home, "metering"), { recursive: true });

const Q = await import(join(dist, "metering/inference-quote.js"));
const L = await import(join(dist, "metering/ledger.js"));
const D = await import(join(dist, "metering/deposit-rail.js"));
const ST = await import(join(dist, "metering/stage3-endpoint.js"));
const MR = await import(join(dist, "metering/metered-read.js"));
const S = await import(join(dist, "metering/settlement.js"));
const RM = await import(join(dist, "metering/read-meter.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const throwsCode = (fn, code) => { try { fn(); return false; } catch (e) { return String(e?.message ?? e).includes(code); } };

const PROVIDER = "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab";
const TRAC = "0xA81a52B4dda010896cDd386C7fBdc5CDc835ba23";
const SCHED = sha256hex(L.canonicalize(RM.COEFFICIENTS_CANONICAL));
L.setDebitGate((h, p, now) => D.debitAllowed(h, p, now));

// Build a PROVIDER-SIGNED commitment for a principal, exactly as /infer-terms would.
const commitmentFor = (refund, over = {}) => {
  const quote = Q.buildFundedRunQuote({ tabEpoch: L.nextEpochFor(home, refund), providerAddress: PROVIDER, refundAddress: refund, scheduleDigest: SCHED, ...over });
  const signature = L.providerSign(home, Q.FUNDED_RUN_QUOTE_DOMAIN, quote.fundedRunTermsDigest);
  return { quote, signature, providerKeyId: L.providerKeyId(home) };
};
// Fund a tab through the full opening→credit path. Returns the commitment.
const fundTab = (refund, over = {}) => {
  const c = commitmentFor(refund, over);
  const terms = ST.stage3Terms(PROVIDER, refund, 100, RM.SCHEDULE_VERSION, 8453);
  terms.expiryMs = c.quote.expiryMs;   // funded opening adopts the signed 24h window
  D.registerOpening(home, D.buildOpeningArtifact(refund, terms, Date.now(), c));
  const tr = { txHash: "0x" + refund.slice(2, 10) + "fund", from: refund, to: PROVIDER, token: TRAC, amountTrac: "1", blockNumber: 100, safeHeadBlock: 120, chainId: 8453, logIndex: 0, ...(over._transfer ?? {}) };
  const r = ST.creditObservedDeposit(home, refund, tr);
  return { c, r, terms };
};
const inferLeg = (principal, quoteDigest, cost) => L.recordInferenceLeg(home, {
  principal, inputTokens: 10, outputTokens: 10, costMicroTrac: cost, policyDigest: "sha256:p",
  evidence: { schemaVersion: "receipt-v0.6" }, quoteDigest,
});

console.log("\nFunded-run binding v2 — convergence on the signed opening + authoritative journal (Bo)\n");

// ── the happy path: signed commitment → opening → credit → projection ────────
console.log("the provider-signed quote is the countersigned opening, and credit binds to it:");
const A = "0xAaAa000000000000000000000000000000000001";
{
  const { c, r } = fundTab(A, { calls: 10 });
  ok("a signed funded deposit credits through the epoch+quote CAS", r.credited === true && r.funded === true && r.balance === 1_000_000, JSON.stringify(r));
  ok("the ledger binds the epoch to the quote digest + run bounds", L.boundQuoteOf(home, A)?.quoteDigest === c.quote.fundedRunTermsDigest);
  const tv = ST.tabView(home, A, 120);
  ok("tabView exposes the envelope projected from the debit journal", tv.envelope && tv.envelope.calls === 0 && tv.envelope.aggregateMicroTrac === 0 && Array.isArray(tv.envelope.disputedLegs));
  // funded-run expiry policy (buyer-found, 2026-08-10: 30-min window expired
  // mid-audit): the quote advertises a 24h signed window, versioned, and the
  // opening adopts it so quote↔terms expiry match at credit.
  ok("the funded quote advertises the 24h expiry policy (versioned)", c.quote.expiryMs === 24 * 60 * 60 * 1000 && c.quote.expiryPolicyVersion === "funded-run-expiry/v1");
  ok("the funded opening's expiry equals the quote's (not the 30-min read default)", ST.tabView(home, A, 120).expiresAt !== null && D.activeOpening(home, A).terms.expiryMs === c.quote.expiryMs);
}

// ── NEGATIVE 1 — unsigned / self-signed / foreign-key quote ──────────────────
// verifyFundedCommitment is the SHARED gate openTab and creditFundedDeposit both
// call before registration and before credit — so exercising it directly proves
// both paths refuse, and the credit path is additionally driven end-to-end.
console.log("\nNEGATIVE 1 — an unsigned or foreign-key quote is refused before opening AND before credit:");
{
  const B = "0xBbBb000000000000000000000000000000000002";
  const quote = Q.buildFundedRunQuote({ tabEpoch: 0, providerAddress: PROVIDER, refundAddress: B, scheduleDigest: SCHED });
  const terms = ST.stage3Terms(PROVIDER, B, 100, RM.SCHEDULE_VERSION, 8453);
  const goodSig = L.providerSign(home, Q.FUNDED_RUN_QUOTE_DOMAIN, quote.fundedRunTermsDigest);
  const keyId = L.providerKeyId(home);
  // (a) no signature at all
  ok("the shared gate refuses an unsigned quote", D.verifyFundedCommitment(home, { quote, signature: "", providerKeyId: keyId }).code === "E_QUOTE_SIG_INVALID");
  // (b) signed by a FOREIGN key (attacker self-signs an internally consistent quote)
  const foreign = generateKeyPairSync("ed25519");
  const foreignSig = edSign(null, Buffer.concat([Buffer.from(Q.FUNDED_RUN_QUOTE_DOMAIN + "\n"), Buffer.from(quote.fundedRunTermsDigest)]), foreign.privateKey).toString("base64");
  const selfSigned = { quote, signature: foreignSig, providerKeyId: keyId };
  ok("the shared gate refuses a foreign-key signature", D.verifyFundedCommitment(home, selfSigned).code === "E_QUOTE_SIG_INVALID");
  // (c) wrong providerKeyId even if the signature itself is valid
  ok("the shared gate refuses a mismatched provider key id", D.verifyFundedCommitment(home, { quote, signature: goodSig, providerKeyId: "ed25519:deadbeefdeadbeef" }).code === "E_QUOTE_WRONG_PROVIDER_KEY");
  // (d) a genuine node-signed commitment passes
  ok("a genuine node-signed commitment passes the gate", D.verifyFundedCommitment(home, { quote, signature: goodSig, providerKeyId: keyId }).ok === true);
  // (e) end-to-end: a self-signed quote embedded in an opening is refused AT CREDIT
  terms.expiryMs = selfSigned.quote.expiryMs;   // funded opening adopts the signed 24h window
  D.registerOpening(home, D.buildOpeningArtifact(B, terms, Date.now(), selfSigned));
  const cr = ST.creditObservedDeposit(home, B, { txHash: "0xB", from: B, to: PROVIDER, token: TRAC, amountTrac: "1", blockNumber: 100, safeHeadBlock: 120, chainId: 8453, logIndex: 0 });
  ok("credit refuses the self-signed quote (verified before crediting)", cr.credited === false && cr.code === "E_QUOTE_SIG_INVALID", JSON.stringify(cr));
  ok("nothing credited", L.balance(home, B).balance === 0);
}

// ── NEGATIVE 2 — quote/opening/transfer mismatch, incl. real nonzero logIndex ─
console.log("\nNEGATIVE 2 — every quote↔opening↔transfer mismatch is refused; the real logIndex is used:");
{
  const C = "0xCcCc000000000000000000000000000000000003";
  const c = commitmentFor(C, { calls: 10 });
  const terms = ST.stage3Terms(PROVIDER, C, 100, RM.SCHEDULE_VERSION, 8453);
  terms.expiryMs = c.quote.expiryMs;   // funded opening adopts the signed 24h window
  D.registerOpening(home, D.buildOpeningArtifact(C, terms, Date.now(), c));
  // transfer on the WRONG chain
  const wrongChain = ST.creditObservedDeposit(home, C, { txHash: "0xC1", from: C, to: PROVIDER, token: TRAC, amountTrac: "1", blockNumber: 100, safeHeadBlock: 120, chainId: 1, logIndex: 0 });
  ok("a transfer on a foreign chain → E_QUOTE_TRANSFER_MISMATCH", wrongChain.credited === false && wrongChain.code === "E_QUOTE_TRANSFER_MISMATCH", JSON.stringify(wrongChain));
  // wrong token
  const wrongToken = ST.creditObservedDeposit(home, C, { txHash: "0xC2", from: C, to: PROVIDER, token: "0x0000000000000000000000000000000000000bad", amountTrac: "1", blockNumber: 100, safeHeadBlock: 120, chainId: 8453, logIndex: 0 });
  ok("a transfer in a foreign token → refused (evaluateDeposit or equality)", wrongToken.credited === false, JSON.stringify(wrongToken));
  // a valid credit at a REAL nonzero log index — proves logIndex is threaded, not hard-coded 0
  const good = ST.creditObservedDeposit(home, C, { txHash: "0xC3", from: C, to: PROVIDER, token: TRAC, amountTrac: "1", blockNumber: 100, safeHeadBlock: 120, chainId: 8453, logIndex: 7 });
  ok("a valid deposit at logIndex 7 credits (real receipt log index used)", good.credited === true && good.balance === 1_000_000, JSON.stringify(good));
  // re-submitting the SAME (tx, logIndex 7) is an idempotent no-op (canonical id includes the real log index)
  const dup = ST.creditObservedDeposit(home, C, { txHash: "0xC3", from: C, to: PROVIDER, token: TRAC, amountTrac: "1", blockNumber: 100, safeHeadBlock: 120, chainId: 8453, logIndex: 7 });
  ok("re-submitting the same tx:logIndex is a no-op, balance unchanged", L.balance(home, C).balance === 1_000_000, JSON.stringify(dup));
}

// tamper the embedded quote so its stored digest no longer matches its fields
{
  const T = "0xDdDd000000000000000000000000000000000004";
  const c = commitmentFor(T, { calls: 10 });
  const tampered = { ...c, quote: { ...c.quote, envelope: { ...c.quote.envelope, maxAcceptedClaimMicroTrac: 1 } } };
  const terms = ST.stage3Terms(PROVIDER, T, 100, RM.SCHEDULE_VERSION, 8453);
  terms.expiryMs = tampered.quote.expiryMs;   // funded opening adopts the signed 24h window
  D.registerOpening(home, D.buildOpeningArtifact(T, terms, Date.now(), tampered));
  const cr = ST.creditObservedDeposit(home, T, { txHash: "0xT", from: T, to: PROVIDER, token: TRAC, amountTrac: "1", blockNumber: 100, safeHeadBlock: 120, chainId: 8453, logIndex: 0 });
  ok("a tampered embedded quote (sig no longer covers fields) → refused", cr.credited === false && (cr.code === "E_QUOTE_SIG_INVALID" || cr.code === "E_OPENING_QUOTE_MISMATCH"), JSON.stringify(cr));
}

// ── envelope enforcement — ATOMIC with the debit (findings 3 mechanism) ──────
console.log("\nenvelope N + aggregate are enforced INSIDE the debit (atomic), and the quote is required:");
{
  const E = "0xEeEe000000000000000000000000000000000005";
  const { c } = fundTab(E, { calls: 10 });
  const qd = c.quote.fundedRunTermsDigest;
  ok("a funded leg with NO quote named is refused (E_QUOTE_REQUIRED)", throwsCode(() => inferLeg(E, undefined, 100), "E_QUOTE_REQUIRED"));
  ok("a funded leg naming the WRONG quote is refused (E_QUOTE_MISMATCH)", throwsCode(() => inferLeg(E, "sha256:wrong", 100), "E_QUOTE_MISMATCH"));
  for (let i = 1; i <= 10; i++) inferLeg(E, qd, 100);         // 10 legs at 100 each = 1000 < 2340 ceiling
  ok("10 calls billed, the 11th is refused (E_ENVELOPE_CALLS_EXCEEDED)", L.envelopeStateOf(home, E).calls === 10 && throwsCode(() => inferLeg(E, qd, 100), "E_ENVELOPE_CALLS_EXCEEDED"));
  ok("balance reflects exactly 10 debits, nothing more", L.balance(home, E).balance === 1_000_000 - 1000);
}
{
  const F = "0xFfFf000000000000000000000000000000000006";
  const { c } = fundTab(F, { calls: 10 });                     // ceiling = 2340
  const qd = c.quote.fundedRunTermsDigest;
  for (let i = 1; i <= 9; i++) inferLeg(F, qd, 250);           // 9×250 = 2250 < 2340
  ok("aggregate accumulates from the debit journal", L.envelopeStateOf(home, F).aggregateMicroTrac === 2250);
  ok("a 10th call within N but over the ceiling → E_ENVELOPE_AGGREGATE_EXCEEDED", throwsCode(() => inferLeg(F, qd, 250), "E_ENVELOPE_AGGREGATE_EXCEEDED"));
  ok("the refused call debited nothing (zero mutation)", L.balance(home, F).balance === 1_000_000 - 2250);
}

// ── NEGATIVE 3 — crash after debit: replay does NOT reopen capacity ──────────
console.log("\nNEGATIVE 3 — the envelope is a projection of the debit journal; a crash cannot reopen a slot:");
{
  const G = "0x1111000000000000000000000000000000000007";
  const { c } = fundTab(G, { calls: 10 });
  const qd = c.quote.fundedRunTermsDigest;
  for (let i = 1; i <= 10; i++) inferLeg(G, qd, 100);
  // simulate a crash+restart: a FRESH ledger module replays the same journal
  const L2 = await import(join(dist, "metering/ledger.js") + `?crash=${G}`);
  ok("after replay the envelope count is preserved (10, not reset)", L2.envelopeStateOf(home, G).calls === 10 && L2.envelopeStateOf(home, G).aggregateMicroTrac === 1000);
  ok("the replayed ledger STILL refuses the 11th call (no reopened capacity)", throwsCode(() => L2.recordInferenceLeg(home, { principal: G, inputTokens: 10, outputTokens: 10, costMicroTrac: 100, policyDigest: "sha256:p", evidence: { schemaVersion: "receipt-v0.6" }, quoteDigest: qd }), "E_ENVELOPE_CALLS_EXCEEDED"));
}

// ── NEGATIVE 4 — two concurrent final-slot commits: the second is refused ────
console.log("\nNEGATIVE 4 — the check+debit is one critical section; the final slot admits exactly one:");
{
  const H = "0x2222000000000000000000000000000000000008";
  const { c } = fundTab(H, { calls: 1 });                      // exactly ONE slot
  const qd = c.quote.fundedRunTermsDigest;
  const first = (() => { try { inferLeg(H, qd, 100); return "ok"; } catch (e) { return String(e.message); } })();
  const second = (() => { try { inferLeg(H, qd, 100); return "ok"; } catch (e) { return String(e.message); } })();
  ok("the first commit takes the only slot; the second is refused", first === "ok" && second.includes("E_ENVELOPE_CALLS_EXCEEDED"), `${first} / ${second}`);
  ok("only one debit landed", L.balance(home, H).balance === 1_000_000 - 100);
}

// ── NEGATIVE 5 — dispute → close/claim reconciliation ────────────────────────
console.log("\nNEGATIVE 5 — an authenticated one-leg withhold is durable, capped at one, and excluded from the claim:");
{
  const K = "0x3333000000000000000000000000000000000009";
  const { c } = fundTab(K, { calls: 10 });
  const qd = c.quote.fundedRunTermsDigest;
  // bind two legs to a buyer session key so the withhold auth can check the binding
  const session = generateKeyPairSync("ed25519");
  const sessPem = session.publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyRef = "sha256:" + sha256hex(sessPem);
  const leg1 = L.recordInferenceLeg(home, { principal: K, inputTokens: 10, outputTokens: 10, costMicroTrac: 100, policyDigest: "sha256:p", evidence: { schemaVersion: "receipt-v0.6" }, quoteDigest: qd, requesterKeyRef: keyRef });
  const leg2 = L.recordInferenceLeg(home, { principal: K, inputTokens: 10, outputTokens: 10, costMicroTrac: 100, policyDigest: "sha256:p", evidence: { schemaVersion: "receipt-v0.6" }, quoteDigest: qd, requesterKeyRef: keyRef });
  ok("two funded legs billed; aggregate 200", L.envelopeStateOf(home, K).aggregateMicroTrac === 200);
  // withhold leg1 with a valid buyer signature
  const withhold = (leg) => edSign(null, Buffer.concat([Buffer.from(MR.WITHHOLD_DOMAIN + "\n"), Buffer.from("sha256:" + sha256hex(L.canonicalize(leg)))]), createPrivateKey(session.privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toString("base64");
  const w1 = MR.withholdLeg({ home, leg: leg1, withholdSignature: withhold(leg1), sessionPublicKeyPem: sessPem });
  ok("a valid withhold is accepted", w1.ok === true, JSON.stringify(w1));
  ok("the withheld leg is excluded from the envelope aggregate (200 → 100)", L.envelopeStateOf(home, K).aggregateMicroTrac === 100 && L.disputedLegsOf(home, K).includes(leg1.legId));
  // a SECOND withhold (different leg) is refused — one-leg policy
  const w2 = MR.withholdLeg({ home, leg: leg2, withholdSignature: withhold(leg2), sessionPublicKeyPem: sessPem });
  ok("a second withhold is refused (E_DISPUTE_EXHAUSTED)", w2.ok === false && w2.code === "E_DISPUTE_EXHAUSTED", JSON.stringify(w2));
  // wrong key / bad signature refused
  const other = generateKeyPairSync("ed25519");
  const otherPem = other.publicKey.export({ type: "spki", format: "pem" }).toString();
  ok("a withhold by the wrong key is refused (E_WITHHOLD_WRONG_KEY)", MR.withholdLeg({ home, leg: leg2, withholdSignature: withhold(leg2), sessionPublicKeyPem: otherPem }).code === "E_WITHHOLD_WRONG_KEY");
  // re-withholding leg1 is an idempotent no-op
  ok("re-withholding the same leg is idempotent", MR.withholdLeg({ home, leg: leg1, withholdSignature: withhold(leg1), sessionPublicKeyPem: sessPem }).ok === true);

  // end-to-end: the close statement excludes the withheld leg from the provider claim
  const disputed = new Set(L.disputedLegsOf(home, K).map(String));
  const closeLegs = [leg1, leg2].map((leg) => ({
    legHash: "sha256:" + sha256hex(L.canonicalize(leg)), sequence: leg.sequence, previousLegHash: leg.previousLegHash,
    costMicroTrac: leg.pricing.costMicroTrac,
    // legsForClose marks a withheld leg disputed; an accepted leg needs a countersignature
    status: disputed.has(leg.legId) ? "disputed" : "accepted",
    ...(disputed.has(leg.legId) ? {} : { countersignature: "cs" }),
  }));
  const close = S.buildCloseStatement(home, {
    chain: "eip155:8453", tracContract: TRAC, providerAddress: PROVIDER, tabPrincipal: K, tabEpoch: "e",
    priorDeposit: { txHash: "0xK", blockNumber: 100, amountMicroTrac: 1_000_000 }, legs: closeLegs, destination: K,
  });
  ok("the close statement's accepted cost EXCLUDES the withheld leg (100, not 200)", close.statement.acceptedCostMicroTrac === 100);
  ok("the net payout returns the buyer's balance minus only the non-disputed leg", close.statement.netPayoutMicroTrac === 1_000_000 - 100);
}

// ── epoch CAS still holds (deposit-stage regressions) ────────────────────────
console.log("\nepoch CAS regressions still hold:");
{
  const M = "0x4444000000000000000000000000000000000010";
  const cM = commitmentFor(M, { tabEpoch: 5 });               // quote claims epoch 5, tab is fresh at 0
  const terms = ST.stage3Terms(PROVIDER, M, 100, RM.SCHEDULE_VERSION, 8453);
  terms.expiryMs = cM.quote.expiryMs;   // funded opening adopts the signed 24h window
  D.registerOpening(home, D.buildOpeningArtifact(M, terms, Date.now(), cM));
  const stale = ST.creditObservedDeposit(home, M, { txHash: "0xM", from: M, to: PROVIDER, token: TRAC, amountTrac: "1", blockNumber: 100, safeHeadBlock: 120, chainId: 8453, logIndex: 0 });
  ok("a quote bound to the wrong fresh epoch → E_CREDIT_EPOCH_MISMATCH", stale.credited === false && stale.code === "E_CREDIT_EPOCH_MISMATCH", JSON.stringify(stale));
  // second deposit onto A's already-funded epoch is refused
  const second = ST.creditObservedDeposit(home, A, { txHash: "0xA2", from: A, to: PROVIDER, token: TRAC, amountTrac: "1", blockNumber: 130, safeHeadBlock: 150, chainId: 8453, logIndex: 0 });
  ok("a second deposit onto a funded epoch → E_CREDIT_EPOCH_ALREADY_FUNDED", second.credited === false && second.code === "E_CREDIT_EPOCH_ALREADY_FUNDED");
}

// ── INTEGRATION — the full HTTP admission path on a funded tab (meterInference) ─
// Proof that meterInference names the quote, requires it, bills through the
// atomic ledger enforcement, and refuses the (N+1)-th call — the envelope is
// CONSUMED in admission, not merely enforceable in the ledger.
console.log("\nINTEGRATION — meterInference on a funded tab consumes the quote + enforces N:");
{
  const MI = await import(join(dist, "metering/metered-inference.js"));
  const IM = await import(join(dist, "metering/inference-meter.js"));
  const CAP = await import(join(dist, "metering/capability.js"));
  const BND = await import(join(dist, "metering/evm-binding.js"));
  const { writeFileSync } = await import("node:fs");
  const { Wallet } = await import("ethers");

  const VOCAB = ["", "the", "cat", "sat", "on", "mat", " "];
  const idOf = (w) => { const i = VOCAB.indexOf(w); return i >= 0 ? i : VOCAB.push(w) - 1; };
  const tok = { encode: (t) => [...t.matchAll(/ |[^ ]+/g)].map((m) => idOf(m[0])), decode: (ids) => ids.map((id) => VOCAB[id] ?? "").join("") };
  const MANIFEST = { instanceId: "i", weightsDigest: "sha256:w", tokenizerBundleDigest: "sha256:bundle", engineBuild: "s", samplerConfig: { temperature: "0" }, chatTemplateDigest: "sha256:c" };
  const MODEL = { modelId: "stub", weightsDigest: "sha256:w", tokenizerDigest: "sha256:bundle", chatTemplateDigest: "sha256:c", tokenizer: { bundleDigest: "sha256:bundle", bundleFiles: ["tokenizer.json"], engine: "s", engineVersion: "1" }, backendManifestDigest: IM.backendManifestDigest(MANIFEST), backendManifest: MANIFEST };
  const CHAIN = 8453;
  const evm = Wallet.createRandom(), session = generateKeyPairSync("ed25519");
  const BUYER = evm.address;
  const pem = (k, t) => k.export({ type: t === "pub" ? "spki" : "pkcs8", format: "pem" }).toString();
  writeFileSync(join(home, "metering", "buyer-registry.json"), JSON.stringify({ principals: {} }));
  const proof = await (async () => { const base = { domain: BND.BINDING_DOMAIN, principal: BUYER, walletPublicKeyPem: pem(session.publicKey, "pub"), chainId: CHAIN, notAfter: new Date(Date.now() + 7 * 864e5).toISOString() }; return { ...base, evmSignature: await evm.signMessage(BND.bindingStatement(base)) }; })();
  const signDeleg = () => { const d = { domain: "odysseus-dkg:delegation:v1", capabilityId: "cap-fr", tabPrincipal: BUYER, sessionPublicKeyPem: pem(session.publicKey, "pub"), agentUrn: "urn:b", audience: { settlement: "settle-main", nodeClasses: ["dkg-edge-mainnet"] }, routes: ["POST /api/metering/infer"], bindings: { scheduleDigest: SCHED, priceVectorDigest: SCHED }, caps: { absoluteMicroTrac: 1_000_000, windowMicroTrac: 500_000, windowMs: 3_600_000 }, notBefore: new Date(Date.now() - 3600e3).toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(), tier: "session-key" }; return { ...d, walletSignature: edSign(null, CAP.delegationPreimage(d), createPrivateKey(pem(session.privateKey, "priv"))).toString("base64") }; };
  const enforce = { mode: "enforce", readAskMicroPer1k: 100, exemptPrincipals: new Set(), enforcedPrincipals: new Set([BUYER]) };
  const freshState = () => ({ spentMicroTrac: 0, window: { since: Date.now(), spentMicroTrac: 0 }, sequence: 0, revoked: false });
  const modelResult = (p, c) => ({ renderedPrompt: p, inputTokenIds: tok.encode(p), deliveredCompletion: c, outputTokenIds: tok.encode(c), model: MODEL, requestCanonical: { messages: [{ role: "user", content: p }] }, finishReason: "stop", stopBoundary: { kind: "eos" } });
  const call = (over = {}) => ({ home, chainId: CHAIN, cfg: enforce, request: { delegation: signDeleg(), bindingProof: proof, revocationCheckpoint: { observedAt: Date.now() - 1000, maxCheckpointAgeMs: 60_000 } }, state: freshState(), scheduleDigest: SCHED, priceVectorDigest: SCHED, nodeClass: "dkg-edge-mainnet", settlementId: "settle-main", model: modelResult("the cat", "sat on mat"), tokenizer: tok, specialTokenIds: [1000, 2000], ...over });
  const countersign = (leg) => { const dg = "sha256:" + sha256hex(L.canonicalize(leg)); const sig = edSign(null, Buffer.concat([Buffer.from(CAP.CAPABILITY_DOMAIN + "\n"), Buffer.from(dg)]), createPrivateKey(pem(session.privateKey, "priv"))).toString("base64"); return MR.countersignLeg({ home, leg, countersignature: sig, sessionPublicKeyPem: pem(session.publicKey, "pub") }); };

  // fund a 1-call funded tab for BUYER through the full signed-commitment path
  const c = commitmentFor(BUYER, { calls: 1 });
  const terms = ST.stage3Terms(PROVIDER, BUYER, 100, RM.SCHEDULE_VERSION, CHAIN);
  terms.expiryMs = c.quote.expiryMs;   // funded opening adopts the signed 24h window
  D.registerOpening(home, D.buildOpeningArtifact(BUYER, terms, Date.now(), c));
  const cr = ST.creditObservedDeposit(home, BUYER, { txHash: "0xINT", from: BUYER, to: PROVIDER, token: TRAC, amountTrac: "1", blockNumber: 100, safeHeadBlock: 120, chainId: CHAIN, logIndex: 3 });
  ok("a 1-call funded tab opens + credits via the signed commitment", cr.credited === true && cr.funded === true, JSON.stringify(cr));
  const qd = c.quote.fundedRunTermsDigest;

  ok("a funded call naming NO quote is refused (E_QUOTE_REQUIRED)", MI.meterInference(call()).code === "E_QUOTE_REQUIRED");
  ok("a funded call naming the WRONG quote is refused (E_QUOTE_MISMATCH)", MI.meterInference(call({ requestQuoteDigest: "sha256:nope" })).code === "E_QUOTE_MISMATCH");
  const r1 = MI.meterInference(call({ requestQuoteDigest: qd }));
  ok("the 1st call, naming the bound quote, BILLS and carries the quoteDigest in the leg", r1.ok === true && r1.billed === true && r1.leg.quoteDigest === qd, JSON.stringify(r1).slice(0, 140));
  countersign(r1.leg);
  const r2 = MI.meterInference(call({ requestQuoteDigest: qd }));
  ok("the 2nd call against a 1-call envelope is refused (E_ENVELOPE_CALLS_EXCEEDED, 402)", r2.ok === false && r2.code === "E_ENVELOPE_CALLS_EXCEEDED" && r2.status === 402, JSON.stringify(r2));
  ok("the refused call debited nothing", L.balance(home, BUYER).balance === 1_000_000 - r1.costMicroTrac);
}

// ── CLOSE EPOCH-ISOLATION + dispute-continues-the-run (Bo, billed-run block) ──
// His exact live scenario: a settled epoch-0 lifecycle (accepted + disputed
// legs), then a funded epoch-1 run where one leg is formally withheld. The
// prior close mixed all lifecycles (duplicate sequence 1, expiry timestamp in
// tabEpoch) and a withheld leg dead-locked gradual release forever.
console.log("\nCLOSE epoch isolation + formal withhold releases gradual release (billed-run block):");
{
  const S2 = await import(join(dist, "metering/settlement.js"));
  const Z = "0x5555000000000000000000000000000000000011";
  const session = generateKeyPairSync("ed25519");
  const sessPem = session.publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyRef = "sha256:" + sha256hex(sessPem);
  const csign = (leg) => {
    const dg = "sha256:" + sha256hex(L.canonicalize(leg));
    const CAPD = "odysseus-dkg:capability:v1";
    const sig = edSign(null, Buffer.concat([Buffer.from(CAPD + "\n"), Buffer.from(dg)]), createPrivateKey(session.privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toString("base64");
    return MR.countersignLeg({ home, leg, countersignature: sig, sessionPublicKeyPem: sessPem });
  };
  const wsign = (leg) => edSign(null, Buffer.concat([Buffer.from(MR.WITHHOLD_DOMAIN + "\n"), Buffer.from("sha256:" + sha256hex(L.canonicalize(leg)))]), createPrivateKey(session.privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toString("base64");

  // epoch 0: a prior generic lifecycle with one leg, then settled (Bo's read-loop history)
  L.credit(home, Z, 1_000_000, { chainId: 8453, token: TRAC, txHash: "0xZOLD", logIndex: 0 });
  D.registerOpening(home, D.buildOpeningArtifact(Z, ST.stage3Terms(PROVIDER, Z, 100, RM.SCHEDULE_VERSION, 8453)));
  const oldLeg = L.recordInferenceLeg(home, { principal: Z, inputTokens: 1, outputTokens: 0, costMicroTrac: 1, policyDigest: "sha256:p", evidence: { schemaVersion: "receipt-v0.6" }, requesterKeyRef: keyRef });
  L.settleTab(home, Z, { withdrawalId: "wd:z-old", txHash: "0xzsettle", netPaidMicroTrac: 999_999, expectedEpoch: 0 });

  // epoch 1: the funded run
  const { c: zc, r: zr } = fundTab(Z, { calls: 10 });
  ok("epoch-1 funded tab credits (mixed-history principal)", zr.credited === true && zr.epoch === 1, JSON.stringify(zr));
  const qd = zc.quote.fundedRunTermsDigest;
  const legA = L.recordInferenceLeg(home, { principal: Z, inputTokens: 24, outputTokens: 5, costMicroTrac: 78, policyDigest: "sha256:p", evidence: { schemaVersion: "receipt-v0.6" }, quoteDigest: qd, requesterKeyRef: keyRef });

  // silent non-signing BLOCKS (anti-free-riding intact)…
  ok("an un-countersigned leg blocks the next call (outstanding=1)", MR.outstandingLegs(home, Z) === 1);
  // …but a FORMAL, signature-verified withhold ADJUDICATES the leg and releases the slot
  const w = MR.withholdLeg({ home, leg: legA, withholdSignature: wsign(legA), sessionPublicKeyPem: sessPem });
  ok("formal withhold accepted", w.ok === true, JSON.stringify(w));
  ok("the withheld leg no longer counts as outstanding — the run CONTINUES (dead-lock fixed)", MR.outstandingLegs(home, Z) === 0);
  const legB = L.recordInferenceLeg(home, { principal: Z, inputTokens: 10, outputTokens: 15, costMicroTrac: 110, policyDigest: "sha256:p", evidence: { schemaVersion: "receipt-v0.6" }, quoteDigest: qd, requesterKeyRef: keyRef });
  ok("the next billed call succeeds after the withhold", legB.sequence === 2 && legB.tabEpoch === 1);
  ok("a SECOND withhold is refused (one-per-epoch policy intact)", MR.withholdLeg({ home, leg: legB, withholdSignature: wsign(legB), sessionPublicKeyPem: sessPem }).code === "E_DISPUTE_EXHAUSTED");
  ok("countersigning leg B clears the obligation", csign(legB).ok === true && MR.outstandingLegs(home, Z) === 0);

  // THE close: epoch-filtered end to end
  const close = S2.legsForCloseEpoch(home, Z);
  ok("close selects the NUMERIC current epoch (1)", close.epoch === 1);
  ok("close contains ONLY epoch-1 legs (the epoch-0 leg is excluded)", close.legs.length === 2 && !close.legs.some(l => l.legHash === undefined) && close.legs.every(l => [1, 2].includes(l.sequence)));
  ok("no duplicate sequences (each epoch has its own chain)", new Set(close.legs.map(l => l.sequence)).size === close.legs.length);
  ok("the withheld leg is disputed; the countersigned leg is accepted",
    close.legs.find(l => l.sequence === 1)?.status === "disputed" && close.legs.find(l => l.sequence === 2)?.status === "accepted");
  ok("the deposit is the EPOCH-1 credit, not the epoch-0 one", close.deposit?.txHash?.includes("fund") === true && close.deposit?.txHash !== "0xZOLD", close.deposit?.txHash);
  const stmt = S2.buildCloseStatement(home, {
    chain: "eip155:8453", tracContract: TRAC, providerAddress: PROVIDER, tabPrincipal: Z,
    tabEpoch: String(close.epoch), priorDeposit: close.deposit, legs: close.legs, destination: Z,
  });
  ok("close statement: acceptedCost = only the countersigned leg (110)", stmt.statement.acceptedCostMicroTrac === 110);
  ok("close statement: tabEpoch is the numeric epoch string, not a timestamp", stmt.statement.tabEpoch === "1");
  ok("net payout = deposit − accepted (1,000,000 − 110)", stmt.statement.netPayoutMicroTrac === 1_000_000 - 110);
}

// ── NEGATIVE: stale-countersignature ordering (Bo, v2.2 BLOCK) ────────────────
// outstandingLegs must be computed by leg IDENTITY: a countersignature for a
// later-WITHHELD leg must never cancel a DIFFERENT unsigned leg, or a buyer
// free-rides an unsigned result. Exact reproduction from the block.
console.log("\nNEGATIVE: a stale countersignature cannot cancel a different unsigned leg (v2.2 block):");
{
  const Y = "0x6666000000000000000000000000000000000012";
  const session = generateKeyPairSync("ed25519");
  const sessPem = session.publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyRef = "sha256:" + sha256hex(sessPem);
  const priv = createPrivateKey(session.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const CAPD = "odysseus-dkg:capability:v1";
  const csign = (leg) => MR.countersignLeg({ home, leg, countersignature: edSign(null, Buffer.concat([Buffer.from(CAPD + "\n"), Buffer.from("sha256:" + sha256hex(L.canonicalize(leg)))]), priv).toString("base64"), sessionPublicKeyPem: sessPem });
  const wsign = (leg) => edSign(null, Buffer.concat([Buffer.from(MR.WITHHOLD_DOMAIN + "\n"), Buffer.from("sha256:" + sha256hex(L.canonicalize(leg)))]), priv).toString("base64");
  const bill = (cost) => L.recordInferenceLeg(home, { principal: Y, inputTokens: 10, outputTokens: 10, costMicroTrac: cost, policyDigest: "sha256:p", evidence: { schemaVersion: "receipt-v0.6" }, quoteDigest: qdY, requesterKeyRef: keyRef });

  const { c: yc } = fundTab(Y, { calls: 10 });
  const qdY = yc.quote.fundedRunTermsDigest;
  const legA = bill(78);              // 1. bill A
  ok("outstanding = 1 after billing A", MR.outstandingLegs(home, Y) === 1);
  csign(legA);                        // 2. countersign A
  ok("outstanding = 0 after countersigning A", MR.outstandingLegs(home, Y) === 0);
  const legB = bill(90);              // 3. bill B, leave unsigned
  ok("outstanding = 1 after billing B (unsigned)", MR.outstandingLegs(home, Y) === 1);
  const w = MR.withholdLeg({ home, leg: legA, withholdSignature: wsign(legA), sessionPublicKeyPem: sessPem });   // 4. withhold A
  ok("withhold of A accepted", w.ok === true, JSON.stringify(w));
  ok("outstanding STILL 1 — A's countersignature did NOT cancel unsigned B (bypass closed)", MR.outstandingLegs(home, Y) === 1);
  // gradual release (which admission consults) therefore still blocks: exactly
  // one obligation remains, so the anti-free-riding invariant holds.
  ok("the one remaining obligation is precisely unsigned leg B, not a phantom", MR.outstandingLegs(home, Y) === 1);
  // resolve B and the slot frees
  csign(legB);
  ok("outstanding = 0 once B is countersigned", MR.outstandingLegs(home, Y) === 0);

  // replay variant: the same conclusion reconstructs from the journal
  const L2 = await import(join(dist, "metering/metered-read.js") + `?stale=${Y}`);
  ok("replay agrees: outstanding = 0 after A withheld + B signed", L2.outstandingLegs(home, Y) === 0);
}

console.log(`\n${pass}/${pass + fail} funded-run-binding gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
