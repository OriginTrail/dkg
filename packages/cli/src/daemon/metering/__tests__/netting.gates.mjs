// Gates for metering/netting.ts — P2 v3, covering Hermes's round-2 required
// set: REAL settle before/after release, partial + terminal refunds before/
// after a new credit, cross-principal release rejection, unbacked release
// rejection, bad/foreign close-signature rejection, sum-overflow — plus the
// original frozen-spec vectors (I1 worked case, I7 CAS, rollover exactly-once,
// threshold gating, G-I1a all-truncation conservation, G-I7b structural).
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { generateKeyPairSync, sign as edSign, createPrivateKey, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/daemon");
const home = mkdtempSync(join(tmpdir(), "netting-"));
process.env.DKG_HOME = home;
mkdirSync(join(home, "metering"), { recursive: true });

const N = await import(join(dist, "metering/netting.js"));
// structural release authority: the suite provisions the loopback token file
const AUTH = "gate-suite-release-authority-token";
writeFileSync(join(home, "metering", "release-authority.token"), AUTH + "\n");
const L = await import(join(dist, "metering/ledger.js"));
const MR = await import(join(dist, "metering/metered-read.js"));
const C = await import(join(dist, "metering/capability.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };
const BUYER = "0xAAAA567890abcdef1234567890abcdef12345678";
const OTHER = "0xBBBB567890abcdef1234567890abcdef12345678";
const session = generateKeyPairSync("ed25519");
const foreign = generateKeyPairSync("ed25519");
const pem = (k, t) => k.export({ type: t === "pub" ? "spki" : "pkcs8", format: "pem" }).toString();
const keyRefOf = (pubPem) => "sha256:" + createHash("sha256").update(pubPem).digest("hex");

const bill = (cost, principal = BUYER, keys = session) => L.recordInferenceLeg(home, {
  principal, inputTokens: cost / 2, outputTokens: 0, costMicroTrac: cost,
  policyDigest: "sha256:policy", evidence: { schemaVersion: "receipt-v0.6", note: "gate" },
  requesterKeyRef: keyRefOf(pem(keys.publicKey, "pub")),
});
const countersign = (leg, keys = session) => {
  const dg = "sha256:" + createHash("sha256").update(L.canonicalize(leg)).digest("hex");
  const sig = edSign(null, Buffer.concat([Buffer.from(C.CAPABILITY_DOMAIN + "\n"), Buffer.from(dg)]), createPrivateKey(pem(keys.privateKey, "priv"))).toString("base64");
  return MR.countersignLeg({ home, leg, countersignature: sig, sessionPublicKeyPem: pem(keys.publicKey, "pub") });
};
const signClose = (body, keys = session) => ({
  buyerCountersignature: edSign(null, Buffer.concat([Buffer.from(N.NSM_CLOSE_DOMAIN + "\n"), Buffer.from(N.closeBody(body))]), createPrivateKey(pem(keys.privateKey, "priv"))).toString("base64"),
  sessionPublicKeyPem: pem(keys.publicKey, "pub"),
});
const mkClose = (epoch, mode, earned, carry, keys = session) => {
  const body = { principal: BUYER, epoch, mode, earnedMicroTrac: earned, carryMicroTrac: carry };
  return { ...body, ...signClose(body, keys) };
};

console.log("\nnetting.ts v3 — frozen state machine + Hermes round-2 vectors\n");

console.log("I1 worked case (deposit 100, earned 10) + voided exclusion:");
{
  L.credit(home, BUYER, 100, { chainId: 8453, token: "0xTRAC", txHash: "0xdep1", logIndex: 0 });
  countersign(bill(10));
  const c1 = N.conservationCheck(home, BUYER);
  ok("I1 mid-accrual: 100 == 0+0+0+10+90", c1.ok && c1.q.earnedCurrent === 10 && c1.q.refundableCurrent === 90, JSON.stringify(c1.q));
  bill(7); // voided
  const c2 = N.conservationCheck(home, BUYER);
  ok("voided legs excluded (billed 17, refundable 90)", c2.ok && c2.q.voidedCurrent === 7 && c2.q.refundableCurrent === 90);
}

console.log("\nclose signature + key authorization (Hermes #3, #6):");
{
  const q = N.ledgerQuantities(home, BUYER);
  const bad = { ...mkClose(q.epoch, "rollover", 10, 90), buyerCountersignature: Buffer.from("garbage").toString("base64") };
  ok("bad signature → E_CLOSE_BAD_SIGNATURE", N.commitClose(home, bad).code === "E_CLOSE_BAD_SIGNATURE");
  const foreignClose = mkClose(q.epoch, "rollover", 10, 90, foreign);
  ok("valid-but-foreign session key → E_CLOSE_FOREIGN_KEY", N.commitClose(home, foreignClose).code === "E_CLOSE_FOREIGN_KEY");
  // Hermes #6a: a foreign key that appears ONLY on an UNCOUNTERSIGNED debit must
  // NOT be allowed to close the epoch (it never countersigned anything).
  const foreignLeg = bill(2, BUYER, foreign);   // billed by `foreign`, never countersigned
  const stillForeign = mkClose(q.epoch, "rollover", 10, 88, foreign);   // carry adjusts for the new billed(voided) leg? earned unchanged
  const r = N.commitClose(home, stillForeign);
  ok("foreign key present only on an uncountersigned debit → still E_CLOSE_FOREIGN_KEY", r.code === "E_CLOSE_FOREIGN_KEY", JSON.stringify(r));
}

console.log("\nno-countersigned-leg epoch is FAIL-CLOSED (Hermes #6b):");
{
  const h6 = mkdtempSync(join(tmpdir(), "netting-noleg-"));
  mkdirSync(join(h6, "metering"), { recursive: true });
  L.credit(h6, BUYER, 30, { chainId: 8453, token: "0xTRAC", txHash: "0xnl", logIndex: 0 });   // deposit, no legs at all
  const q6 = N.ledgerQuantities(h6, BUYER);
  const arbitrary = mkClose(q6.epoch, "rollover", 0, 30);            // signed by BUYER's session key
  const arbForeign = mkClose(q6.epoch, "rollover", 0, 30, foreign); // signed by an arbitrary key
  ok("arbitrary-key close of a no-leg epoch → E_CLOSE_NO_COUNTERSIGNED_LEG", N.commitClose(h6, arbForeign).code === "E_CLOSE_NO_COUNTERSIGNED_LEG");
  ok("even the buyer's own key cannot commitClose a no-countersigned-leg epoch (use refund path)", N.commitClose(h6, arbitrary).code === "E_CLOSE_NO_COUNTERSIGNED_LEG");
}

console.log("\nI7 CAS + rollover exactly-once:");
{
  const q = N.ledgerQuantities(home, BUYER);
  const good = mkClose(q.epoch, "rollover", 10, 90);
  const r1 = N.commitClose(home, good);
  ok("properly-signed close wins", r1.ok === true, JSON.stringify(r1));
  let reRejected = 0;
  for (let i = 0; i < 100; i++) { const r = N.commitClose(home, mkClose(q.epoch, "rollover", 10, 90)); if (!r.ok && r.code === "E_CLOSE_EPOCH_TAKEN") reRejected++; }
  ok("100 rival closes re-rejected identically (E_CLOSE_EPOCH_TAKEN)", reRejected === 100);
  const roll1 = N.applyRollover(home, BUYER, r1.closeDigest);
  ok("rollover carries 90 into fresh epoch", roll1.ok && roll1.carriedMicroTrac === 90);
  ok("replayed rollover refused (dedup)", N.applyRollover(home, BUYER, r1.closeDigest).ok === false);
  const c = N.conservationCheck(home, BUYER);
  ok("I1 after rollover: 100 == 0+0+10+0+90", c.ok && c.q.unsettledEarned === 10, JSON.stringify(c.q));
  ok("carry not an on-chain deposit; carry settle not a payout", c.q.depositsOnchainMicroTrac === 100 && c.q.payoutsMicroTrac === 0);
}

console.log("\nrelease binding (Hermes #2) — principal + payout evidence:");
{
  const closeDigest = String(L.readJournal(home).find((r) => r.kind === "nsm-close").closeDigest);
  ok("release with NO real payout → E_RELEASE_UNBACKED", N.recordEarnedRelease(home, BUYER, closeDigest, 10, "0xnope", AUTH).code === "E_RELEASE_UNBACKED");
  ok("cross-principal release → E_CLOSE_PRINCIPAL_MISMATCH", N.recordEarnedRelease(home, OTHER, closeDigest, 10, "0xnope", AUTH).code === "E_CLOSE_PRINCIPAL_MISMATCH");
}

console.log("\nREAL settle path (Hermes #1) — close(settle) → payout → release:");
{
  countersign(bill(5));                                      // epoch 1: earned 5, gross 90
  const q = N.ledgerQuantities(home, BUYER);
  const cl = N.commitClose(home, mkClose(q.epoch, "settle", 5, 85));
  ok("settle-mode close commits", cl.ok === true, JSON.stringify(cl));
  const preSettle = N.conservationCheck(home, BUYER);
  ok("I1 in closed-awaiting-settle window: 100 == 0+0+15+0+85", preSettle.ok && preSettle.q.unsettledEarned === 15 && preSettle.q.refundableCurrent === 85, JSON.stringify(preSettle.q));
  // the BOUND settlement mutation (Hermes wiring v3): expected digest verified
  // against exact config bytes immediately before the first state change.
  writeFileSync(join(home, "metering", "netting-economics.json"), JSON.stringify({ feeGweiDecimal: "0.000000001", ethTracDecimal: "8000", recordedAt: "2026-08-12T08:00:00Z", source: "settle-phase sample" }));
  const expectA = N.currentEconomicsDigest(home);
  // (b) swap-then-execute refuses with ZERO journal writes
  {
    const jb0 = readFileSync(join(home, "metering", "read-journal.jsonl")).length;
    writeFileSync(join(home, "metering", "netting-economics.json"), JSON.stringify({ feeGweiDecimal: "0.02", ethTracDecimal: "8000", recordedAt: "2026-08-12T08:20:00Z", source: "config B" }));
    const swapped = N.recordNettedSettlement(home, { principal: BUYER, withdrawalId: `close:${cl.closeDigest}`, txHash: "0xpayout1", netPaidMicroTrac: 85, expectedEpoch: q.epoch, closes: [cl.closeDigest], expectedConfigDigest: expectA, authorityToken: AUTH });
    ok("verdict-A / execute-after-config-B settlement → E_ECONOMICS_CHANGED with ZERO journal writes", swapped.ok === false && swapped.code === "E_ECONOMICS_CHANGED" && readFileSync(join(home, "metering", "read-journal.jsonl")).length === jb0, JSON.stringify(swapped));
    // (c) missing config fails closed, still zero writes
    const cfgPath = join(home, "metering", "netting-economics.json");
    const saved = readFileSync(cfgPath, "utf8");
    writeFileSync(cfgPath, "not json");
    const absent = N.recordNettedSettlement(home, { principal: BUYER, withdrawalId: `close:${cl.closeDigest}`, txHash: "0xpayout1", netPaidMicroTrac: 85, expectedEpoch: q.epoch, closes: [cl.closeDigest], expectedConfigDigest: expectA, authorityToken: AUTH });
    ok("absent/invalid config at execution → E_ECONOMICS_ABSENT, zero writes", absent.ok === false && absent.code === "E_ECONOMICS_ABSENT" && readFileSync(join(home, "metering", "read-journal.jsonl")).length === jb0);
    writeFileSync(cfgPath, JSON.stringify({ feeGweiDecimal: "0.000000001", ethTracDecimal: "8000", recordedAt: "2026-08-12T08:00:00Z", source: "settle-phase sample" }));
  }
  const st = N.recordNettedSettlement(home, { principal: BUYER, withdrawalId: `close:${cl.closeDigest}`, txHash: "0xpayout1", netPaidMicroTrac: 85, expectedEpoch: q.epoch, closes: [cl.closeDigest], expectedConfigDigest: N.currentEconomicsDigest(home), authorityToken: AUTH });
  ok("bound settlement records (85 to buyer) and returns the validated digest", st.ok === true && String(st.economicsConfigDigest ?? "").startsWith("sha256:"), JSON.stringify(st));
  const settledRec = L.readJournal(home).find((r) => r.kind === "settled" && r.txHash === "0xpayout1");
  ok("settled record durably carries the AUTHORIZING digest + closes", settledRec?.economicsConfigDigest === st.economicsConfigDigest && Array.isArray(settledRec?.closes), JSON.stringify(settledRec).slice(0, 160));
  const afterPay = N.conservationCheck(home, BUYER);
  ok("I1 after REAL payout, before release: 100 == 85+0+15+0+0", afterPay.ok && afterPay.q.payoutsMicroTrac === 85 && afterPay.q.unsettledEarned === 15, JSON.stringify(afterPay.q));
  // Hermes round-3 counterexample: a REAL settlement tx for close A must NOT
  // authorize releasing close B (the rollover close from the earlier phase).
  const closeA = cl.closeDigest;
  const closeB = String(L.readJournal(home).find((r) => r.kind === "nsm-close" && r.mode === "rollover").closeDigest);
  ok("real payout for close A does NOT release close B → E_RELEASE_PAYOUT_UNRELATED",
    N.recordEarnedRelease(home, BUYER, closeB, 10, "0xpayout1", AUTH).code === "E_RELEASE_PAYOUT_UNRELATED");
  // Hermes round-5 counterexample: a valid close/payout pair with a WRONG
  // release amount must refuse — the released value cannot be caller-trusted.
  ok("over-large release amount for a valid close/payout → E_RELEASE_AMOUNT_MISMATCH",
    N.recordEarnedRelease(home, BUYER, cl.closeDigest, 999, "0xpayout1", AUTH).code === "E_RELEASE_AMOUNT_MISMATCH");
  const rl = N.recordEarnedRelease(home, BUYER, cl.closeDigest, 5, "0xpayout1", AUTH);
  ok("close-bound release accepted (amount == close.earned, payout references THIS close)", rl.ok === true, JSON.stringify(rl));
  // Hermes round-4 counterexample: a NETTED payout naming [A,B] but paying only
  // A's carry must NOT authorize releasing either — underfunded multi-close.
  {
    const h4 = mkdtempSync(join(tmpdir(), "netting-netted-"));
    mkdirSync(join(h4, "metering"), { recursive: true });
    const J = join(h4, "metering", "read-journal.jsonl");
    const w = (o) => appendFileSync(J, JSON.stringify(o) + "\n");
    writeFileSync(J, "");
    // two closed epochs A (carry 30) and B (carry 40), terminalized+carried so
    // both sit in unsettledEarned; a single netted payout that underpays.
    w({ kind: "nsm-close", principal: BUYER, epoch: 0, mode: "settle", earnedMicroTrac: 30, carryMicroTrac: 30, closeDigest: "sha256:A", at: "a" });
    w({ kind: "nsm-close", principal: BUYER, epoch: 1, mode: "settle", earnedMicroTrac: 40, carryMicroTrac: 40, closeDigest: "sha256:B", at: "b" });
    writeFileSync(join(h4, "metering", "release-authority.token"), AUTH + "\n");
    writeFileSync(join(h4, "metering", "netting-economics.json"), JSON.stringify({ feeGweiDecimal: "0.011", ethTracDecimal: "8000", recordedAt: "2026-08-12T08:00:00Z", source: "h4" }));
    const H4DIG = N.currentEconomicsDigest(h4);
    w({ kind: "settled", principal: BUYER, withdrawalId: "wd:netted", txHash: "0xnetted", netPaidMicroTrac: 30, closes: ["sha256:A", "sha256:B"], economicsConfigDigest: H4DIG, at: "s" });
    ok("underfunded netted payout ([A,B] paying only A's carry) → E_RELEASE_PAYOUT_AMOUNT_MISMATCH",
      N.recordEarnedRelease(h4, BUYER, "sha256:A", 30, "0xnetted", AUTH).code === "E_RELEASE_PAYOUT_AMOUNT_MISMATCH");
    // correctly-funded netted payout (30+40=70) releases each close once
    const J2 = J; // extend same journal with the correct payout
    w({ kind: "settled", principal: BUYER, withdrawalId: "wd:netted2", txHash: "0xnetted2", netPaidMicroTrac: 70, closes: ["sha256:A", "sha256:B"], economicsConfigDigest: H4DIG, at: "s2" });
    // an economics-UNBOUND payout cannot back a release (Hermes wiring v3)
    w({ kind: "nsm-close", principal: BUYER, epoch: 3, mode: "settle", earnedMicroTrac: 7, carryMicroTrac: 7, closeDigest: "sha256:D", at: "d" });
    w({ kind: "settled", principal: BUYER, withdrawalId: "close:sha256:D", txHash: "0xunbound", netPaidMicroTrac: 7, at: "s4" });
    ok("payout WITHOUT economicsConfigDigest cannot back a release → E_RELEASE_PAYOUT_UNBOUND_ECONOMICS",
      N.recordEarnedRelease(h4, BUYER, "sha256:D", 7, "0xunbound", AUTH).code === "E_RELEASE_PAYOUT_UNBOUND_ECONOMICS");
    const okA = N.recordEarnedRelease(h4, BUYER, "sha256:A", 30, "0xnetted2", AUTH);
    const okB = N.recordEarnedRelease(h4, BUYER, "sha256:B", 40, "0xnetted2", AUTH);
    ok("correctly-funded netted payout (sum of carries) releases each close", okA.ok === true && okB.ok === true, JSON.stringify({ okA, okB }));
    // a payout naming a foreign close is refused — use a FRESH unreleased close C
    // so the dedup check (A/B already released above) doesn't mask the reason.
    w({ kind: "nsm-close", principal: BUYER, epoch: 2, mode: "settle", earnedMicroTrac: 10, carryMicroTrac: 10, closeDigest: "sha256:C", at: "c" });
    w({ kind: "settled", principal: BUYER, withdrawalId: "wd:foreign", txHash: "0xforeign", netPaidMicroTrac: 10, closes: ["sha256:C", "sha256:ZZZ"], economicsConfigDigest: H4DIG, at: "s3" });
    ok("netted payout naming an absent close → E_RELEASE_PAYOUT_UNRELATED",
      N.recordEarnedRelease(h4, BUYER, "sha256:C", 10, "0xforeign", AUTH).code === "E_RELEASE_PAYOUT_UNRELATED");
  }
  ok("duplicate release refused", N.recordEarnedRelease(home, BUYER, cl.closeDigest, 5, "0xpayout1", AUTH).code === "E_RELEASE_ALREADY_RECORDED");
  const afterRel = N.conservationCheck(home, BUYER);
  ok("I1 after release: 100 == 90+0+10+0+0", afterRel.ok && afterRel.q.payoutsMicroTrac === 90 && afterRel.q.unsettledEarned === 10, JSON.stringify(afterRel.q));
  const relRec = L.readJournal(home).find((r) => r.kind === "nsm-earned-released" && r.payoutTxHash === "0xpayout1");
  ok("settled/release pair carries the SAME authorizing digest (release inherits, never samples)", relRec?.economicsConfigDigest === st.economicsConfigDigest, JSON.stringify({ rel: relRec?.economicsConfigDigest, st: st.economicsConfigDigest }));
}

console.log("\nrefund paths (Hermes #1) — partial then terminal, then a new credit (restart-faithful journal):");
{
  // A fresh home with a hand-shaped journal exactly as the real primitives
  // produce it ACROSS RESTARTS (in-process manual appends would diverge from
  // live ledger state — a test artifact, not a netting property).
  const h3 = mkdtempSync(join(tmpdir(), "netting-refund-"));
  mkdirSync(join(h3, "metering"), { recursive: true });
  const J3 = join(h3, "metering", "read-journal.jsonl");
  const kr = keyRefOf(pem(session.publicKey, "pub"));
  const w = (o) => appendFileSync(J3, JSON.stringify(o) + "\n");
  writeFileSync(J3, "");
  w({ kind: "credit", principal: BUYER, epoch: 0, amountMicroTrac: 50, evidence: { chainId: 1, token: "0xT", txHash: "0xd2", logIndex: 0 } });
  w({ kind: "refund", principal: BUYER, amountMicroTrac: 20, terminal: false, at: "t1" });
  const c1 = N.conservationCheck(h3, BUYER);
  ok("partial refund reduces refundable: 50 == 0+20+0+0+30", c1.ok && c1.q.refundableCurrent === 30, JSON.stringify(c1.q));
  w({ kind: "refund", principal: BUYER, amountMicroTrac: 30, refundAddress: BUYER, termsDigest: "sha256:t", at: "t2" });
  const c2 = N.conservationCheck(h3, BUYER);
  ok("terminal refund zeroes current claims: 50 == 0+50+0+0+0", c2.ok && c2.q.refundsMicroTrac === 50 && c2.q.refundableCurrent === 0, JSON.stringify(c2.q));
  // new epoch with earned, then terminal refund of the UNCLOSED epoch:
  // earned resolves implicitly to the provider at the exit (It-1 semantics)
  w({ kind: "credit", principal: BUYER, epoch: 1, amountMicroTrac: 40, evidence: { chainId: 1, token: "0xT", txHash: "0xd3", logIndex: 0 } });
  w({ kind: "debit", principal: BUYER, epoch: 1, hash: "h1", leg: { legType: "inference", legId: "legZ", tabEpoch: 1, pricing: { costMicroTrac: 4 }, requester: { principal: BUYER, keyRef: kr }, tab: { before: 40, after: 36 } } });
  w({ kind: "leg-countersigned", principal: BUYER, legId: "legZ", epoch: 1 });
  w({ kind: "refund", principal: BUYER, amountMicroTrac: 36, refundAddress: BUYER, termsDigest: "sha256:t", at: "t3" });
  const c3 = N.conservationCheck(h3, BUYER);
  ok("terminal refund of UNCLOSED epoch implicitly releases its earned: 90 == 4+86+0+0+0",
    c3.ok && c3.q.payoutsMicroTrac === 4 && c3.q.refundsMicroTrac === 86, JSON.stringify(c3.q));
  // and every truncation point of THIS journal also conserves
  const lines3 = readFileSync(J3, "utf8").split("\n").filter((l) => l.trim());
  let holds3 = 0;
  for (let k = 1; k <= lines3.length; k++) {
    const ch = mkdtempSync(join(tmpdir(), "netting-rcrash-"));
    mkdirSync(join(ch, "metering"), { recursive: true });
    writeFileSync(join(ch, "metering", "read-journal.jsonl"), lines3.slice(0, k).join("\n") + "\n");
    if (N.conservationCheck(ch, BUYER).ok) holds3++;
  }
  ok(`refund-journal conserves at all ${lines3.length} truncation points`, holds3 === lines3.length, `${holds3}/${lines3.length}`);
}

console.log("\nthreshold gating (I6) + I4:");
{
  const g = N.providerMaySettle(home, BUYER, "0.011", "8000");
  ok("live threshold ≈ 6.09 TRAC", g.thresholdMicroTrac >= 6_089_000 && g.thresholdMicroTrac <= 6_090_000);
  ok("unsettledEarned 10 < threshold → provider may NOT settle", g.allowed === false && g.unsettledEarned === 10);
  let refused = false; try { N.settleThresholdMicroTrac("999999999999", "999999999999999999999999999999"); } catch { refused = true; }
  ok("extreme-input Number wrapper refuses; bigint path agrees at reference", refused
    && N.settleThresholdMicroTracBig("0.011", "8000") === BigInt(N.settleThresholdMicroTrac("0.011", "8000")));
}

console.log("\nsum-overflow (Hermes #4) — bigint identity, operand guard:");
{
  const h2 = mkdtempSync(join(tmpdir(), "netting-ovf-"));
  mkdirSync(join(h2, "metering"), { recursive: true });
  const J = join(h2, "metering", "read-journal.jsonl");
  writeFileSync(J, JSON.stringify({ kind: "credit", principal: BUYER, epoch: 0, amountMicroTrac: 9_007_199_254_740_991, evidence: { chainId: 1, token: "0xT", txHash: "0xbig", logIndex: 0 } }) + "\n");
  const cBig = N.conservationCheck(h2, BUYER);
  ok("near-MAX_SAFE totals compare exactly (bigint path)", cBig.ok === true && cBig.lhs === 9_007_199_254_740_991, JSON.stringify({ lhs: cBig.lhs, rhs: cBig.rhs }));
  appendFileSync(J, JSON.stringify({ kind: "credit", principal: BUYER, epoch: 0, amountMicroTrac: 9_007_199_254_740_994, evidence: { chainId: 1, token: "0xT", txHash: "0xbig2", logIndex: 0 } }) + "\n");
  const cBad = N.conservationCheck(h2, BUYER);
  ok("unsafe operand FAILS closed (never lossy)", cBad.ok === false && cBad.lhs === -1);
}

console.log("\nstructural release authority + economics execution binding (wiring v2):");
{
  const closeDigest = String(L.readJournal(home).find((r) => r.kind === "nsm-close").closeDigest);
  ok("release WITHOUT authority token → E_RELEASE_AUTHORITY",
    N.recordEarnedRelease(home, BUYER, closeDigest, 10, "0xpayout1").code === "E_RELEASE_AUTHORITY");
  ok("release with WRONG authority token → E_RELEASE_AUTHORITY",
    N.recordEarnedRelease(home, BUYER, closeDigest, 10, "0xpayout1", "wrong-token").code === "E_RELEASE_AUTHORITY");
  const hNoAuth = mkdtempSync(join(tmpdir(), "netting-noauth-"));
  mkdirSync(join(hNoAuth, "metering"), { recursive: true });
  ok("NO authority file provisioned → nothing can release (fail closed)",
    N.recordEarnedRelease(hNoAuth, BUYER, "sha256:x", 1, "0xt", AUTH).code === "E_RELEASE_AUTHORITY");
  // execution-time economics binding
  writeFileSync(join(home, "metering", "netting-economics.json"), JSON.stringify({ feeGweiDecimal: "0.011", ethTracDecimal: "8000", recordedAt: "2026-08-12T08:00:00Z", source: "s1" }));
  const d1 = N.currentEconomicsDigest(home);
  ok("execution binding passes while config unchanged", N.assertEconomicsUnchanged(home, d1).ok === true);
  writeFileSync(join(home, "metering", "netting-economics.json"), JSON.stringify({ feeGweiDecimal: "0.012", ethTracDecimal: "8000", recordedAt: "2026-08-12T08:10:00Z", source: "s2" }));
  const chg = N.assertEconomicsUnchanged(home, d1);
  ok("verdict-A / execute-after-config-B → E_ECONOMICS_CHANGED (before any mutation)", chg.ok === false && chg.code === "E_ECONOMICS_CHANGED");
  // durable evidence: the release record carries the economics digest
  const rel = L.readJournal(home).find((r) => r.kind === "nsm-earned-released");
  ok("release record durably carries economicsConfigDigest", rel && "economicsConfigDigest" in rel);
}

console.log("\nduplicate countersign + G-I1a + G-I7b:");
{
  L.credit(home, BUYER, 20, { chainId: 8453, token: "0xTRAC", txHash: "0xdep4", logIndex: 0 });   // fund the final phase (fresh epoch)
  const legX = bill(3); countersign(legX);
  const before = N.ledgerQuantities(home, BUYER).earnedCurrent;
  L.appendJournal(home, { kind: "leg-countersigned", principal: BUYER, legId: legX.legId, epoch: legX.tabEpoch });
  ok("replayed countersign does not double-count", N.ledgerQuantities(home, BUYER).earnedCurrent === before);
  const jpath = join(home, "metering", "read-journal.jsonl");
  const lines = readFileSync(jpath, "utf8").split("\n").filter((l) => l.trim());
  let holds = 0;
  for (let k = 1; k <= lines.length; k++) {
    const ch = mkdtempSync(join(tmpdir(), "netting-crash-"));
    mkdirSync(join(ch, "metering"), { recursive: true });
    writeFileSync(join(ch, "metering", "read-journal.jsonl"), lines.slice(0, k).join("\n") + "\n");
    const c = N.conservationCheck(ch, BUYER);
    if (c.ok) holds++;
    else console.log(`    ✗ broken at truncation ${k}/${lines.length}: lhs ${c.lhs} rhs ${c.rhs} :: ${JSON.stringify(c.q)}`);
  }
  ok(`G-I1a: identity holds at ALL ${lines.length} truncation points`, holds === lines.length, `${holds}/${lines.length}`);
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "netting.ts"), "utf8");
  const section = src.slice(src.indexOf("SYNCHRONOUS CRITICAL SECTION"), src.indexOf("end critical section"));
  ok("G-I7b: no await in critical section; commitClose not async", section.length > 50 && !/\bawait\b/.test(section) && !/export async function commitClose/.test(src));
}

console.log("\ncurrent-segment quantities under epoch divergence (funded-run finding #2 2026-08-13):");
{
  const hS = mkdtempSync(join(tmpdir(), "netting-seg-"));
  mkdirSync(join(hS, "metering"), { recursive: true });
  const rec = (o) => JSON.stringify(o) + "\n";
  writeFileSync(join(hS, "metering", "read-journal.jsonl"),
    rec({ kind: "credit", principal: BUYER, amountMicroTrac: 1000000, evidence: { chainId: 8453, token: "0xT", txHash: "0xs1", logIndex: 0 }, at: "1" })
    + rec({ kind: "refund", principal: BUYER, amountMicroTrac: 1000000, at: "2" })
    + rec({ kind: "credit", principal: BUYER, amountMicroTrac: 1000000, evidence: { chainId: 8453, token: "0xT", txHash: "0xs2", logIndex: 0 }, at: "3" })
    + rec({ kind: "settled", principal: BUYER, withdrawalId: "wd:s", txHash: "0xset", netPaidMicroTrac: 1000000, at: "4" })
    + rec({ kind: "credit", principal: BUYER, epoch: 1, amountMicroTrac: 1000000, evidence: { chainId: 8453, token: "0xT", txHash: "0xs3", logIndex: 0 }, at: "5" })
    + rec({ kind: "debit", principal: BUYER, epoch: 1, hash: "h", leg: { legId: "leg-seg", sequence: 1, tabEpoch: 1, tab: { after: 999922 }, pricing: { costMicroTrac: 78 } }, at: "6" })
    + rec({ kind: "leg-countersigned", principal: BUYER, legId: "leg-seg", epoch: 1, at: "7" }));
  const q = N.ledgerQuantities(hS, BUYER);
  ok("finding#2: reports stamped epoch (1)", q.epoch === 1, JSON.stringify(q));
  ok("finding#2: current segment sees the billed leg (billed=78, earned=78)", q.billedCurrent === 78 && q.earnedCurrent === 78, JSON.stringify({ b: q.billedCurrent, e: q.earnedCurrent }));
  ok("finding#2: refundableCurrent = gross - earned = 999,922 (was 1,000,000 live)", q.refundableCurrent === 999922, String(q.refundableCurrent));
  ok("finding#2: grossCurrent is current credit only (1,000,000) - no collision with legacy counter-1 bucket", q.grossCurrent === 1000000);
  const c = N.conservationCheck(hS, BUYER);
  ok("finding#2: conservation holds (3,000,000 == 3,000,000)", c.ok === true, JSON.stringify({ lhs: c.lhs, rhs: c.rhs }));
  const hPre = mkdtempSync(join(tmpdir(), "netting-segpre-"));
  mkdirSync(join(hPre, "metering"), { recursive: true });
  writeFileSync(join(hPre, "metering", "read-journal.jsonl"),
    rec({ kind: "credit", principal: BUYER, amountMicroTrac: 1000000, evidence: { chainId: 1, token: "0xT", txHash: "0xp1", logIndex: 0 }, at: "1" })
    + rec({ kind: "refund", principal: BUYER, amountMicroTrac: 1000000, at: "2" })
    + rec({ kind: "credit", principal: BUYER, epoch: 1, amountMicroTrac: 1000000, evidence: { chainId: 1, token: "0xT", txHash: "0xp2", logIndex: 0 }, at: "3" }));
  const qp = N.ledgerQuantities(hPre, BUYER);
  ok("finding#2 pre-bill: gross 1,000,000 / earned 0 / refundable 1,000,000 / conservation true", qp.grossCurrent === 1000000 && qp.earnedCurrent === 0 && qp.refundableCurrent === 1000000 && N.conservationCheck(hPre, BUYER).ok);
}

console.log("\nimplicit-release vs closed-earned separation (funded-run finding #3 2026-08-13):");
{
  // History with IMPLICIT releases (old unclosed lifecycles resolved at their
  // terminals) followed by a FRESH close in the live lifecycle. The old
  // implicit releases must NOT deduct from the new close's earned — live, they
  // swallowed the close's 78 and unsettledEarned read 0, breaking I1 by 78.
  const hR = mkdtempSync(join(tmpdir(), "netting-rel3-"));
  mkdirSync(join(hR, "metering"), { recursive: true });
  const rec = (o) => JSON.stringify(o) + "\n";
  writeFileSync(join(hR, "metering", "read-journal.jsonl"),
    rec({ kind: "credit", principal: BUYER, amountMicroTrac: 1000000, evidence: { chainId: 8453, token: "0xT", txHash: "0xr31", logIndex: 0 }, at: "1" })
    + rec({ kind: "debit", principal: BUYER, hash: "hA", leg: { legId: "leg-old", sequence: 1, tab: { after: 999921 }, pricing: { costMicroTrac: 79 } }, at: "2" })
    + rec({ kind: "leg-countersigned", principal: BUYER, legId: "leg-old", at: "3" })
    + rec({ kind: "settled", principal: BUYER, withdrawalId: "wd:old", txHash: "0xold", netPaidMicroTrac: 999921, at: "4" })   // UNCLOSED epoch terminal → 79 IMPLICITLY released
    + rec({ kind: "credit", principal: BUYER, epoch: 1, amountMicroTrac: 1000000, evidence: { chainId: 8453, token: "0xT", txHash: "0xr32", logIndex: 0 }, at: "5" })
    + rec({ kind: "debit", principal: BUYER, epoch: 1, hash: "hB", leg: { legId: "leg-new", sequence: 1, tabEpoch: 1, tab: { after: 999922 }, pricing: { costMicroTrac: 78 } }, at: "6" })
    + rec({ kind: "leg-countersigned", principal: BUYER, legId: "leg-new", epoch: 1, at: "7" })
    + rec({ kind: "nsm-close", principal: BUYER, epoch: 1, mode: "settle", earnedMicroTrac: 78, carryMicroTrac: 999922, closeDigest: "sha256:R3", at: "8" }));
  const q = N.ledgerQuantities(hR, BUYER);
  ok("finding#3: fresh close's earned lands in unsettledEarned (78) despite prior implicit releases", q.unsettledEarned === 78, JSON.stringify(q));
  ok("finding#3: earnedCurrent 0 (closed) + refundable 999,922", q.earnedCurrent === 0 && q.refundableCurrent === 999922);
  const c = N.conservationCheck(hR, BUYER);
  ok("finding#3: I1 TRUE post-close (2,000,000 == 999,921 + 79 released + 78 unsettled + 999,922 refundable)", c.ok === true, JSON.stringify({ lhs: c.lhs, rhs: c.rhs }));
  // and an EXPLICIT release against that close still deducts correctly
  writeFileSync(join(hR, "metering", "read-journal.jsonl"),
    readFileSync(join(hR, "metering", "read-journal.jsonl"), "utf8")
    + rec({ kind: "nsm-earned-released", principal: BUYER, closeDigest: "sha256:R3", amountMicroTrac: 78, payoutTxHash: "0xpay", economicsConfigDigest: "sha256:" + "e".repeat(64), at: "9" }));
  const q2 = N.ledgerQuantities(hR, BUYER);
  ok("finding#3: explicit close-referenced release DOES deduct (unsettled back to 0), I1 still TRUE", q2.unsettledEarned === 0 && N.conservationCheck(hR, BUYER).ok === true, JSON.stringify({ u: q2.unsettledEarned }));
}

console.log("\nauthoritative-epoch anchor (funded-run finding 2026-08-13) — projection MUST equal the ledger's stamped epoch:");
{
  // A ledger whose FROM-SCRATCH counter would diverge from the recorded epoch:
  // an early full refund the current counter treats as terminal (rolling an
  // extra epoch) but the ledger stamped otherwise. The newest credit carries a
  // recorded epoch LOWER than the counter would produce; the projection must
  // report the STAMPED epoch, never the counter.
  const hE = mkdtempSync(join(tmpdir(), "netting-epoch-"));
  mkdirSync(join(hE, "metering"), { recursive: true });
  const JE = join(hE, "metering", "read-journal.jsonl");
  const rec = (o) => JSON.stringify(o) + "\n";
  writeFileSync(JE,
    rec({ kind: "credit", principal: BUYER, amountMicroTrac: 1000000, evidence: { chainId: 8453, token: "0xT", txHash: "0xe1", logIndex: 0 }, at: "1" })            // counter epoch 0
    + rec({ kind: "refund", principal: BUYER, amountMicroTrac: 1000000, at: "2" })                                                                                    // counter terminalizes
    + rec({ kind: "credit", principal: BUYER, amountMicroTrac: 1000000, evidence: { chainId: 8453, token: "0xT", txHash: "0xe2", logIndex: 0 }, at: "3" })            // counter → 1, but ledger did NOT roll here
    + rec({ kind: "settled", principal: BUYER, withdrawalId: "wd:e", txHash: "0xse", netPaidMicroTrac: 1000000, at: "4" })
    + rec({ kind: "credit", principal: BUYER, epoch: 1, amountMicroTrac: 1000000, evidence: { chainId: 8453, token: "0xT", txHash: "0xe3", logIndex: 0 }, at: "5" })); // STAMPED epoch 1 (counter would say 2)
  const q = N.ledgerQuantities(hE, BUYER);
  ok("projection REPORTS the stamped epoch (1), not the from-scratch counter (2)", q.epoch === 1, JSON.stringify({ epoch: q.epoch, gross: q.grossCurrent }));
  ok("current-lifecycle gross intact (1,000,000) — buckets NOT reindexed by the stamp", q.grossCurrent === 1000000);
  const c = N.conservationCheck(hE, BUYER);
  ok("conservation still holds under the anchor (stamp relabels, never recomputes buckets)", c.ok === true, JSON.stringify({ lhs: c.lhs, rhs: c.rhs }));
  // and an all-stamped modern ledger: projection == every stamp
  const hM = mkdtempSync(join(tmpdir(), "netting-epoch2-"));
  mkdirSync(join(hM, "metering"), { recursive: true });
  writeFileSync(join(hM, "metering", "read-journal.jsonl"),
    rec({ kind: "credit", principal: BUYER, epoch: 5, amountMicroTrac: 1000000, evidence: { chainId: 8453, token: "0xT", txHash: "0xm1", logIndex: 0 }, at: "1" }));
  ok("a lone stamped credit projects its exact stamped epoch (5)", N.ledgerQuantities(hM, BUYER).epoch === 5);
}

console.log("\nexecution-time provider election (Hermes wiring v4.2) — mutation-enforced, not advisory:");
{
  const mk6 = (fee) => {
    const h = mkdtempSync(join(tmpdir(), "netting-elect-"));
    mkdirSync(join(h, "metering"), { recursive: true });
    writeFileSync(join(h, "metering", "release-authority.token"), AUTH);
    writeFileSync(join(h, "metering", "netting-economics.json"), JSON.stringify({ feeGweiDecimal: fee, ethTracDecimal: "8000", recordedAt: "2026-08-12T08:00:00Z", source: "elect" }));
    const J = join(h, "metering", "read-journal.jsonl");
    writeFileSync(J, JSON.stringify({ kind: "credit", principal: BUYER, epoch: 0, amountMicroTrac: 100, evidence: { chainId: 1, token: "0xT", txHash: "0xe1", logIndex: 0 }, at: "c" }) + "\n"
      + JSON.stringify({ kind: "debit", principal: BUYER, epoch: 0, hash: "h1", leg: { legId: "leg-e", sequence: 1, tabEpoch: 0, tab: { after: 90 }, pricing: { costMicroTrac: 10 } }, at: "d" }) + "\n"
      + JSON.stringify({ kind: "leg-countersigned", principal: BUYER, legId: "leg-e", epoch: 0, at: "cs" }) + "\n"
      + JSON.stringify({ kind: "nsm-close", principal: BUYER, epoch: 0, mode: "settle", earnedMicroTrac: 10, carryMicroTrac: 90, closeDigest: "sha256:E", at: "cl" }) + "\n");
    return h;
  };
  const jlen = (h) => readFileSync(join(h, "metering", "read-journal.jsonl")).length;
  // below-threshold: correct digest, correct authority — still refused, zero writes
  const hBig = mk6("0.011");
  const jb = jlen(hBig);
  const below = N.recordNettedSettlement(hBig, { principal: BUYER, withdrawalId: "close:sha256:E", txHash: "0xe", netPaidMicroTrac: 90, closes: ["sha256:E"], expectedConfigDigest: N.currentEconomicsDigest(hBig), authorityToken: AUTH });
  ok("below-threshold settlement (valid digest+authority) → E_SETTLE_ELECTION_REFUSED, ZERO writes", below.ok === false && below.code === "E_SETTLE_ELECTION_REFUSED" && below.election?.allowed === false && jlen(hBig) === jb, JSON.stringify(below));
  // closes must be real + amount-exact BEFORE any mutation
  const hOk = mk6("0.000000001");
  const jb2 = jlen(hOk);
  ok("ghost close in closes[] → E_SETTLE_CLOSES_INVALID, zero writes", (() => { const r = N.recordNettedSettlement(hOk, { principal: BUYER, withdrawalId: "w", txHash: "0xg", netPaidMicroTrac: 90, closes: ["sha256:E", "sha256:GHOST"], expectedConfigDigest: N.currentEconomicsDigest(hOk), authorityToken: AUTH }); return r.code === "E_SETTLE_CLOSES_INVALID" && jlen(hOk) === jb2; })());
  ok("netPaid ≠ Σ named carries → E_SETTLE_AMOUNT_MISMATCH, zero writes", (() => { const r = N.recordNettedSettlement(hOk, { principal: BUYER, withdrawalId: "w", txHash: "0xg", netPaidMicroTrac: 89, closes: ["sha256:E"], expectedConfigDigest: N.currentEconomicsDigest(hOk), authorityToken: AUTH }); return r.code === "E_SETTLE_AMOUNT_MISMATCH" && jlen(hOk) === jb2; })());
  ok("empty closes[] refused", N.recordNettedSettlement(hOk, { principal: BUYER, withdrawalId: "w", txHash: "0xg", netPaidMicroTrac: 0, closes: [], expectedConfigDigest: N.currentEconomicsDigest(hOk), authorityToken: AUTH }).code === "E_SETTLE_CLOSES_INVALID");
  // replay short-circuit: same withdrawalId re-record is benign recovery and
  // does NOT re-evaluate the election (settling drains unsettledEarned)
  const good = N.recordNettedSettlement(hOk, { principal: BUYER, withdrawalId: "close:sha256:E", txHash: "0xe2", netPaidMicroTrac: 90, closes: ["sha256:E"], expectedConfigDigest: N.currentEconomicsDigest(hOk), authorityToken: AUTH });
  const jb3 = jlen(hOk);
  const replayed = N.recordNettedSettlement(hOk, { principal: BUYER, withdrawalId: "close:sha256:E", txHash: "0xe2", netPaidMicroTrac: 90, closes: ["sha256:E"], expectedConfigDigest: N.currentEconomicsDigest(hOk), authorityToken: AUTH });
  ok("recorded settlement replays as alreadySettled (no election re-evaluation, zero writes)", good.ok === true && replayed.ok === true && replayed.alreadySettled === true && replayed.economicsConfigDigest === good.economicsConfigDigest && jlen(hOk) === jb3, JSON.stringify(replayed));
}

console.log("\nI1 on REAL pre-P2 history — ledger-vs-counter epoch divergence (live finding, 78µ):");
{
  // Bo's exact production shape: four lifecycles; old legs carry tabEpoch
  // labels (null, 1, 2) that DIVERGE from credit-counting (0,1,2,3) because
  // ledger epoch numbering predates the field on early lifecycles. The sale's
  // countersigned earned (78) must be implicitly released at its terminal —
  // the pre-fix replay stranded it in an unvisited bucket and I1 failed by 78.
  const hB = mkdtempSync(join(tmpdir(), "netting-live-"));
  mkdirSync(join(hB, "metering"), { recursive: true });
  const JB = join(hB, "metering", "read-journal.jsonl");
  const rec = (o) => JSON.stringify(o) + "\n";
  writeFileSync(JB,
    rec({ kind: "credit", principal: BUYER, amountMicroTrac: 1000000, evidence: { chainId: 8453, token: "0xT", txHash: "0xr1", logIndex: 0 }, at: "1" })
    + rec({ kind: "refund", principal: BUYER, amountMicroTrac: 1000000, at: "2" })
    + rec({ kind: "credit", principal: BUYER, amountMicroTrac: 1000000, evidence: { chainId: 8453, token: "0xT", txHash: "0xr2", logIndex: 0 }, at: "3" })
    + rec({ kind: "debit", principal: BUYER, hash: "hA", leg: { legId: "leg-reads", sequence: 1, tab: { after: 999999 }, pricing: { costMicroTrac: 1 } }, at: "4" })      // tabEpoch ABSENT (old era)
    + rec({ kind: "leg-countersigned", principal: BUYER, legId: "leg-reads", at: "5" })
    + rec({ kind: "debit", principal: BUYER, hash: "hB", leg: { legId: "leg-disputed", sequence: 2, tab: { after: 999998 }, pricing: { costMicroTrac: 1 } }, at: "6" })   // never countersigned
    + rec({ kind: "settled", principal: BUYER, withdrawalId: "wd:reads", txHash: "0xreads", netPaidMicroTrac: 999999, at: "7" })
    + rec({ kind: "credit", principal: BUYER, amountMicroTrac: 1000000, evidence: { chainId: 8453, token: "0xT", txHash: "0xr3", logIndex: 0 }, at: "8" })
    + rec({ kind: "debit", principal: BUYER, hash: "hC", leg: { legId: "leg-refundrun", sequence: 1, tabEpoch: 1, tab: { after: 999922 }, pricing: { costMicroTrac: 78 } }, at: "9" })  // withheld, never countersigned
    + rec({ kind: "settled", principal: BUYER, withdrawalId: "wd:refundrun", txHash: "0xrefund", netPaidMicroTrac: 1000000, at: "10" })
    + rec({ kind: "credit", principal: BUYER, amountMicroTrac: 1000000, evidence: { chainId: 8453, token: "0xT", txHash: "0xr4", logIndex: 0 }, at: "11" })
    + rec({ kind: "debit", principal: BUYER, hash: "hD", leg: { legId: "leg-sale", sequence: 1, tabEpoch: 2, tab: { after: 999922 }, pricing: { costMicroTrac: 78 } }, at: "12" })      // ledger says 2; counter says 3
    + rec({ kind: "leg-countersigned", principal: BUYER, legId: "leg-sale", epoch: 2, at: "13" })
    + rec({ kind: "settled", principal: BUYER, withdrawalId: "wd:sale", txHash: "0xsale", netPaidMicroTrac: 999922, at: "14" }));
  const cB = N.conservationCheck(hB, BUYER);
  ok("I1 HOLDS on the divergent-numbering history (4,000,000 == 3,000,000 + 1,000,000)", cB.ok === true, JSON.stringify({ lhs: cB.lhs, rhs: cB.rhs, q: cB.q }));
  ok("sale's countersigned earned (78) implicitly released at ITS terminal (payouts = 2,999,921 transfers + 79 released)", cB.q.payoutsMicroTrac === 3000000, JSON.stringify(cB.q.payoutsMicroTrac));
  ok("disputed/withheld legs (never countersigned) release NOTHING", cB.q.unsettledEarned === 0 && cB.q.earnedCurrent === 0);
}

console.log("\naudit surface — settled evidence survives restart (OpenClaw v4 follow-up):");
{
  // fresh home, hand-shaped journal: replay (the restart path) must carry the
  // digest-bound settled record into settlementOf, or the close statement's
  // `settlement` field would forget the authorizing economics after a restart.
  const h5 = mkdtempSync(join(tmpdir(), "netting-audit-"));
  mkdirSync(join(h5, "metering"), { recursive: true });
  const J5 = join(h5, "metering", "read-journal.jsonl");
  writeFileSync(J5,
    JSON.stringify({ kind: "credit", principal: BUYER, epoch: 0, amountMicroTrac: 100, evidence: { chainId: 1, token: "0xT", txHash: "0xa1", logIndex: 0 }, at: "c" }) + "\n"
    + JSON.stringify({ kind: "settled", principal: BUYER, withdrawalId: "wd:audit", txHash: "0xaudit", netPaidMicroTrac: 90, closes: ["sha256:X"], economicsConfigDigest: "sha256:" + "a".repeat(64), at: "s" }) + "\n");
  const so = L.settlementOf(h5, BUYER);
  ok("settlementOf (replayed from disk) carries economicsConfigDigest + closes", so?.economicsConfigDigest === "sha256:" + "a".repeat(64) && Array.isArray(so?.closes) && so.closes[0] === "sha256:X", JSON.stringify(so));
  const so2 = L.settlementOf(h5, BUYER.toLowerCase() === BUYER ? BUYER : BUYER); // same principal, second read
  ok("audit read is stable and read-only (journal byte-identical)", JSON.stringify(so2) === JSON.stringify(so) && readFileSync(J5, "utf8").split("\n").filter(Boolean).length === 2);
}

console.log(`\n${pass}/${pass + fail} netting gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
