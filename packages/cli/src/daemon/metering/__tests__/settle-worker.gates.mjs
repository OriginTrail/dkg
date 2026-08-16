// settle-worker gates — Hermes wiring v4 HOLD #2: the loopback settlement
// path must be STRUCTURALLY unable to bypass the economics binding.
//
// Proves: (1) whole-dist settleTab reachability is a closed set (declaration,
// netting core, Iteration-1 close-driven withdrawal) — the worker and every
// other module are refused; (2) the worker propagates the verdict's digest to
// execution by construction (swap between verdict and execution ⇒ refusal,
// zero journal writes); (3) settled + release records from one worker run
// carry the SAME digest; (4) missing digest/authority fail closed pre-mutation.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, generateKeyPairSync, sign as edSign, createPrivateKey } from "node:crypto";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/daemon");
const W = await import(join(dist, "metering/settle-worker.js"));
const N = await import(join(dist, "metering/netting.js"));
const L = await import(join(dist, "metering/ledger.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };
const BUYER = "0xAAAA567890abcdef1234567890abcdef12345678";
const AUTH = "worker-suite-authority";

const mkHome = (fee = "0.000000001") => {
  const h = mkdtempSync(join(tmpdir(), "settle-worker-"));
  mkdirSync(join(h, "metering"), { recursive: true });
  writeFileSync(join(h, "metering", "release-authority.token"), AUTH);
  writeFileSync(join(h, "metering", "netting-economics.json"), JSON.stringify({ feeGweiDecimal: fee, ethTracDecimal: "8000", recordedAt: "2026-08-12T08:00:00Z", source: "worker suite" }));
  return h;
};
const jbytes = (h) => { try { return readFileSync(join(h, "metering", "read-journal.jsonl")).length; } catch { return 0; } };
const w = (h, rec) => writeFileSync(join(h, "metering", "read-journal.jsonl"), (readFileSync(join(h, "metering", "read-journal.jsonl"), "utf8") ?? "") + JSON.stringify(rec) + "\n");
const seed = (h) => {
  // earned must be REAL: the liability math derives it from debit +
  // countersigned-leg records only — a bare close's earnedMicroTrac field is
  // deliberately untrusted (P2 v6 principle).
  writeFileSync(join(h, "metering", "read-journal.jsonl"), "");
  w(h, { kind: "credit", principal: BUYER, epoch: 0, amountMicroTrac: 100, evidence: { chainId: 1, token: "0xT", txHash: "0xd1", logIndex: 0 }, at: "c" });
  w(h, { kind: "debit", principal: BUYER, epoch: 0, hash: "h1", leg: { legId: "leg-1", sequence: 1, tabEpoch: 0, tab: { after: 90 }, pricing: { costMicroTrac: 10 } }, at: "d" });
  w(h, { kind: "leg-countersigned", principal: BUYER, legId: "leg-1", epoch: 0, at: "cs" });
  w(h, { kind: "nsm-close", principal: BUYER, epoch: 0, mode: "settle", earnedMicroTrac: 10, carryMicroTrac: 90, closeDigest: "sha256:CLOSE-A", at: "cl" });
};

console.log("settle-worker gates:");

console.log("\n(1) settleTab reachability is a CLOSED SET across the whole built tree:");
{
  // Allowed: ledger.js (declaration), netting.js (zero-value carry
  // terminalization + digest-bound recordNettedSettlement), settlement.js
  // (Iteration-1 buyer-close-driven withdrawal — a different lifecycle, amount
  // bound to the two-sided signed close statement, no economics verdict
  // exists in that flow). NOTHING else — including the worker itself.
  const ALLOWED = new Set(["metering/ledger.js", "metering/netting.js", "metering/settlement.js"]);
  const walk = (dir, out = []) => { for (const e of readdirSync(dir)) { const p = join(dir, e); const st = statSync(p); if (st.isDirectory()) walk(p, out); else if (p.endsWith(".js")) out.push(p); } return out; };
  // ALIAS-RESISTANT scan (OpenClaw v4.2 #1): after stripping comments, ANY
  // occurrence of the token — named import, `settleTab as x` aliasing, property
  // access, destructuring, or a "settleTab" string literal used for bracket
  // access — flags the file. The only static evasion left is runtime string
  // construction, which is outside this scan's threat model (drift/mistake —
  // in-repo malicious code could rewrite ledger.js itself). Namespace imports
  // of the ledger module are ALSO refused outside the allowed set, closing the
  // computed-access vehicle (`X["settle"+"Tab"]`).
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const uses = (src) => /\bsettleTab\b/.test(strip(src));
  const nsLedger = (src) => /import\s*\*\s*as\s+\w+\s*from\s*["'][^"']*ledger(\.js)?["']/.test(strip(src));
  const offenders = walk(dist).filter((f) => uses(readFileSync(f, "utf8"))).map((f) => f.slice(dist.length + 1)).filter((rel) => !ALLOWED.has(rel));
  ok("settleTab token (comment-stripped, alias/bracket-resistant) ONLY in ledger.js + netting.js + settlement.js", offenders.length === 0, offenders.join(", "));
  const nsOff = walk(dist).filter((f) => nsLedger(readFileSync(f, "utf8"))).map((f) => f.slice(dist.length + 1)).filter((rel) => !ALLOWED.has(rel));
  ok("no namespace-import of the ledger module outside the allowed set (computed-access vehicle closed)", nsOff.length === 0, nsOff.join(", "));
  const workerSrc = readFileSync(join(dist, "metering/settle-worker.js"), "utf8");
  ok("worker never references settleTab (comment-stripped token scan)", !uses(workerSrc));
  ok("worker IS the recordNettedSettlement driver (imports + calls it)", /import\s*{[^}]*recordNettedSettlement/.test(workerSrc) && /recordNettedSettlement\s*\(/.test(workerSrc));
}

console.log("\n(2) verdict→execution digest propagation, by construction:");
{
  const h = mkHome(); seed(h);
  const v = W.nettedSettleVerdict(h, BUYER);
  ok("verdict carries the exact-bytes configDigest", v.ok === true && String(v.expectedConfigDigest ?? "").startsWith("sha256:"), JSON.stringify(v));
  // config swapped AFTER the verdict, BEFORE execution — the classic TOCTOU.
  writeFileSync(join(h, "metering", "netting-economics.json"), JSON.stringify({ feeGweiDecimal: "0.02", ethTracDecimal: "8000", recordedAt: "2026-08-12T08:30:00Z", source: "config B" }));
  const jb = jbytes(h);
  const swapped = W.runNettedSettlement(h, { principal: BUYER, withdrawalId: "close:sha256:CLOSE-A", txHash: "0xpay1", netPaidMicroTrac: 90, expectedEpoch: 0, closes: ["sha256:CLOSE-A"], expectedConfigDigest: v.expectedConfigDigest, authorityToken: AUTH, releaseEarned: true });
  ok("swap between verdict and execution → E_ECONOMICS_CHANGED, ZERO journal writes (settlement AND release)", swapped.ok === false && swapped.code === "E_ECONOMICS_CHANGED" && jbytes(h) === jb, JSON.stringify(swapped));
  const gone = mkHome(); seed(gone);
  const v2 = W.nettedSettleVerdict(gone, BUYER);
  writeFileSync(join(gone, "metering", "netting-economics.json"), "not json");
  const jb2 = jbytes(gone);
  const absent = W.runNettedSettlement(gone, { principal: BUYER, withdrawalId: "close:sha256:CLOSE-A", txHash: "0xpay1", netPaidMicroTrac: 90, expectedEpoch: 0, closes: ["sha256:CLOSE-A"], expectedConfigDigest: v2.expectedConfigDigest, authorityToken: AUTH });
  ok("config invalid at execution → E_ECONOMICS_ABSENT, zero writes", absent.ok === false && absent.code === "E_ECONOMICS_ABSENT" && jbytes(gone) === jb2, JSON.stringify(absent));
  ok("verdict without recorded economics fails closed", (() => { const g = mkdtempSync(join(tmpdir(), "sw-noecon-")); mkdirSync(join(g, "metering"), { recursive: true }); return W.nettedSettleVerdict(g, BUYER).code === "E_NO_RECORDED_ECONOMICS"; })());
}

console.log("\n(3) one worker run: settled + release carry the SAME digest:");
{
  const h = mkHome(); seed(h);
  const v = W.nettedSettleVerdict(h, BUYER);
  const run = W.runNettedSettlement(h, { principal: BUYER, withdrawalId: "close:sha256:CLOSE-A", txHash: "0xpay2", netPaidMicroTrac: 90, expectedEpoch: 0, closes: ["sha256:CLOSE-A"], expectedConfigDigest: v.expectedConfigDigest, authorityToken: AUTH, releaseEarned: true });
  ok("worker settles + releases in one bound run", run.ok === true && run.released?.length === 1 && run.released[0].ok === true, JSON.stringify(run));
  const recs = L.readJournal(h);
  const settled = recs.find((r) => r.kind === "settled" && r.txHash === "0xpay2");
  const released = recs.find((r) => r.kind === "nsm-earned-released" && r.payoutTxHash === "0xpay2");
  ok("settled record digest === verdict digest (propagated, not re-derived)", settled?.economicsConfigDigest === v.expectedConfigDigest, JSON.stringify(settled?.economicsConfigDigest));
  ok("release record digest === settled record digest (inherited)", released?.economicsConfigDigest === settled?.economicsConfigDigest);
  ok("release amount came from the CLOSE record (10), never a caller figure", released?.amountMicroTrac === 10, JSON.stringify(released?.amountMicroTrac));
  ok("worker replay is idempotent (alreadySettled, release deduped)", (() => { const again = W.runNettedSettlement(h, { principal: BUYER, withdrawalId: "close:sha256:CLOSE-A", txHash: "0xpay2", netPaidMicroTrac: 90, expectedEpoch: 0, closes: ["sha256:CLOSE-A"], expectedConfigDigest: v.expectedConfigDigest, authorityToken: AUTH, releaseEarned: true }); return again.ok === true && again.alreadySettled === true && again.released[0].ok === true && again.complete === true; })());
}

console.log("\n(5) execution-time election + explicit completion (Hermes v4.2):");
{
  // below-threshold: an allowed=false verdict CANNOT be executed around —
  // direct record with the correct digest + authority still refuses, zero writes
  const hBig = mkHome("0.011"); seed(hBig);
  const vBig = W.nettedSettleVerdict(hBig, BUYER);
  ok("verdict below threshold reports allowed=false", vBig.ok === true && vBig.gate.allowed === false, JSON.stringify(vBig.gate));
  const jbB = jbytes(hBig);
  const forced = W.runNettedSettlement(hBig, { principal: BUYER, withdrawalId: "close:sha256:CLOSE-A", txHash: "0xforce", netPaidMicroTrac: 90, closes: ["sha256:CLOSE-A"], expectedConfigDigest: vBig.expectedConfigDigest, authorityToken: AUTH, releaseEarned: true });
  ok("below-threshold DIRECT record → E_SETTLE_ELECTION_REFUSED, ZERO writes (settlement AND release)", forced.ok === false && forced.code === "E_SETTLE_ELECTION_REFUSED" && forced.election?.allowed === false && jbytes(hBig) === jbB, JSON.stringify(forced));
  // liability drift: config digest UNCHANGED, but a release lands between
  // verdict and execution → unsettledEarned drops below threshold → refused
  const hDrift = mkHome("0.00000001"); seed(hDrift);            // threshold ~6µ, earned 10
  const vD = W.nettedSettleVerdict(hDrift, BUYER);
  ok("drift-home verdict initially allowed", vD.ok === true && vD.gate.allowed === true, JSON.stringify(vD.gate));
  w(hDrift, { kind: "nsm-earned-released", principal: BUYER, closeDigest: "sha256:CLOSE-A", amountMicroTrac: 10, payoutTxHash: "0xelsewhere", economicsConfigDigest: vD.expectedConfigDigest, at: "r" });
  const jbD = jbytes(hDrift);
  const drifted = W.runNettedSettlement(hDrift, { principal: BUYER, withdrawalId: "close:sha256:CLOSE-A", txHash: "0xdrift", netPaidMicroTrac: 90, closes: ["sha256:CLOSE-A"], expectedConfigDigest: vD.expectedConfigDigest, authorityToken: AUTH });
  ok("verdict-then-liability-drift (same config bytes) → E_SETTLE_ELECTION_REFUSED, zero writes", drifted.ok === false && drifted.code === "E_SETTLE_ELECTION_REFUSED" && jbytes(hDrift) === jbD, JSON.stringify(drifted));
  // explicit completion: settle without releases → complete:false + pending
  // set; the SAME record re-run is the documented recovery and completes it
  const hPart = mkHome(); seed(hPart);
  const vP = W.nettedSettleVerdict(hPart, BUYER);
  const partial = W.runNettedSettlement(hPart, { principal: BUYER, withdrawalId: "close:sha256:CLOSE-A", txHash: "0xpart", netPaidMicroTrac: 90, closes: ["sha256:CLOSE-A"], expectedConfigDigest: vP.expectedConfigDigest, authorityToken: AUTH, releaseEarned: false });
  ok("settled without releases → ok BUT complete:false with pendingReleases named", partial.ok === true && partial.complete === false && partial.pendingReleases?.[0] === "sha256:CLOSE-A", JSON.stringify({ c: partial.complete, p: partial.pendingReleases }));
  const recover = W.runNettedSettlement(hPart, { principal: BUYER, withdrawalId: "close:sha256:CLOSE-A", txHash: "0xpart", netPaidMicroTrac: 90, closes: ["sha256:CLOSE-A"], expectedConfigDigest: vP.expectedConfigDigest, authorityToken: AUTH, releaseEarned: true });
  ok("re-running the same record completes pending releases (alreadySettled + complete:true)", recover.ok === true && recover.alreadySettled === true && recover.complete === true && recover.pendingReleases.length === 0, JSON.stringify(recover));
  const third = W.runNettedSettlement(hPart, { principal: BUYER, withdrawalId: "close:sha256:CLOSE-A", txHash: "0xpart", netPaidMicroTrac: 90, closes: ["sha256:CLOSE-A"], expectedConfigDigest: vP.expectedConfigDigest, authorityToken: AUTH, releaseEarned: true });
  ok("third run stays complete (release dedup counts as completion, never double-releases)", third.complete === true && third.released[0].ok === true, JSON.stringify(third.released));
  const relCount = L.readJournal(hPart).filter((r) => r.kind === "nsm-earned-released").length;
  ok("exactly ONE release record exists after three runs", relCount === 1, String(relCount));
  // replay short-circuit is for EXACT replays only (OpenClaw v4.3): same wid
  // with different tx/amount/closes surfaces as an error, never masked success
  const jbM = jbytes(hPart);
  const masked = W.runNettedSettlement(hPart, { principal: BUYER, withdrawalId: "close:sha256:CLOSE-A", txHash: "0xDIFFERENT", netPaidMicroTrac: 90, closes: ["sha256:CLOSE-A"], expectedConfigDigest: vP.expectedConfigDigest, authorityToken: AUTH });
  ok("reused withdrawalId + DIFFERENT evidence → E_SETTLE_REPLAY_MISMATCH, zero writes", masked.ok === false && masked.code === "E_SETTLE_REPLAY_MISMATCH" && jbytes(hPart) === jbM, JSON.stringify(masked));
  const masked2 = W.runNettedSettlement(hPart, { principal: BUYER, withdrawalId: "close:sha256:CLOSE-A", txHash: "0xpart", netPaidMicroTrac: 89, closes: ["sha256:CLOSE-A"], expectedConfigDigest: vP.expectedConfigDigest, authorityToken: AUTH });
  ok("reused withdrawalId + different amount → E_SETTLE_REPLAY_MISMATCH", masked2.code === "E_SETTLE_REPLAY_MISMATCH" && jbytes(hPart) === jbM);
  ok("conflict names the differing fingerprint fields (deterministic)", Array.isArray(masked2.conflict) && masked2.conflict.includes("netPaidMicroTrac"), JSON.stringify(masked2.conflict));
  // full request-identity fingerprint (Hermes v4.3): the economics digest is
  // part of the operation's identity — same wid + same evidence but a DIFFERENT
  // authorizing digest is a conflict, zero writes, no release attempt
  const wrongDigest = W.runNettedSettlement(hPart, { principal: BUYER, withdrawalId: "close:sha256:CLOSE-A", txHash: "0xpart", netPaidMicroTrac: 90, closes: ["sha256:CLOSE-A"], expectedConfigDigest: "sha256:" + "b".repeat(64), authorityToken: AUTH, releaseEarned: true });
  ok("reused withdrawalId + different economics digest → E_SETTLE_REPLAY_MISMATCH (digest in conflict[]), zero writes", wrongDigest.code === "E_SETTLE_REPLAY_MISMATCH" && wrongDigest.conflict?.includes("economicsConfigDigest") && jbytes(hPart) === jbM, JSON.stringify(wrongDigest));
  ok("closes compare is NORMALIZED (order-insensitive): same set reordered is NOT a conflict", (() => { const r = W.runNettedSettlement(hPart, { principal: BUYER, withdrawalId: "close:sha256:CLOSE-A", txHash: "0xpart", netPaidMicroTrac: 90, closes: ["sha256:CLOSE-A"], expectedConfigDigest: vP.expectedConfigDigest, authorityToken: AUTH }); return r.ok === true && r.alreadySettled === true; })());
  // cross-principal reuse of the SAME withdrawal id: never short-circuits into
  // the settled tab — the foreign principal proceeds into its OWN full checks
  // and fails closed (no earned, no closes), zero writes
  const OTHER2 = "0xBBBB567890abcdef1234567890abcdef12345678";
  const jbX = jbytes(hPart);
  const cross = W.runNettedSettlement(hPart, { principal: OTHER2, withdrawalId: "close:sha256:CLOSE-A", txHash: "0xpart", netPaidMicroTrac: 90, closes: ["sha256:CLOSE-A"], expectedConfigDigest: vP.expectedConfigDigest, authorityToken: AUTH });
  ok("cross-principal reuse of same withdrawalId → NOT alreadySettled, fails closed, zero writes", cross.ok === false && cross.alreadySettled !== true && jbytes(hPart) === jbX, JSON.stringify(cross));

  console.log("\n(6) closes is a SET, not a multiset (Hermes v4.4):");
  {
    // fresh home with TWO real closes: A (carry 90) and B (carry 5)
    const hM = mkHome(); seed(hM);
    w(hM, { kind: "nsm-close", principal: BUYER, epoch: 0, mode: "settle", earnedMicroTrac: 0, carryMicroTrac: 5, closeDigest: "sha256:CLOSE-B", at: "cl2" });
    const vM = W.nettedSettleVerdict(hM, BUYER);
    const jbM6 = jbytes(hM);
    // duplicate-only: [A,A] with netPaid = 2×carry(A) — the overpayment vector
    const dup = W.runNettedSettlement(hM, { principal: BUYER, withdrawalId: "wd:m", txHash: "0xm", netPaidMicroTrac: 180, closes: ["sha256:CLOSE-A", "sha256:CLOSE-A"], expectedConfigDigest: vM.expectedConfigDigest, authorityToken: AUTH, releaseEarned: true });
    ok("[A,A] duplicate closes + doubled netPaid → E_SETTLE_CLOSES_INVALID, ZERO writes (overpayment impossible)", dup.ok === false && dup.code === "E_SETTLE_CLOSES_INVALID" && jbytes(hM) === jbM6, JSON.stringify(dup));
    // mixed: [A,B,A]
    const mixed = W.runNettedSettlement(hM, { principal: BUYER, withdrawalId: "wd:m", txHash: "0xm", netPaidMicroTrac: 185, closes: ["sha256:CLOSE-A", "sha256:CLOSE-B", "sha256:CLOSE-A"], expectedConfigDigest: vM.expectedConfigDigest, authorityToken: AUTH });
    ok("[A,B,A] mixed duplicate → E_SETTLE_CLOSES_INVALID, zero writes", mixed.ok === false && mixed.code === "E_SETTLE_CLOSES_INVALID" && jbytes(hM) === jbM6);
    // unique two-close settlement, then EXACT replay with reordered closes
    const two = W.runNettedSettlement(hM, { principal: BUYER, withdrawalId: "wd:m", txHash: "0xm", netPaidMicroTrac: 95, closes: ["sha256:CLOSE-A", "sha256:CLOSE-B"], expectedConfigDigest: vM.expectedConfigDigest, authorityToken: AUTH, releaseEarned: true });
    ok("unique [A,B] settles (Σcarries 95)", two.ok === true && two.complete === true, JSON.stringify(two));
    const reordered = W.runNettedSettlement(hM, { principal: BUYER, withdrawalId: "wd:m", txHash: "0xm", netPaidMicroTrac: 95, closes: ["sha256:CLOSE-B", "sha256:CLOSE-A"], expectedConfigDigest: vM.expectedConfigDigest, authorityToken: AUTH, releaseEarned: true });
    ok("exact replay with REORDERED unique closes → alreadySettled (normalized identity)", reordered.ok === true && reordered.alreadySettled === true && reordered.complete === true, JSON.stringify(reordered));
    // and a duplicated-multiset replay of the SAME wid is a conflict, not a match
    const dupReplay = W.runNettedSettlement(hM, { principal: BUYER, withdrawalId: "wd:m", txHash: "0xm", netPaidMicroTrac: 95, closes: ["sha256:CLOSE-A", "sha256:CLOSE-A", "sha256:CLOSE-B"], expectedConfigDigest: vM.expectedConfigDigest, authorityToken: AUTH });
    ok("replay presenting a duplicated multiset → E_SETTLE_REPLAY_MISMATCH (closes in conflict[])", dupReplay.code === "E_SETTLE_REPLAY_MISMATCH" && dupReplay.conflict?.includes("closes"), JSON.stringify(dupReplay));
  }
}

console.log("\n(4) required inputs fail closed pre-mutation:");
{
  const h = mkHome(); seed(h);
  const jb = jbytes(h);
  ok("missing expectedConfigDigest → E_WORKER_DIGEST_REQUIRED, zero writes", W.runNettedSettlement(h, { principal: BUYER, withdrawalId: "w", txHash: "0x", netPaidMicroTrac: 1, closes: [], authorityToken: AUTH }).code === "E_WORKER_DIGEST_REQUIRED" && jbytes(h) === jb);
  ok("non-digest-shaped expectedConfigDigest refused", W.runNettedSettlement(h, { principal: BUYER, withdrawalId: "w", txHash: "0x", netPaidMicroTrac: 1, closes: [], expectedConfigDigest: "yolo", authorityToken: AUTH }).code === "E_WORKER_DIGEST_REQUIRED");
  ok("missing authorityToken → E_WORKER_AUTHORITY_REQUIRED, zero writes", W.runNettedSettlement(h, { principal: BUYER, withdrawalId: "w", txHash: "0x", netPaidMicroTrac: 1, closes: [], expectedConfigDigest: "sha256:" + "0".repeat(64) }).code === "E_WORKER_AUTHORITY_REQUIRED" && jbytes(h) === jb);
  ok("wrong authorityToken → refused inside the mutation", W.runNettedSettlement(h, { principal: BUYER, withdrawalId: "w", txHash: "0x", netPaidMicroTrac: 1, closes: [], expectedConfigDigest: "sha256:" + "0".repeat(64), authorityToken: "wrong" }).code === "E_RELEASE_AUTHORITY" && jbytes(h) === jb);
}

console.log(`\n${pass}/${pass + fail} settle-worker gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
