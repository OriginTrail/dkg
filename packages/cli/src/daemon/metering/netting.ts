// P2 — rollover / netting custody & claim state machine.
//
// IMPLEMENTS the FROZEN P0 contract `contract-freeze/netting-state-machine.md`
// (v1.5 set, double-passed 2026-08-11). The frozen spec is normative; this file
// adds no semantics beyond it. Ledger quantities, the I1 conservation identity,
// the I7 close CAS, carry-credit rollover, and the threshold-gated provider
// election are all defined there; deviations reopen the P0 gate by definition.
//
// Design constraints honored:
//  - Journal-native: every quantity is recomputed from the durable journal
//    (readJournal) — no parallel in-memory state to diverge (Iteration-1 lesson).
//  - Only existing hardened primitives mutate money state: credit() for the
//    carry (deduped by canonicalDepositId over an internal-carry identity, so a
//    close digest can fund at most ONE carry — I2/I3), refund/settle paths for
//    exits. New record kinds (`nsm-close`) are ignored by ledger.replay()
//    by construction (unknown kinds skip), so balances cannot fork.
//  - The close CAS critical section is SYNCHRONOUS — no await between the
//    epoch-taken check and the durable append (G-I7b asserts this structurally).
import { createHash, createPublicKey, verify as edVerify, timingSafeEqual } from "node:crypto";
import { readFileSync as rfs, existsSync as exs } from "node:fs";
import { join as pjoin } from "node:path";
import {
  readJournal, appendJournal, credit, settleTab, settlementOf, canonicalize,
} from "./ledger.js";

const sha256 = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");

// ── PINNED threshold rule (contract-freeze/cost-vectors.mjs v1.5) ────────────
// settle-election threshold(ε) = ceil(gasCostTRACwei / ε); all integer wei;
// conversions ceiled so no step can understate. ε = 0.1% exactly.
export const GAS_TOTAL = 34_779 + 34_420;          // measured txs 0x66823b33…, 0x24241fa7…
export const EPS_NUM = 1n, EPS_DEN = 1000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** Canonical unsigned decimal → exact rational (frozen grammar; refuses non-canonical). */
export function decToRational(str: string): { num: bigint; den: bigint } {
  const t = String(str);
  if (!/^(0|[1-9]\d*)(\.\d*[1-9])?$/.test(t)) throw new Error(`E_BAD_DECIMAL_INPUT: ${JSON.stringify(str)}`);
  const [i, f = ""] = t.split(".");
  if (f.length > 30 || i.length > 12) throw new Error("E_INPUT_OUT_OF_RANGE");
  const r = { num: BigInt(i + f), den: 10n ** BigInt(f.length) };
  if (r.num === 0n) throw new Error("E_ZERO_INPUT");
  return r;
}
/** Live-derived settle threshold in µTRAC as a BIGINT (review, OpenClaw: the
 *  money path must not pass through Number where extreme inputs could exceed
 *  2^53). Re-derived each CLOSING — I6. */
export function settleThresholdMicroTracBig(feeGweiDecimal: string, ethTracDecimal: string): bigint {
  const fee = decToRational(feeGweiDecimal), rate = decToRational(ethTracDecimal);
  const feeWeiPerGas = ceilDiv(fee.num * 1_000_000_000n, fee.den);
  const gasCostWeiTrac = ceilDiv(BigInt(GAS_TOTAL) * feeWeiPerGas * rate.num, rate.den);
  const thresholdWei = ceilDiv(gasCostWeiTrac * EPS_DEN, EPS_NUM);
  return ceilDiv(thresholdWei, 1_000_000_000_000n);           // wei → µTRAC, ceiled
}
/** Number convenience — REFUSES rather than silently losing precision. */
export function settleThresholdMicroTrac(feeGweiDecimal: string, ethTracDecimal: string): number {
  const big = settleThresholdMicroTracBig(feeGweiDecimal, ethTracDecimal);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("E_THRESHOLD_EXCEEDS_SAFE_INTEGER");
  return Number(big);
}

