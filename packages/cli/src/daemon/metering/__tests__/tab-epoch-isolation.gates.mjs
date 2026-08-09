// Tab-epoch ISOLATION — the four cross-epoch attacks Bo reproduced against the
// first (insufficient) fix, each now a passing negative. The v1 fix rolled the
// epoch in memory but never made epoch a durable, protocol-bound identity;
// these are the exact failures that block turned up (event: I0 tab-epoch BLOCK).
//
//   #1  a stale prior-epoch withdrawal confirmed after a fresh credit settled
//       and ZEROED the new epoch (no expected-epoch CAS).
//   #2  deposit credit was not idempotent — the same tx hash credited twice
//       doubled the balance.
//   #3  refund idempotency was global to (principal, termsDigest), so reusing
//       terms on a new epoch left the fresh balance non-refundable.
//   #4  epoch was not bound through legs/countersign/close/withdrawal, and
//       settlementHistoryOf handed back mutable internal objects.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/daemon");
const home = mkdtempSync(join(tmpdir(), "epoch-iso-"));
process.env.DKG_HOME = home;
mkdirSync(join(home, "metering"), { recursive: true });

const L = await import(join(dist, "metering/ledger.js"));
const S = await import(join(dist, "metering/settlement.js"));
const D = await import(join(dist, "metering/deposit-rail.js"));
const ST = await import(join(dist, "metering/stage3-endpoint.js"));
const RM = await import(join(dist, "metering/read-meter.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };

L.setDebitGate((h, p, now) => D.debitAllowed(h, p, now));
const P = "0x8A87ea7c0fBC3431f20B5B26dd9f7f32571Aa2ba";
const TRAC = "0xA81a52B4dda010896cDd386C7fBdc5CDc835ba23";
const dep = (tx, amt) => L.credit(home, P, amt, { chainId: 8453, token: TRAC, txHash: tx, logIndex: 0 });
const openEpoch = () => { const t = ST.stage3Terms("0x633E5a7C5e612d9981538F60D824cC03be97e2Ab", P, 100, RM.SCHEDULE_VERSION, 8453); D.registerOpening(home, D.buildOpeningArtifact(P, t)); };

console.log("\nTab-epoch isolation — Bo's four cross-epoch attacks, now defended\n");

console.log("#1 — a stale prior-epoch withdrawal cannot settle a fresh epoch:");
{
  dep("0xA0", 1_000_000);                         // epoch 0 funded
  const wid0a = "wd:e0-a", wid0b = "wd:e0-b";
  const p1 = S.prepareWithdrawal(home, { withdrawalId: wid0a, statementDigest: "sha256:s0a", amountMicroTrac: 1_000_000, destination: P, chainId: 8453, tabPrincipal: P });
  ok("epoch-0 withdrawal A prepares", p1.ok && p1.state.epoch === 0);
  const p2 = S.prepareWithdrawal(home, { withdrawalId: wid0b, statementDigest: "sha256:s0b", amountMicroTrac: 1_000_000, destination: P, chainId: 8453, tabPrincipal: P });
  ok("a SECOND active withdrawal for the same epoch is REFUSED (E_WD_EPOCH_HAS_ACTIVE)", p2.ok === false && p2.code === "E_WD_EPOCH_HAS_ACTIVE");

  // confirm A → settles epoch 0
  S.recordSignedWithdrawal(home, { withdrawalId: wid0a, sender: "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab", accountNonce: 1, txHash: "0xTXA" });
  const cA = S.confirmWithdrawal(home, { withdrawalId: wid0a, receipt: { txHash: "0xTXA", to: P, amountMicroTrac: 1_000_000, success: true, confirmations: 12 }, requiredConfirmations: 12 });
  ok("epoch-0 withdrawal A confirms + settles", cA.ok && L.tabEpoch(home, P) === 0 && !!L.settlementOf(home, P));

  // fresh deposit → epoch 1, funded 1,000,000
  dep("0xA1", 1_000_000);
  ok("fresh deposit rolls to epoch 1, balance 1,000,000", L.tabEpoch(home, P) === 1 && L.balance(home, P).balance === 1_000_000);

  // Now confirm a STALE epoch-0 withdrawal (prepared against epoch 0) — the
  // attack. It must NOT settle/zero epoch 1.
  // (wid0b never got past prepare-refusal; forge the stale confirm via a new
  // epoch-0 prepare is blocked, so use wid0a re-confirm which is already
  // confirmed — instead prepare a stale one directly on the journal path.)
  // Prepare a withdrawal explicitly bound to epoch 0 while current epoch is 1:
  const staleId = "wd:stale-e0";
  const ps = S.prepareWithdrawal(home, { withdrawalId: staleId, statementDigest: "sha256:stale", amountMicroTrac: 1_000_000, destination: P, chainId: 8453, tabPrincipal: P, epoch: 0 });
  ok("a withdrawal explicitly bound to the OLD epoch 0 can be prepared (epoch 1 is current, no active e0)", ps.ok);
  S.recordSignedWithdrawal(home, { withdrawalId: staleId, sender: "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab", accountNonce: 2, txHash: "0xSTALE" });
  const balBefore = L.balance(home, P).balance;
  const cs = S.confirmWithdrawal(home, { withdrawalId: staleId, receipt: { txHash: "0xSTALE", to: P, amountMicroTrac: 1_000_000, success: true, confirmations: 12 }, requiredConfirmations: 12 });
  ok("confirming the STALE epoch-0 withdrawal FAILS CLOSED (epoch CAS)", cs.ok === false && String(cs.code).includes("EPOCH"));
  ok("epoch-1 balance is UNTOUCHED by the stale withdrawal", L.balance(home, P).balance === balBefore && balBefore === 1_000_000);
  ok("epoch 1 is still unsettled", L.settlementOf(home, P) === null && L.tabEpoch(home, P) === 1);
}

console.log("\n#2 — deposit credit is idempotent by canonical tx identity:");
{
  const before = L.balance(home, P).balance;
  const r1 = dep("0xDUP", 250_000);
  ok("first credit of a new deposit applies", L.balance(home, P).balance === before + 250_000);
  const r2 = dep("0xDUP", 250_000);              // SAME tx hash
  ok("a duplicate deposit (same tx) is a no-op — balance unchanged", L.balance(home, P).balance === before + 250_000 && r2.duplicate === true);
  // and across a restart / fresh replay
  const h2 = mkdtempSync(join(tmpdir(), "epoch-iso-replay-"));
  mkdirSync(join(h2, "metering"), { recursive: true });
  writeFileSync(join(h2, "metering/read-journal.jsonl"), readFileSync(join(home, "metering/read-journal.jsonl")));
  const L2 = await import(join(dist, "metering/ledger.js") + `?dup=${Date.now()}`);
  ok("replay does not re-apply the duplicate (balance matches live)", L2.balance(h2, P).balance === L.balance(home, P).balance);
}

console.log("\n#3 — refund idempotency is epoch-scoped, and refund is terminal:");
{
  // roll to a clean epoch by settling the current one
  const wid = "wd:pre3";
  const bal = L.balance(home, P).balance;
  S.prepareWithdrawal(home, { withdrawalId: wid, statementDigest: "sha256:pre3", amountMicroTrac: bal, destination: P, chainId: 8453, tabPrincipal: P });
  S.recordSignedWithdrawal(home, { withdrawalId: wid, sender: "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab", accountNonce: 3, txHash: "0xPRE3" });
  S.confirmWithdrawal(home, { withdrawalId: wid, receipt: { txHash: "0xPRE3", to: P, amountMicroTrac: bal, success: true, confirmations: 12 }, requiredConfirmations: 12 });
  const epA = L.tabEpoch(home, P);

  dep("0xR1", 1_000_000);                          // epoch A+1
  const TERMS = "sha256:same-terms-reused";
  const rf1 = L.refundOnExpiry(home, P, P, TERMS);
  ok("refund on the fresh epoch returns its balance", rf1.alreadyRefunded === false && rf1.refundedMicroTrac === 1_000_000);
  ok("the refunded epoch is terminal (balance 0)", L.balance(home, P).balance === 0);

  dep("0xR2", 1_000_000);                          // rolls again (refund was terminal)
  ok("a credit after refund rolls to a NEW epoch (refund is terminal, Bo #3)", L.tabEpoch(home, P) === epA + 2);
  ok("the new epoch is funded, not stuck at 0", L.balance(home, P).balance === 1_000_000);
  // refund again under the SAME terms digest — must refund the NEW balance, not
  // return alreadyRefunded from the old epoch.
  const rf2 = L.refundOnExpiry(home, P, P, TERMS);
  ok("refunding the new epoch under the SAME terms works (idempotency is epoch-scoped)", rf2.alreadyRefunded === false && rf2.refundedMicroTrac === 1_000_000);
  ok("its balance is now zero too", L.balance(home, P).balance === 0);
  // a genuine double-refund of the SAME epoch is still a no-op
  const rf2dup = L.refundOnExpiry(home, P, P, TERMS);
  ok("a repeat refund of the SAME (already-refunded) epoch is a no-op", rf2dup.alreadyRefunded === true && L.balance(home, P).balance === 0);
}

console.log("\n#4 — epoch is bound on legs, and history snapshots are immutable:");
{
  dep("0xL1", 1_000_000);
  openEpoch();
  const ep = L.tabEpoch(home, P);
  const leg = L.recordInferenceLeg(home, { principal: P, inputTokens: 10, outputTokens: 10, costMicroTrac: 80, policyDigest: "sha256:p", evidence: { schemaVersion: "receipt-v0.6" } });
  ok("a debit leg carries its tabEpoch", leg.tabEpoch === ep);
  // mutate a returned settlement-history object; the module's copy must not change
  const hist1 = L.settlementHistoryOf(home, P);
  if (hist1.length) { hist1[0].netPaidMicroTrac = 999999999; hist1[0].txHash = "0xTAMPERED"; }
  const hist2 = L.settlementHistoryOf(home, P);
  ok("mutating a returned history snapshot does NOT change the module's history (immutable at the boundary)",
    hist1.length === 0 || (hist2[0].netPaidMicroTrac !== 999999999 && hist2[0].txHash !== "0xTAMPERED"));
  // mutate a returned settlement; module state unchanged
  const s1 = L.settlementOf(home, P);
  if (s1) s1.netPaidMicroTrac = -1;
  const s2 = L.settlementOf(home, P);
  ok("mutating a returned settlement snapshot does NOT change module state", s1 === null || s2.netPaidMicroTrac !== -1);
  ok("tab state exposes the current epoch", typeof L.balance(home, P).epoch === "number");
}

console.log("\ncross-epoch replay integrity — every attack above reproduces from the journal:");
{
  const h3 = mkdtempSync(join(tmpdir(), "epoch-iso-full-"));
  mkdirSync(join(h3, "metering"), { recursive: true });
  writeFileSync(join(h3, "metering/read-journal.jsonl"), readFileSync(join(home, "metering/read-journal.jsonl")));
  const L3 = await import(join(dist, "metering/ledger.js") + `?full=${Date.now()}`);
  ok("replayed epoch matches live", L3.tabEpoch(h3, P) === L.tabEpoch(home, P));
  ok("replayed balance matches live", L3.balance(h3, P).balance === L.balance(home, P).balance);
  ok("replayed settlement matches live", JSON.stringify(L3.settlementOf(h3, P)) === JSON.stringify(L.settlementOf(home, P)));
}

console.log(`\n${pass}/${pass + fail} tab-epoch-isolation gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
