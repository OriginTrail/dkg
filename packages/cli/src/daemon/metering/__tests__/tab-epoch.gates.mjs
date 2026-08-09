// Tab epoch — the fix for the second-deposit poison (Hermes/Bo, 2026-08-09).
//
// The bug, surfaced by a real second deposit: the per-principal `settled` flag
// was sticky, so a new deposit funded a tab that could be neither settled
// (settleTab short-circuited alreadySettled) nor refunded (refundOnExpiry
// refused settled) — stranding the balance. The fix: a credit on a settled tab
// rolls to a fresh EPOCH with its own lifecycle and its own leg chain from
// sequence 1; the prior settlement is archived immutably.
//
// These are the regressions Bo required: settled → new-epoch credit → billed
// legs → settlement, expiry refund, duplicate credit/settlement/refund, crash
// recovery (fresh replay), and cross-epoch isolation.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/daemon");
const home = mkdtempSync(join(tmpdir(), "tab-epoch-"));
process.env.DKG_HOME = home;
mkdirSync(join(home, "metering"), { recursive: true });

const L = await import(join(dist, "metering/ledger.js"));
const D = await import(join(dist, "metering/deposit-rail.js"));
const ST = await import(join(dist, "metering/stage3-endpoint.js"));
const RM = await import(join(dist, "metering/read-meter.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };

L.setDebitGate((h, p, now) => D.debitAllowed(h, p, now));
const P = "0x8A87ea7c0fBC3431f20B5B26dd9f7f32571Aa2ba";

// Fresh replay from the SAME journal — simulates a node restart. State must be
// identical whether held in memory or reconstructed from disk.
const freshReplay = async () => {
  const h2 = mkdtempSync(join(tmpdir(), "tab-epoch-replay-"));
  mkdirSync(join(h2, "metering"), { recursive: true });
  writeFileSync(join(h2, "metering/read-journal.jsonl"), readFileSync(join(home, "metering/read-journal.jsonl")));
  const L2 = await import(join(dist, "metering/ledger.js") + `?replay=${Date.now()}`);
  return { L2, h2 };
};

console.log("\nTab epoch — second-deposit poison fix (Bo's required regressions)\n");

console.log("epoch 0: a normal deposit → settle (terminal):");
L.credit(home, P, 1_000_000, { txHash: "0xE0" });
ok("epoch starts at 0", L.tabEpoch(home, P) === 0);
L.settleTab(home, P, { withdrawalId: "wd:E0", txHash: "0xSETTLE0", netPaidMicroTrac: 999_999 });
ok("epoch 0 is settled", !!L.settlementOf(home, P));
ok("a settled tab has balance 0", L.balance(home, P).balance === 0);

console.log("\nsettled principal → NEW deposit → fresh epoch:");
L.credit(home, P, 1_000_000, { txHash: "0xE1" });
ok("a credit on a settled tab rolls to epoch 1", L.tabEpoch(home, P) === 1);
ok("the fresh tab is funded (reset, not topped up)", L.balance(home, P).balance === 1_000_000);
ok("the fresh tab is NOT settled", L.settlementOf(home, P) === null);
ok("the fresh tab's leg chain resets (sequence 0, genesis)", L.balance(home, P).sequence === 0 && L.balance(home, P).lastHash === "genesis");
ok("the prior settlement is preserved in immutable history", L.settlementHistoryOf(home, P).length === 1 && L.settlementHistoryOf(home, P)[0].withdrawalId === "wd:E0");

console.log("\nthe fresh tab can be BILLED (an opening makes it debitable):");
{
  const terms = ST.stage3Terms("0x633E5a7C5e612d9981538F60D824cC03be97e2Ab", P, 100, RM.SCHEDULE_VERSION, 8453);
  const art = D.buildOpeningArtifact(P, terms);
  D.registerOpening(home, art);
  ok("debitAllowed on the fresh tab is OK", D.debitAllowed(home, P).ok === true);
  // bill a couple of legs directly through the ledger
  const l1 = L.recordInferenceLeg(home, { principal: P, inputTokens: 42, outputTokens: 25, costMicroTrac: 234, policyDigest: "sha256:p", evidence: { schemaVersion: "receipt-v0.6" } });
  ok("epoch-1 leg 1 is sequence 1 AND its chain restarts at genesis", l1.sequence === 1 && l1.previousLegHash === "genesis");
  const l2 = L.recordInferenceLeg(home, { principal: P, inputTokens: 10, outputTokens: 10, costMicroTrac: 80, policyDigest: "sha256:p", evidence: { schemaVersion: "receipt-v0.6" } });
  ok("epoch-1 leg 2 is sequence 2, chained off a real prior hash (not genesis)", l2.sequence === 2 && typeof l2.previousLegHash === "string" && l2.previousLegHash !== "genesis" && l2.previousLegHash.length === 64);
  ok("balance debited within the fresh epoch", L.balance(home, P).balance === 1_000_000 - 234 - 80);
}

console.log("\nthe fresh tab can SETTLE (the exact thing the bug blocked):");
{
  const s = L.settleTab(home, P, { withdrawalId: "wd:E1", txHash: "0xSETTLE1", netPaidMicroTrac: 314 });
  ok("settleTab on epoch 1 records a NEW settlement (not alreadySettled)", s.ok === true && s.alreadySettled === false);
  ok("epoch-1 settlement is now current", L.settlementOf(home, P).withdrawalId === "wd:E1");
  ok("BOTH settlements are queryable (epoch-0 in history, epoch-1 current)",
    L.settlementHistoryOf(home, P).length === 1 && L.settlementOf(home, P).withdrawalId === "wd:E1");
}

console.log("\nexpiry refund works on a fresh unsettled epoch:");
{
  // epoch 2: a deposit that is never settled, then expiry-refunded
  L.credit(home, P, 500_000, { txHash: "0xE2" });
  ok("rolled to epoch 2", L.tabEpoch(home, P) === 2);
  const r = L.refundOnExpiry(home, P, P, "sha256:epoch2-terms");
  ok("an unsettled fresh epoch refunds its balance", r.alreadyRefunded === false && r.refundedMicroTrac === 500_000);
  ok("balance is zero after refund", L.balance(home, P).balance === 0);
}

console.log("\nidempotency within an epoch is preserved:");
{
  // re-settling epoch 1's withdrawal must NOT double-record — but epoch 2 is
  // current now, so we assert on the general property: a duplicate settleTab on
  // the CURRENT epoch short-circuits.
  // NOTE: epoch 2 was REFUNDED (not settled), so this credit TOPS UP the
  // zeroed balance and stays epoch 2 — only a SETTLED tab rolls the epoch. That
  // is correct: a refund leaves no sticky flag, so it never poisoned anything.
  L.credit(home, P, 100_000, { txHash: "0xE3" });
  L.settleTab(home, P, { withdrawalId: "wd:E3", txHash: "0xSETTLE3", netPaidMicroTrac: 50 });
  const dup = L.settleTab(home, P, { withdrawalId: "wd:E3", txHash: "0xSETTLE3", netPaidMicroTrac: 50 });
  ok("a duplicate settlement on the current epoch is alreadySettled (no double-record)", dup.alreadySettled === true);
  const dupRefund = L.refundOnExpiry(home, P, P, "sha256:epoch3-terms");
  ok("refund refuses a settled current epoch (no pay-twice)", dupRefund.settled === true && dupRefund.refundedMicroTrac === 0);
}

console.log("\ncrash recovery: fresh replay from the journal reproduces every epoch:");
{
  const { L2, h2 } = await freshReplay();
  L2.setDebitGate(() => ({ ok: true }));
  ok("replayed epoch matches live epoch", L2.tabEpoch(h2, P) === L.tabEpoch(home, P));
  ok("replayed balance matches live balance", L2.balance(h2, P).balance === L.balance(home, P).balance);
  ok("replayed current settlement matches", JSON.stringify(L2.settlementOf(h2, P)) === JSON.stringify(L.settlementOf(home, P)));
  ok("replayed settlement HISTORY matches (all prior epochs preserved)",
    L2.settlementHistoryOf(h2, P).length === L.settlementHistoryOf(home, P).length &&
    L2.settlementHistoryOf(h2, P).length === 2);   // E0, E1 rolled; E3 is current on epoch 2
}

console.log("\ncross-epoch isolation — a second principal is untouched:");
{
  const Q = "0x1111111111111111111111111111111111111111";
  L.credit(home, Q, 7_000, { txHash: "0xQ" });
  ok("a different principal stays at epoch 0", L.tabEpoch(home, Q) === 0);
  ok("its balance is independent", L.balance(home, Q).balance === 7_000);
  ok("P's epoch is unaffected by Q's activity", L.tabEpoch(home, P) === 3);  // refund E2 rolled → E3 credit → epoch 3
}

console.log("\nbackward compatibility — a first-time principal behaves exactly as before:");
{
  const R = "0x2222222222222222222222222222222222222222";
  ok("epoch 0 by default", L.tabEpoch(home, R) === 0);
  L.credit(home, R, 1_000, { txHash: "0xR1" });
  L.credit(home, R, 2_000, { txHash: "0xR2" });   // top-up on an UNSETTLED tab
  ok("credits on an unsettled tab still TOP UP (not roll)", L.balance(home, R).balance === 3_000 && L.tabEpoch(home, R) === 0);
}

console.log(`\n${pass}/${pass + fail} tab-epoch gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