// ── ledger quantities (frozen definitions, journal-derived) ──────────────────
export interface LedgerQuantities {
  epoch: number;                    // current epoch (max epoch seen in credits)
  depositsOnchainMicroTrac: number; // Σ credits with REAL chain evidence (carry excluded)
  payoutsMicroTrac: number;         // Σ settled.netPaid (on-chain transfers out)
  refundsMicroTrac: number;         // Σ refund records
  grossCurrent: number;             // gross(current) = credits into current epoch (deposit + carry-in)
  billedCurrent: number;            // Σ served leg costs, current epoch
  earnedCurrent: number;            // Σ countersigned leg costs, current epoch
  voidedCurrent: number;            // billed − earned (current)
  refundableCurrent: number;        // gross − earned (current) — the anytime-refund amount (I4)
  unsettledEarned: number;          // Σ earned of CLOSED epochs − payouts already made against them
  carryInFlightMicroTrac: number;   // carry terminalized but not yet credited (frozen I1 term)
}
export function ledgerQuantities(home: string, principal: string): LedgerQuantities {
  const p = principal.toLowerCase();
  const recs = readJournal(home).filter((r) => String(r.principal ?? "").toLowerCase() === p);
  // Epoch mini-replay, mirroring the ledger's rule exactly: the first credit
  // opens epoch 0; a credit AFTER a terminal event (settled / terminal refund)
  // rolls a fresh epoch. gross accumulates per epoch.
  let epoch = 0, seenCredit = false, terminal = false;
  const grossByEpoch = new Map<number, number>();
  let deposits = 0, transfersOut = 0, refunds = 0, released = 0;
  // Explicit (close-referenced) releases only — the deduction basis for
  // unsettledEarned. IMPLICIT releases (terminalize sweeping UNCLOSED buckets)
  // are part of `released`/payouts but can never touch a closed epoch, so they
  // must never subtract from closed earned (funded-run finding #3, Hermes
  // 2026-08-13: old implicit releases swallowed a fresh close's 78µ —
  // unsettledEarned read 0 and I1 broke by exactly that amount post-close).
  let releasedAgainstClosed = 0;
  let partialRefundsCur = 0;                    // partial (non-terminal) refunds against the CURRENT epoch
  const legCost = new Map<string, { cost: number; epoch: number }>();
  const earnedByEpoch = new Map<number, number>();
  const closedEpochs = new Set<number>();
  const closeByDigest = new Map<string, { carry: number; mode: string }>();
  const carryPending = new Set<string>();
  const countedLegs = new Set<string>();
  // CURRENT-LIFECYCLE SEGMENT (funded-run finding #2, Hermes 2026-08-13): the
  // records since the last terminal event. Current-epoch claims read from THIS,
  // not from an epoch-keyed bucket, so a stamp-vs-counter epoch divergence can
  // never split a lifecycle's credit and its legs across two buckets.
  let segGross = 0;
  const segLegIds = new Set<string>();
  let segHasClose = false;
  const isCarry = (ev: any) => ev && (ev.kind === "carry-credit" || String(ev.chain ?? "") === "internal-carry");
  // Terminalizing an epoch that was NEVER closed resolves its earned to the
  // provider at that moment (Iteration-1 semantics: the exit transfer paid
  // gross − earned; the provider retained earned) — an IMPLICIT release. A
  // CLOSED epoch's earned instead lives in unsettledEarned until an explicit,
  // evidence-bound release (review, Hermes #1).
  const terminalize = () => {
    // Release EVERY unclosed, unreleased earned bucket — not only the bucket at
    // this replay's own epoch counter. Legs key earned by their LEDGER tabEpoch,
    // and on real pre-P2 histories the two numbering schemes diverge (the
    // counter counts every credit-after-terminal; ledger numbering predates the
    // field on old lifecycles) — the sale's earned then strands in a bucket no
    // terminal ever visits and I1 misses it (found live: Bo's ledger, 78µ).
    // P2 epochs are unaffected: they are CLOSED via nsm-close before any
    // terminal, so closedEpochs shields them into unsettledEarned as before.
    for (const [e, amt] of earnedByEpoch) {
      if (!closedEpochs.has(e) && amt > 0 && !implicitReleased.has(e)) { released += amt; implicitReleased.add(e); }
    }
    terminal = true; partialRefundsCur = 0;
    // the current lifecycle ends here; the next credit starts a fresh segment
    segGross = 0; segLegIds.clear(); segHasClose = false;
  };
  const implicitReleased = new Set<number>();
  // AUTHORITATIVE-EPOCH ANCHOR (funded-run finding, Hermes 2026-08-13): the
  // ledger stamps its own epoch onto every credit it applies; that number is
  // the epoch the tab, quote, funded opening, and every leg bind to. This
  // from-scratch counter (kept for per-epoch BUCKETING and conservation, which
  // are correct as-is) can run ahead of it on pre-P2 history written under
  // earlier epoch semantics. We therefore track the ledger's stamp separately
  // and REPORT it — never letting a stamped epoch reindex the buckets (which
  // would collide with a same-numbered counter bucket and break I1).
  let stampedEpoch: number | null = null;
  for (const r of recs) {
    if (r.kind === "credit") {
      if (seenCredit && terminal) { epoch++; terminal = false; partialRefundsCur = 0; }
      if (typeof (r as any).epoch === "number" && Number.isSafeInteger((r as any).epoch)) stampedEpoch = (r as any).epoch;
      seenCredit = true;
      const amt = Number(r.amountMicroTrac ?? 0);
      grossByEpoch.set(epoch, (grossByEpoch.get(epoch) ?? 0) + amt);
      // CURRENT-SEGMENT gross (funded-run finding #2, Hermes 2026-08-13):
      // accumulate the current lifecycle directly — the records since the last
      // terminal event — so current reads never depend on epoch numbering. On
      // stamp-vs-counter-divergent history a bucket lookup put the credit and
      // its legs in different buckets; a segment has no such ambiguity.
      segGross += amt;
      if (!isCarry(r.evidence)) deposits += amt;
      else if ((r as any).evidence?.closeDigest) carryPending.delete(String((r as any).evidence.closeDigest));
    }
    if (r.kind === "settled") {
      const tx = String(r.txHash ?? "");
      if (tx.startsWith("carry:")) carryPending.add(tx.slice("carry:".length));
      else transfersOut += Number(r.netPaidMicroTrac ?? 0);
      terminalize();
    }
    if (r.kind === "refund") {
      refunds += Number(r.amountMicroTrac ?? 0);
      if (r.terminal !== false) terminalize();
      else partialRefundsCur += Number(r.amountMicroTrac ?? 0);
    }
    if (r.kind === "debit") {
      const leg: any = (r as any).leg;
      legCost.set(String(leg.legId), { cost: Number(leg.pricing?.costMicroTrac ?? 0), epoch: Number(leg.tabEpoch ?? r.epoch ?? epoch) });
      if (!terminal) segLegIds.add(String(leg.legId));     // billed in the current segment
    }
    if (r.kind === "leg-countersigned") {
      const id = String(r.legId);
      if (!countedLegs.has(id)) {
        countedLegs.add(id);
        const lc = legCost.get(id);
        if (lc) earnedByEpoch.set(lc.epoch, (earnedByEpoch.get(lc.epoch) ?? 0) + lc.cost);
      }
    }
    if (r.kind === "nsm-close") {
      closedEpochs.add(Number(r.epoch));
      closeByDigest.set(String(r.closeDigest), { carry: Number(r.carryMicroTrac ?? 0), mode: String(r.mode) });
      if (!terminal) segHasClose = true;                   // the current segment is closed-awaiting
    }
    if (r.kind === "nsm-earned-released") {
      // Derive the released value from the CLOSE it references, never the
      // record's own amount field (review, Hermes r5: don't trust a persisted
      // caller value into the liability math).
      const rc = recs.find((x) => x.kind === "nsm-close" && String(x.closeDigest) === String(r.closeDigest));
      const amt = Number(rc?.earnedMicroTrac ?? 0);
      released += amt;
      releasedAgainstClosed += amt;   // explicit releases are ALWAYS against a close
    }
  }
  // CURRENT-epoch claims from the current LIFECYCLE SEGMENT (funded-run finding
  // #2) — never an epoch-keyed bucket, which a stamp-vs-counter divergence can
  // split. grossCur/billedCur/earnedCur are the credits and legs since the last
  // terminal; curClosed is whether that segment carries a close.
  const grossCur = segGross;
  let billedCur = 0, earnedCurRaw = 0;
  for (const id of segLegIds) {
    const lc = legCost.get(id); if (!lc) continue;
    billedCur += lc.cost;
    if (countedLegs.has(id)) earnedCurRaw += lc.cost;
  }
  const curClosed = segHasClose;
  // phase-dependent current-epoch claims (review, Hermes #1):
  //   terminal → 0/0 (the exit records carry the value now)
  //   closed   → earned moved to unsettled; refundable = pending carry
  //   open     → earned live; refundable = gross − earned − partial refunds
  const earnedCur = (terminal || curClosed) ? 0 : earnedCurRaw;
  const refundableCur = terminal ? 0 : Math.max(0, grossCur - earnedCurRaw - (curClosed ? 0 : partialRefundsCur));
  let closedEarned = 0;
  for (const e of closedEpochs) closedEarned += earnedByEpoch.get(e) ?? 0;
  const unsettledEarned = Math.max(0, closedEarned - releasedAgainstClosed);
  let carryInFlight = 0;
  for (const d of carryPending) carryInFlight += closeByDigest.get(d)?.carry ?? 0;
  return {
    // REPORTED epoch = the ledger's authoritative stamp when present (so the
    // projection can never disagree with the tab/quote/leg the close binds);
    // the internal counter above stays the bucket key for conservation.
    epoch: stampedEpoch ?? epoch,
    depositsOnchainMicroTrac: deposits,
    // "payouts" in the identity = value that has LEFT the tab's liabilities:
    // real transfers out + provider's released (kept) earned.
    payoutsMicroTrac: transfersOut + released,
    refundsMicroTrac: refunds,
    grossCurrent: grossCur, billedCurrent: billedCur, earnedCurrent: earnedCur,
    voidedCurrent: Math.max(0, billedCur - earnedCurRaw),
    refundableCurrent: refundableCur,
    unsettledEarned,
    carryInFlightMicroTrac: carryInFlight,
  };
}
// ── I1: the conservation identity, checkable at EVERY replay point (G-I1a) ──
// deposits == payouts + refunds + unsettledEarned + earned(current) + refundable(current) + carryInFlight
export function conservationCheck(home: string, principal: string): { ok: boolean; lhs: number; rhs: number; q: LedgerQuantities } {
  const q = ledgerQuantities(home, principal);
  // Operands must be safe integers AND the comparison is done in BigInt so the
  // summed RHS can never overflow into a lossy compare (review, Hermes #4).
  const vals = [q.depositsOnchainMicroTrac, q.payoutsMicroTrac, q.refundsMicroTrac, q.unsettledEarned, q.earnedCurrent, q.refundableCurrent, q.carryInFlightMicroTrac];
  if (!vals.every(Number.isSafeInteger)) return { ok: false, lhs: -1, rhs: -1, q };
  const lhsB = BigInt(q.depositsOnchainMicroTrac);
  const rhsB = BigInt(q.payoutsMicroTrac) + BigInt(q.refundsMicroTrac) + BigInt(q.unsettledEarned) + BigInt(q.earnedCurrent) + BigInt(q.refundableCurrent) + BigInt(q.carryInFlightMicroTrac);
  return { ok: lhsB === rhsB, lhs: Number(lhsB), rhs: rhsB <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rhsB) : -1, q };
}

