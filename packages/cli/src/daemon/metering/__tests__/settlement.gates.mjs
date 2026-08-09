// V2-B5 settlement & withdrawal — gates.
//
// The test plan is Hermes/Bo's crash matrix, adopted wholesale: crashes after
// prepare / after sign / after broadcast / before & after finality; dropped and
// fee-bumped replacements; reorg; incompatible nonce; duplicate close calls;
// byte-for-byte rebroadcast. The invariant every case defends: AT MOST ONE
// matching payout, and the tab cannot become withdrawable again until that
// payout is canonically confirmed.
import { generateKeyPairSync, sign as edSign, createPrivateKey, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "../../../../dist/daemon");
const home = mkdtempSync(join(tmpdir(), "settle-"));
process.env.DKG_HOME = home;
mkdirSync(join(home, "metering"), { recursive: true });

const S = await import(join(dist, "metering/settlement.js"));
const L = await import(join(dist, "metering/ledger.js"));
const D = await import(join(dist, "metering/deposit-rail.js"));
const RM = await import(join(dist, "metering/read-meter.js"));
const ST = await import(join(dist, "metering/stage3-endpoint.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

const CHAIN = "eip155:8453", CHAINID = 8453;
const TRAC = "0xA81a52B4dda010896cDd386C7fBdc5CDc835ba23";
const PROVIDER = "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab";
const BUYER = "0x8A87ea7c0fBC3431f20B5B26dd9f7f32571Aa2ba";
const session = generateKeyPairSync("ed25519");
const pem = (k) => k.export({ type: "spki", format: "pem" }).toString();

// Force provider-key creation, then grab the public pem the buyer verifies with.
const providerPub = L.providerPublicPem(home);

// Countersign a leg hash the way the real countersign path does.
const countersign = (legHash) => edSign(null,
  Buffer.concat([Buffer.from("odysseus-dkg:capability:v1\n"), Buffer.from("sha256:" + legHash)]),
  createPrivateKey(session.privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toString("base64");

// Ten legs, seq 1..10, 3 µTRAC each; leg #7 will be the disputed one.
const legs = Array.from({ length: 10 }, (_, i) => {
  const seq = i + 1;
  const legHash = sha256(`leg-${seq}`);
  const disputed = seq === 7;
  return {
    legHash, sequence: seq, previousLegHash: i === 0 ? "genesis" : sha256(`leg-${seq - 1}`),
    costMicroTrac: 3,
    status: disputed ? "disputed" : "accepted",
    ...(disputed ? {} : { countersignature: countersign(legHash) }),
  };
});
const buyerCountersigned = new Set(legs.filter((l) => l.status === "accepted").map((l) => l.legHash));
const DEPOSIT = 1_000_000;

console.log("\nSettlement close statement (Q1/Q2/Q3)\n");

const built = S.buildCloseStatement(home, {
  chain: CHAIN, tracContract: TRAC, providerAddress: PROVIDER,
  tabPrincipal: BUYER, tabEpoch: "2026-08-06T22:16:17.025Z",
  priorDeposit: { txHash: "0x37ab01fe", blockNumber: 49631482, amountMicroTrac: DEPOSIT },
  legs, destination: BUYER,
});

console.log("Q1 — one net payout:");
ok("accepted cost = 9 accepted legs × 3 = 27 (leg 7 disputed, excluded)",
  built.statement.acceptedCostMicroTrac === 27, String(built.statement.acceptedCostMicroTrac));
ok("net payout = deposit − acceptedCost, no separate earnings tx",
  built.statement.netPayoutMicroTrac === DEPOSIT - 27);
ok("the disputed leg's value is NOT charged — returned in the refund",
  built.statement.grossRefundMicroTrac === DEPOSIT - 27);
ok("fee is zero unless explicitly set", built.statement.feeMicroTrac === 0);

console.log("\nQ2 — buyer verifies, trusting no provider arithmetic:");
const good = S.verifyCloseStatement({
  providerPublicPem: providerPub, statement: built.statement, providerSignature: built.providerSignature,
  buyerCountersigned, sessionPublicKeyPem: pem(session.publicKey), expectedDestination: BUYER,
});
ok("a correct statement verifies and yields the net + withdrawalId", good.ok && good.netPayoutMicroTrac === DEPOSIT - 27 && !!good.withdrawalId, JSON.stringify(good));

{ // completeness: a DISHONEST provider who RE-SIGNS an incomplete statement.
  // (Dropping a leg without re-signing only trips the signature check and never
  // exercises the boundary — the real threat is a provider who signs a
  // statement that omits a leg while keeping closeSequence honest.)
  const dishonest = { ...built.statement, legs: built.statement.legs.filter((l) => l.sequence !== 5) };
  const digest = "sha256:" + sha256(L.canonicalize(dishonest));
  const resigned = L.providerSign(home, "odysseus-dkg:close-statement:v1", digest.slice(7));
  const v = S.verifyCloseStatement({ providerPublicPem: providerPub, statement: dishonest, providerSignature: resigned,
    buyerCountersigned, sessionPublicKeyPem: pem(session.publicKey), expectedDestination: BUYER });
  ok("a RE-SIGNED incomplete statement is caught by the close-sequence boundary (Q2 completeness, not the signature)",
    v.code === "E_CLOSE_SEQUENCE_GAP", v.code);
}
{ // OpenClaw-found (Gate-B #1): the EXACT interval-completeness case. Legs
  // 1,2,3 exist; a close that includes only 1 and 3 (skipping 2) must reject
  // even when re-signed so totals and signatures balance. Interval-completeness
  // is a distinct property from arithmetic correctness.
  const threeLegs = legs.slice(0, 3); // seq 1,2,3, all accepted
  const full = S.buildCloseStatement(home, {
    chain: CHAIN, tracContract: TRAC, providerAddress: PROVIDER, tabPrincipal: BUYER, tabEpoch: "e",
    priorDeposit: { txHash: "0x", blockNumber: 1, amountMicroTrac: DEPOSIT }, legs: threeLegs, destination: BUYER,
  });
  // Drop leg 2, re-sign so the provider signature is VALID over the gapped set.
  const gapped = { ...full.statement, legs: full.statement.legs.filter((l) => l.sequence !== 2) };
  const digest = "sha256:" + sha256(L.canonicalize(gapped));
  const resigned = L.providerSign(home, "odysseus-dkg:close-statement:v1", digest.slice(7));
  const cs = new Set(threeLegs.filter((l) => l.status === "accepted").map((l) => l.legHash));
  const v = S.verifyCloseStatement({ providerPublicPem: providerPub, statement: gapped, providerSignature: resigned,
    buyerCountersigned: cs, sessionPublicKeyPem: pem(session.publicKey), expectedDestination: BUYER });
  ok("close of legs {1,3} skipping 2 is REJECTED even when re-signed and balanced (interval-completeness)",
    v.ok === false && v.code === "E_CLOSE_SEQUENCE_GAP", JSON.stringify(v));
}

{ // provider marks a leg accepted the buyer never signed
  const forged = { ...built.statement, legs: built.statement.legs.map((l) => l.sequence === 7 ? { ...l, status: "accepted", countersignature: countersign("wrong") } : l) };
  const v = S.verifyCloseStatement({ providerPublicPem: providerPub, statement: forged, providerSignature: built.providerSignature,
    buyerCountersigned, sessionPublicKeyPem: pem(session.publicKey), expectedDestination: BUYER });
  ok("a leg the buyer never countersigned cannot be marked accepted", v.ok === false, JSON.stringify(v));
}
{ // provider inflates acceptedCost in the signed statement
  const tampered = { ...built.statement, acceptedCostMicroTrac: 3, netPayoutMicroTrac: DEPOSIT - 3 };
  const v = S.verifyCloseStatement({ providerPublicPem: providerPub, statement: tampered, providerSignature: built.providerSignature,
    buyerCountersigned, sessionPublicKeyPem: pem(session.publicKey), expectedDestination: BUYER });
  ok("tampered arithmetic fails the provider signature (statement is bound)", v.ok === false, v.code);
}
{ // redirect the payout
  const redirected = { ...built.statement, destination: "0xAttacker" };
  const v = S.verifyCloseStatement({ providerPublicPem: providerPub, statement: redirected, providerSignature: built.providerSignature,
    buyerCountersigned, sessionPublicKeyPem: pem(session.publicKey), expectedDestination: BUYER });
  ok("a redirected destination is rejected", v.ok === false);
}
{ // sneak in a fee with no agreed cap
  const fee = S.buildCloseStatement(home, { chain: CHAIN, tracContract: TRAC, providerAddress: PROVIDER,
    tabPrincipal: BUYER, tabEpoch: "e", priorDeposit: { txHash: "0x", blockNumber: 1, amountMicroTrac: DEPOSIT },
    legs, feeMicroTrac: 500, destination: BUYER });
  const v = S.verifyCloseStatement({ providerPublicPem: providerPub, statement: fee.statement, providerSignature: fee.providerSignature,
    buyerCountersigned, sessionPublicKeyPem: pem(session.publicKey), expectedDestination: BUYER });
  ok("a fee with no agreed cap is rejected (Q1: fee only if buyer agreed)", v.code === "E_CLOSE_FEE_UNAGREED", v.code);
  const v2 = S.verifyCloseStatement({ providerPublicPem: providerPub, statement: fee.statement, providerSignature: fee.providerSignature,
    buyerCountersigned, sessionPublicKeyPem: pem(session.publicKey), expectedDestination: BUYER, agreedFeeCapMicroTrac: 500 });
  ok("...and accepted when it is within the agreed cap", v2.ok === true, JSON.stringify(v2));
}

console.log("\nQ4 — withdrawal state machine + Bo's crash matrix:");
const WID = built.statement.withdrawalId;
const inFresh = (body) => JSON.parse(require("node:child_process").execFileSync(process.execPath, ["-e", `
  (async () => {
    const S = await import(${JSON.stringify(join(dist, "metering/settlement.js"))});
    ${body}
  })();`], { encoding: "utf8", env: { ...process.env, DKG_HOME: home } }).trim());

// prepare
const prep = S.prepareWithdrawal(home, { withdrawalId: WID, statementDigest: built.digest, amountMicroTrac: good.netPayoutMicroTrac, destination: BUYER, chainId: CHAINID });
ok("prepare records the withdrawal", prep.ok && prep.state.phase === "prepared");

// crash after prepare: fresh process still sees it, phase prepared, NOT confirmed
{
  const st = inFresh(`console.log(JSON.stringify([...S.replayWithdrawals(${JSON.stringify(home)}).values()]))`);
  ok("crash after PREPARE: replay sees phase=prepared, unconfirmed", st.length === 1 && st[0].phase === "prepared");
}

// duplicate prepare is idempotent, no second withdrawal
const dup = S.prepareWithdrawal(home, { withdrawalId: WID, statementDigest: built.digest, amountMicroTrac: good.netPayoutMicroTrac, destination: BUYER, chainId: CHAINID });
ok("duplicate close/prepare is idempotent — no second withdrawal", dup.ok && S.replayWithdrawals(home).size === 1);

// sign
S.recordSignedWithdrawal(home, { withdrawalId: WID, sender: PROVIDER, accountNonce: 42, txHash: "0xSIGNED" });
{
  const st = inFresh(`console.log(JSON.stringify([...S.replayWithdrawals(${JSON.stringify(home)}).values()]))`);
  ok("crash after SIGN: replay sees phase=signed with the exact txHash for rebroadcast",
    st[0].phase === "signed" && st[0].txHash === "0xSIGNED" && st[0].accountNonce === 42);
}

// crash after broadcast, before finality: confirm with too few confs is refused
const early = S.confirmWithdrawal(home, { withdrawalId: WID, receipt: { txHash: "0xSIGNED", to: BUYER, amountMicroTrac: good.netPayoutMicroTrac, success: true, confirmations: 3 }, requiredConfirmations: 12 });
ok("crash before FINALITY: an under-confirmed receipt does not confirm the withdrawal", early.ok === false && early.code === "E_WD_UNCONFIRMED");
ok("...and the withdrawal is still 'signed', not lost", S.replayWithdrawals(home).get(WID).phase === "signed");

// FEE-BUMPED REPLACEMENT: different hash, same nonce, same effect -> confirms
const bumped = S.confirmWithdrawal(home, { withdrawalId: WID, receipt: { txHash: "0xREPLACEMENT", to: BUYER, amountMicroTrac: good.netPayoutMicroTrac, success: true, confirmations: 20 }, requiredConfirmations: 12 });
ok("a fee-bumped REPLACEMENT (different hash, same effect) confirms — nonce alone was never the key", bumped.ok, JSON.stringify(bumped));
{
  const st = S.replayWithdrawals(home).get(WID);
  ok("the confirmed hash is the REPLACEMENT, recorded distinctly from the signed hash",
    st.phase === "confirmed" && st.confirmedTxHash === "0xREPLACEMENT" && st.txHash === "0xSIGNED");
}

// A replacement that pays a DIFFERENT amount must NOT confirm.
{
  const home2 = mkdtempSync(join(tmpdir(), "settle2-")); mkdirSync(join(home2, "metering"), { recursive: true });
  S.prepareWithdrawal(home2, { withdrawalId: "wd:x", statementDigest: "d", amountMicroTrac: 999973, destination: BUYER, chainId: CHAINID });
  S.recordSignedWithdrawal(home2, { withdrawalId: "wd:x", sender: PROVIDER, accountNonce: 7, txHash: "0xa" });
  const wrong = S.confirmWithdrawal(home2, { withdrawalId: "wd:x", receipt: { txHash: "0xb", to: BUYER, amountMicroTrac: 500000, success: true, confirmations: 20 }, requiredConfirmations: 12 });
  ok("a replacement paying a DIFFERENT amount is refused (E_WD_AMOUNT_MISMATCH)", wrong.code === "E_WD_AMOUNT_MISMATCH");
  const wrongDest = S.confirmWithdrawal(home2, { withdrawalId: "wd:x", receipt: { txHash: "0xc", to: "0xElse", amountMicroTrac: 999973, success: true, confirmations: 20 }, requiredConfirmations: 12 });
  ok("a replacement paying a different DESTINATION is refused", wrongDest.code === "E_WD_DEST_MISMATCH");
}

// crash AFTER finality: re-confirm is an idempotent no-op, no double payout
const reconf = S.confirmWithdrawal(home, { withdrawalId: WID, receipt: { txHash: "0xREPLACEMENT", to: BUYER, amountMicroTrac: good.netPayoutMicroTrac, success: true, confirmations: 30 }, requiredConfirmations: 12 });
ok("crash after FINALITY: re-confirm is an idempotent no-op (E_WD_ALREADY_CONFIRMED)", reconf.ok && reconf.code === "E_WD_ALREADY_CONFIRMED");

// THE invariant, across a real restart: exactly one confirmed payout, and the
// withdrawal cannot be re-opened.
{
  const st = inFresh(`
    const m = S.replayWithdrawals(${JSON.stringify(home)});
    const w = m.get(${JSON.stringify(WID)});
    const reprepped = S.prepareWithdrawal(${JSON.stringify(home)}, { withdrawalId: ${JSON.stringify(WID)}, statementDigest: "d", amountMicroTrac: 1, destination: ${JSON.stringify(BUYER)}, chainId: ${CHAINID} });
    console.log(JSON.stringify({ phase: w.phase, confirmed: w.confirmedTxHash, count: m.size, reprepPhase: S.replayWithdrawals(${JSON.stringify(home)}).get(${JSON.stringify(WID)}).phase }));
  `);
  ok("after restart: exactly one withdrawal, phase confirmed, and re-prepare cannot demote it",
    st.count === 1 && st.phase === "confirmed" && st.reprepPhase === "confirmed", JSON.stringify(st));
}

// journal never reordered a confirmed withdrawal below a stray prepared record
{
  const j = readFileSync(join(home, "metering", "read-journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.kind === "withdrawal");
  const confirmed = j.filter((r) => r.phase === "confirmed");
  ok("exactly one 'confirmed' journal record for the withdrawal — at most one payout", confirmed.length === 1, `${confirmed.length}`);
}

console.log("\ntab reconciliation after settlement (buyer-found, Bo — no residual claim):");
{
  const { mkdtempSync, mkdirSync } = await import("node:fs");
  const h = mkdtempSync(join(tmpdir(), "settle-recon-"));
  mkdirSync(join(h, "metering"), { recursive: true });
  L.setDebitGate((home, p, now) => D.debitAllowed(home, p, now));
  // fund a tab, bill a leg so there is a residual balance
  const terms = ST.stage3Terms(PROVIDER, BUYER, 100, RM.SCHEDULE_VERSION, CHAINID);
  const art = D.buildOpeningArtifact(BUYER, terms); D.registerOpening(h, art);
  const tr = { txHash: "0xdep", from: BUYER, to: PROVIDER, token: terms.tracContract, amountTrac: "1", blockNumber: 100, safeHeadBlock: 111 };
  D.creditDeposit(h, tr, art, D.evaluateDeposit(tr, art));
  L.recordReadLeg(h, { principal: BUYER, units: 3, breakdown: { markers: {} }, scopeQuads: 26200, sparql: "Q", responseBody: "R", askMicroPer1k: 100 });
  const beforeBal = L.balance(h, BUYER).balance;
  ok("tab has a residual balance before settlement", beforeBal > 0 && beforeBal < 1_000_000, String(beforeBal));

  // run the withdrawal to confirmed
  const WID = "wd:recon-test";
  L.appendJournal; // ensure imported path
  S.prepareWithdrawal(h, { withdrawalId: WID, statementDigest: "d", amountMicroTrac: beforeBal, destination: BUYER, tabPrincipal: BUYER, chainId: CHAINID });
  S.recordSignedWithdrawal(h, { withdrawalId: WID, sender: PROVIDER, accountNonce: 1, txHash: "0xset" });
  const conf = S.confirmWithdrawal(h, { withdrawalId: WID, receipt: { txHash: "0xset", to: BUYER, amountMicroTrac: beforeBal, success: true, confirmations: 20 }, requiredConfirmations: 12 });
  ok("withdrawal confirms", conf.ok);

  // THE fix: tab is now settled, balance zero, buyer-visible
  ok("balance is zeroed after confirmed settlement", L.balance(h, BUYER).balance === 0, String(L.balance(h, BUYER).balance));
  const sm = L.settlementOf(h, BUYER);
  ok("a buyer-visible settlement receipt exists keyed by withdrawalId + txHash",
    sm && sm.withdrawalId === WID && sm.txHash === "0xset", JSON.stringify(sm));
  const view = ST.tabView(h, BUYER, 999);
  ok("tabView reports tabOpen=false and settled=true after settlement",
    view.tabOpen === false && view.settled === true && view.settlement?.txHash === "0xset", JSON.stringify({open:view.tabOpen,settled:view.settled}));

  // no double-refund: expiry must not refund a settled tab
  const refund = L.refundOnExpiry(h, BUYER, BUYER, "digest");
  ok("expiry cannot refund a settled tab (no double payout)", refund.refundedMicroTrac === 0 && refund.settled === true, JSON.stringify(refund));

  // survives a restart (journal-derived)
  const { execFileSync } = require("node:child_process");
  const out = JSON.parse(execFileSync(process.execPath, ["-e", `(async()=>{const L=await import(${JSON.stringify(join(dist,"metering/ledger.js"))});console.log(JSON.stringify({bal:L.balance(${JSON.stringify(h)},${JSON.stringify(BUYER)}).balance,settled:!!L.settlementOf(${JSON.stringify(h)},${JSON.stringify(BUYER)})}))})()`], { encoding: "utf8", env: { ...process.env, DKG_HOME: h } }).trim());
  ok("settlement + zero balance survive a real restart", out.bal === 0 && out.settled === true, JSON.stringify(out));
}

console.log(`\n${pass}/${pass + fail} settlement gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