// ── I7: the close CAS — exactly ONE countersigned close per epoch ────────────
// PRECONDITION (review, OpenClaw): the daemon process is the journal's SINGLE
// WRITER — the same precondition every Iteration-1 primitive (debit CAS, credit
// dedup) already relies on. The synchronous section is race-safe within that
// writer; multi-process writers would need a storage-level lock, which is out
// of scope for v1 exactly as multi-writer custody is out of scope in the
// frozen spec.
// Buyer-countersigned close commitment: {mode, epoch, earned, carry} signed by
// the buyer session key (verification of that signature reuses the existing
// countersign machinery upstream; this section is the race-safe COMMIT).
export const NSM_CLOSE_DOMAIN = "odysseus-dkg:nsm-close:v1";
export interface CloseCommit {
  principal: string;
  epoch: number;
  mode: "rollover" | "settle";
  earnedMicroTrac: number;
  carryMicroTrac: number;            // MUST equal gross − earned (frozen formula)
  /** Ed25519 signature (base64) over NSM_CLOSE_DOMAIN + "\n" + canonicalize(closeBody). */
  buyerCountersignature: string;
  /** The buyer session public key — VERIFIED HERE (review, Hermes #3: an
   *  exported state mutation is a trust boundary; comments are not). */
  sessionPublicKeyPem: string;
}
export function closeBody(c: Pick<CloseCommit, "principal" | "epoch" | "mode" | "earnedMicroTrac" | "carryMicroTrac">): string {
  return canonicalize({ p: c.principal.toLowerCase(), epoch: c.epoch, mode: c.mode, earned: c.earnedMicroTrac, carry: c.carryMicroTrac });
}
export function commitClose(home: string, c: CloseCommit):
  | { ok: true; closeDigest: string }
  | { ok: false; code: string } {
  // Signature verification FIRST — sync (node:crypto verify), so it lives
  // outside no trust decision: a bad, foreign, or wrongly-bound signature never
  // reaches the CAS. The signing key must be the SAME session key that
  // countersigned this epoch's legs (keyRef match against the epoch's debits),
  // so a foreign-but-valid key cannot close another buyer's epoch.
  let sigOk = false;
  try {
    sigOk = edVerify(null,
      Buffer.concat([Buffer.from(NSM_CLOSE_DOMAIN + "\n"), Buffer.from(closeBody(c))]),
      createPublicKey(c.sessionPublicKeyPem),
      Buffer.from(c.buyerCountersignature, "base64"));
  } catch { sigOk = false; }
  if (!sigOk) return { ok: false, code: "E_CLOSE_BAD_SIGNATURE" };
  const keyRef = "sha256:" + createHash("sha256").update(c.sessionPublicKeyPem).digest("hex");
  // Allowed close keys = ONLY keys that actually COUNTERSIGNED a leg in this
  // epoch (review, Hermes round 6). Prior code drew from every debit — so a key
  // present only on a voided/uncountersigned leg could close another key's
  // earnings, and a no-debit epoch was fail-open to any valid key. We join
  // leg-countersigned records to their debit's requester.keyRef.
  const journal = readJournal(home);
  const legKeyRef = new Map<string, string>();     // legId → requester.keyRef (from debits)
  for (const r of journal) {
    if (r.kind === "debit" && String(r.principal ?? "").toLowerCase() === c.principal.toLowerCase()) {
      const leg: any = (r as any).leg;
      if (leg?.legId && leg?.requester?.keyRef) legKeyRef.set(String(leg.legId), String(leg.requester.keyRef));
    }
  }
  const allowedKeyRefs = new Set<string>();
  for (const r of journal) {
    if (r.kind === "leg-countersigned" && String(r.principal ?? "").toLowerCase() === c.principal.toLowerCase() && Number(r.epoch) === c.epoch) {
      const kr = legKeyRef.get(String(r.legId));
      if (kr) allowedKeyRefs.add(kr);
    }
  }
  // Fail CLOSED for an epoch with no countersigned legs: there is no journaled
  // authorization anchor, so commitClose (the earnings-settling close) does not
  // apply — the buyer's unspent balance exits via the refund path (I4) instead.
  if (allowedKeyRefs.size === 0) return { ok: false, code: "E_CLOSE_NO_COUNTERSIGNED_LEG" };
  if (!allowedKeyRefs.has(keyRef)) return { ok: false, code: "E_CLOSE_FOREIGN_KEY" };
  // ---- SYNCHRONOUS CRITICAL SECTION: no async boundary between check and append ----
  const q = ledgerQuantities(home, c.principal);
  if (c.epoch !== q.epoch) return { ok: false, code: "E_CLOSE_EPOCH_STALE" };
  const already = readJournal(home).some((r) =>
    r.kind === "nsm-close" && String(r.principal ?? "").toLowerCase() === c.principal.toLowerCase() && Number(r.epoch) === c.epoch);
  if (already) return { ok: false, code: "E_CLOSE_EPOCH_TAKEN" };          // I7: loser's carry never enters state
  if (c.earnedMicroTrac !== q.earnedCurrent) return { ok: false, code: "E_CLOSE_EARNED_MISMATCH" };
  if (c.carryMicroTrac !== q.grossCurrent - q.earnedCurrent) return { ok: false, code: "E_CLOSE_CARRY_MISMATCH" }; // I5: carry = gross − earned, only inside the close
  const closeDigest = sha256(canonicalize({ p: c.principal.toLowerCase(), epoch: c.epoch, mode: c.mode, earned: c.earnedMicroTrac, carry: c.carryMicroTrac, sig: c.buyerCountersignature }));
  appendJournal(home, { kind: "nsm-close", principal: c.principal, epoch: c.epoch, mode: c.mode, earnedMicroTrac: c.earnedMicroTrac, carryMicroTrac: c.carryMicroTrac, closeDigest, at: new Date().toISOString() });
  // ---- end critical section ----
  return { ok: true, closeDigest };
}

// ── S3 ROLLED: carry-credit into the next epoch (no on-chain transfer) ───────
export function applyRollover(home: string, principal: string, closeDigest: string):
  | { ok: true; carriedMicroTrac: number; newEpoch: number }
  | { ok: false; code: string } {
  const rec = readJournal(home).find((r) => r.kind === "nsm-close" && String(r.closeDigest) === closeDigest
    && String(r.principal ?? "").toLowerCase() === principal.toLowerCase());
  if (!rec) return { ok: false, code: "E_CLOSE_NOT_FOUND" };
  if (rec.mode !== "rollover") return { ok: false, code: "E_CLOSE_NOT_ROLLOVER" };
  const carry = Number(rec.carryMicroTrac ?? 0);
  if (carry <= 0) return { ok: false, code: "E_NO_CARRY" };
  // Terminalize the closed epoch in the LEDGER (idempotent by withdrawalId) so
  // the carry credit opens a FRESH epoch — a zero-value internal settlement,
  // marked `carry:` so it never counts as a real transfer in the identity.
  const st = settleTab(home, principal, {
    withdrawalId: `rollover:${closeDigest}`, txHash: `carry:${closeDigest}`,
    netPaidMicroTrac: 0, expectedEpoch: Number(rec.epoch),
  });
  if (!st.ok && !st.alreadySettled) return { ok: false, code: st.code ?? "E_ROLLOVER_TERMINALIZE" };
  // Dedup identity makes the carry exactly-once: canonicalDepositId over the
  // internal-carry evidence keys by close digest, so a replayed or raced
  // applyRollover cannot double-credit (I2/I3). The terminalization above used
  // the EXISTING idempotent settleTab path with zero value and a `carry:`
  // marker — the marker is what keeps it out of the identity's paid term.
  try {
    credit(home, principal, carry, {
      kind: "carry-credit", chain: "internal-carry", token: "close",
      tx: `carry:${closeDigest}`, log: String(rec.epoch),
      closeDigest, fromEpoch: rec.epoch,
    });
  } catch (e) {
    return { ok: false, code: String((e as Error).message ?? e).slice(0, 60) };
  }
  const q = ledgerQuantities(home, principal);
  return { ok: true, carriedMicroTrac: carry, newEpoch: q.epoch };
}

// ── S4: settlement election ──────────────────────────────────────────────────
// PROVIDER-elected settlement is threshold-gated (I6, live-derived); the
// BUYER's exit refund is NEVER threshold-gated (I4) — the refund itself rides
// the existing, unchanged refund path.
export function providerMaySettle(home: string, principal: string, feeGweiDecimal: string, ethTracDecimal: string):
  { allowed: boolean; unsettledEarned: number; thresholdMicroTrac: number } {
  const q = ledgerQuantities(home, principal);
  const thresholdMicroTrac = settleThresholdMicroTrac(feeGweiDecimal, ethTracDecimal);
  return { allowed: q.unsettledEarned >= thresholdMicroTrac, unsettledEarned: q.unsettledEarned, thresholdMicroTrac };
}
/** Record the release of closed-epoch earned — keyed by close digest (I2),
 *  BOUND to the close's principal AND to confirmed real payout evidence
 *  (review, Hermes #2: without both bindings this is not a liability-closing
 *  primitive — any caller could append releases under a foreign principal or
 *  without any payout having happened). */
/** STRUCTURAL release authority (review, Hermes wiring v2 #2): the caller must
 *  present the secret from `metering/release-authority.token` — a file only
 *  loopback settlement tooling reads. The HTTP layer never loads it, so a
 *  future dispatcher cannot re-expose release by accident: it would have to
 *  explicitly wire the authority file, which no review would miss. The
 *  whole-tree scan remains as defense in depth, not the boundary. */
export function releaseAuthorityOk(home: string, presented: string | undefined): boolean {
  try {
    const p = pjoin(home, "metering", "release-authority.token");
    if (!exs(p)) return false;                          // no authority provisioned ⇒ nothing can release
    const expected = Buffer.from(rfs(p, "utf8").trim());
    const got = Buffer.from(String(presented ?? "").trim());
    return expected.length > 0 && expected.length === got.length && timingSafeEqual(expected, got);
  } catch { return false; }
}
export function recordEarnedRelease(home: string, principal: string, closeDigest: string, amountMicroTrac: number, payoutTxHash: string, authorityToken?: string):
  { ok: boolean; code?: string } {
  if (!releaseAuthorityOk(home, authorityToken)) return { ok: false, code: "E_RELEASE_AUTHORITY" };
  const recs = readJournal(home);
  const dup = recs.some((r) => r.kind === "nsm-earned-released" && String(r.closeDigest) === closeDigest);
  if (dup) return { ok: false, code: "E_RELEASE_ALREADY_RECORDED" };
  const close = recs.find((r) => r.kind === "nsm-close" && String(r.closeDigest) === closeDigest);
  if (!close) return { ok: false, code: "E_CLOSE_NOT_FOUND" };
  if (String(close.principal ?? "").toLowerCase() !== principal.toLowerCase()) return { ok: false, code: "E_CLOSE_PRINCIPAL_MISMATCH" };
  // Payout evidence must bind to THIS close, not merely the principal (review,
  // Hermes round 3: a real settlement for close A must never authorize the
  // release of close B). The settled record that pays a close REFERENCES it —
  // either `withdrawalId === "close:" + closeDigest` (single-close settlement,
  // and then its netPaid must equal that close's carry) or an explicit
  // `closes: [digest, …]` list (netted settlement covering several closes).
  const payout = recs.find((r) => r.kind === "settled"
    && String(r.principal ?? "").toLowerCase() === principal.toLowerCase()
    && String(r.txHash ?? "") === payoutTxHash && !String(r.txHash ?? "").startsWith("carry:"));
  if (!payout) return { ok: false, code: "E_RELEASE_UNBACKED" };
  const wid = String(payout.withdrawalId ?? "");
  const closesArr: string[] = Array.isArray((payout as any).closes) ? (payout as any).closes.map(String) : [];
  const single = wid === `close:${closeDigest}`;
  const netted = closesArr.includes(closeDigest);
  if (!single && !netted) return { ok: false, code: "E_RELEASE_PAYOUT_UNRELATED" };
  // Amount binding applies to BOTH paths (review, Hermes round 4: the netted
  // path was not amount-bound — an underfunded payout could zero several
  // liabilities). The payout MUST equal the sum of the carries of ALL closes it
  // names, and every named close must exist for THIS principal — so it cannot
  // claim to cover closes it underpays.
  const referenced = single ? [closeDigest] : closesArr;
  let carrySum = 0;
  for (const d of referenced) {
    const rc = recs.find((r) => r.kind === "nsm-close" && String(r.closeDigest) === d
      && String(r.principal ?? "").toLowerCase() === principal.toLowerCase());
    if (!rc) return { ok: false, code: "E_RELEASE_PAYOUT_UNRELATED" };   // names a foreign/absent close
    carrySum += Number(rc.carryMicroTrac ?? 0);
  }
  if (Number(payout.netPaidMicroTrac ?? -1) !== carrySum) return { ok: false, code: "E_RELEASE_PAYOUT_AMOUNT_MISMATCH" };
  const closeEarned = Number(close.earnedMicroTrac ?? 0);
  if (amountMicroTrac !== closeEarned) return { ok: false, code: "E_RELEASE_AMOUNT_MISMATCH" };
  // Persist the CLOSE's own earned, never the caller-supplied value (defense in
  // depth: even a validated caller value is not trusted into `released`).
  // The release BINDS to the settled record's authorizing digest (review,
  // Hermes wiring v3) — never a fresh sample of current config. A payout with
  // no recorded digest cannot back a netting release.
  const payoutDigest = (payout as Record<string, unknown>).economicsConfigDigest;
  if (typeof payoutDigest !== "string" || !payoutDigest.startsWith("sha256:")) {
    return { ok: false, code: "E_RELEASE_PAYOUT_UNBOUND_ECONOMICS" };
  }
  appendJournal(home, { kind: "nsm-earned-released", principal, closeDigest, amountMicroTrac: closeEarned, payoutTxHash, economicsConfigDigest: payoutDigest, at: new Date().toISOString() });
  return { ok: true };
}

/** THE netted-settlement mutation (review, Hermes wiring v3: the binding must
 *  live INSIDE the mutation, not beside it). Verifies the expected economics
 *  digest against the exact config bytes IMMEDIATELY before its first state
 *  change — on mismatch/absence it refuses with ZERO journal writes — then
 *  records the settlement with that exact validated digest as durable evidence.
 *  Requires the same structural release authority as recordEarnedRelease: this
 *  is loopback settlement tooling, never an HTTP surface. */
export function recordNettedSettlement(home: string, args: {
  principal: string; withdrawalId: string; txHash: string; netPaidMicroTrac: number;
  expectedEpoch?: number; closes: string[]; expectedConfigDigest: string; authorityToken?: string;
}): {
  ok: boolean; alreadySettled?: boolean; code?: string; economicsConfigDigest?: string;
  election?: { allowed: boolean; unsettledEarned: number; thresholdMicroTrac: number }; closeDigest?: string; expectedSumMicroTrac?: number;
  /** on E_SETTLE_REPLAY_MISMATCH: which fingerprint fields differed (deterministic conflict). */
  conflict?: string[];
} {
  if (!releaseAuthorityOk(home, args.authorityToken)) return { ok: false, code: "E_RELEASE_AUTHORITY" };
  // Replay short-circuit BEFORE the election (Hermes wiring v4.2): re-recording
  // an already-recorded settlement is benign recovery — the election was
  // enforced when it first executed, and would legitimately fail afterwards
  // because settling drains unsettledEarned. Only the SAME withdrawalId
  // short-circuits; a different one proceeds into the full checks.
  const prior = settlementOf(home, args.principal);
  if (prior && prior.withdrawalId === args.withdrawalId) {
    // REQUEST-IDENTITY binding (Hermes v4.3, OpenClaw v4.3): idempotent
    // success means THE SAME OPERATION, not merely the same idempotency key.
    // The persisted settled record already carries the full canonical
    // fingerprint — withdrawal id, principal (settlementOf is per-principal,
    // so a foreign principal's identical wid never reaches this branch),
    // payout binding (txHash), amount, NORMALIZED close set (append-only close
    // records make closes-identity ⇒ carries-identity), and the authorizing
    // economics digest. Any mismatch is a deterministic conflict: zero writes,
    // no release attempt, and the differing fields named.
    const norm = (a: unknown) => (Array.isArray(a) ? [...a].map(String).sort() : null);
    const pc = norm(prior.closes), ac = norm(args.closes);
    const conflict: string[] = [];
    if (prior.txHash !== args.txHash) conflict.push("txHash");
    if (prior.netPaidMicroTrac !== args.netPaidMicroTrac) conflict.push("netPaidMicroTrac");
    if (!pc || !ac || pc.length !== ac.length || pc.some((d, i) => d !== ac[i])) conflict.push("closes");
    if (prior.economicsConfigDigest !== args.expectedConfigDigest) conflict.push("economicsConfigDigest");
    if (conflict.length > 0) return { ok: false, code: "E_SETTLE_REPLAY_MISMATCH", conflict };
    return { ok: true, alreadySettled: true, economicsConfigDigest: prior.economicsConfigDigest };
  }
  // economics binding — before any state change, zero writes on refusal
  const bind = assertEconomicsUnchanged(home, args.expectedConfigDigest);
  if (!bind.ok) return { ok: false, code: bind.code };
  // EXECUTION-TIME provider election (Hermes wiring v4.2): recomputed here,
  // atomically, from the SAME validated snapshot the digest just bound — an
  // "allowed" verdict is advisory; only this recheck settles. Liability drift
  // between verdict and execution (a release landing in the gap) refuses even
  // when the config bytes never changed.
  const election = providerMaySettle(home, args.principal, bind.feeGweiDecimal, bind.ethTracDecimal);
  if (!election.allowed) return { ok: false, code: "E_SETTLE_ELECTION_REFUSED", election };
  // The named closes must be real, this principal's, and account EXACTLY for
  // the payout — the same bindings the release primitive re-checks later,
  // enforced here so an invalid settlement never journals in the first place.
  if (!Array.isArray(args.closes) || args.closes.length === 0) return { ok: false, code: "E_SETTLE_CLOSES_INVALID" };
  const recs = readJournal(home);
  let carrySum = 0;
  const seenCloses = new Set<string>();
  for (const cd of args.closes) {
    // STRICT UNIQUENESS (Hermes v4.4): closes is a SET, not a multiset — a
    // duplicated digest would add the same close's carry once per occurrence,
    // letting [A,A] with netPaid = 2×carry(A) pass the amount check and
    // persist a payout claiming the same close twice. Refuse, don't dedup:
    // a caller presenting duplicates is confused about its own evidence.
    if (seenCloses.has(cd)) return { ok: false, code: "E_SETTLE_CLOSES_INVALID", closeDigest: cd };
    seenCloses.add(cd);
    const close = recs.find((r) => r.kind === "nsm-close" && String(r.closeDigest) === cd);
    if (!close || String(close.principal ?? "").toLowerCase() !== args.principal.toLowerCase()) {
      return { ok: false, code: "E_SETTLE_CLOSES_INVALID", closeDigest: cd };
    }
    carrySum += Number(close.carryMicroTrac ?? 0);
  }
  if (carrySum !== args.netPaidMicroTrac) return { ok: false, code: "E_SETTLE_AMOUNT_MISMATCH", expectedSumMicroTrac: carrySum };
  const st = settleTab(home, args.principal, {
    withdrawalId: args.withdrawalId, txHash: args.txHash, netPaidMicroTrac: args.netPaidMicroTrac,
    expectedEpoch: args.expectedEpoch, economicsConfigDigest: bind.configDigest, closes: args.closes,
  });
  if (!st.ok) return { ok: false, code: st.code };
  return { ok: true, alreadySettled: st.alreadySettled, economicsConfigDigest: bind.configDigest };
}

/** Digest of the CURRENT economics config bytes (null if absent/invalid). */
export function currentEconomicsDigest(home: string): string | null {
  try {
    const p = pjoin(home, "metering", "netting-economics.json");
    if (!exs(p)) return null;
    return "sha256:" + createHash("sha256").update(rfs(p, "utf8")).digest("hex");
  } catch { return null; }
}
/** EXECUTION-TIME economics binding (review, Hermes wiring v2 #1): a settlement
 *  acting on an earlier settle-gate verdict presents the verdict's configDigest;
 *  this re-reads the exact bytes NOW and refuses if they changed — verdict-A/
 *  execute-after-config-B is impossible, and the match is what the release
 *  record then durably carries. */
export function assertEconomicsUnchanged(home: string, expectedConfigDigest: string):
  { ok: true; configDigest: string; feeGweiDecimal: string; ethTracDecimal: string } | { ok: false; code: string; currentDigest: string | null } {
  // VALIDATE before digesting (wiring v4): bytes that don't parse into a
  // schema-valid, frozen-grammar economics record are treated as ABSENT — a
  // digest over malformed bytes must never be able to authorize a settlement,
  // even if the caller's expected digest was computed over those same bytes.
  // On success the PARSED snapshot is returned alongside the digest, so the
  // execution-time election recomputes from the exact bytes the digest bound.
  let raw: string;
  let fee: string, rate: string;
  try {
    const p = pjoin(home, "metering", "netting-economics.json");
    if (!exs(p)) return { ok: false, code: "E_ECONOMICS_ABSENT", currentDigest: null };
    raw = rfs(p, "utf8");
    const cfg = JSON.parse(raw);
    fee = String(cfg.feeGweiDecimal); rate = String(cfg.ethTracDecimal);
    decToRational(fee);
    decToRational(rate);
    if (typeof cfg.recordedAt !== "string" || Number.isNaN(Date.parse(cfg.recordedAt))) throw new Error("recordedAt");
    if (typeof cfg.source !== "string" || cfg.source.trim().length === 0) throw new Error("source");
  } catch { return { ok: false, code: "E_ECONOMICS_ABSENT", currentDigest: null }; }
  const now = "sha256:" + createHash("sha256").update(raw).digest("hex");
  if (now !== expectedConfigDigest) return { ok: false, code: "E_ECONOMICS_CHANGED", currentDigest: now };
  return { ok: true, configDigest: now, feeGweiDecimal: fee, ethTracDecimal: rate };
}
