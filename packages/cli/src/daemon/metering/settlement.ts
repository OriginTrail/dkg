// V2-B5 — settlement & withdrawal.
//
// Design ratified 2026-08-07 after Hermes/Bo corrected all four edges of the
// Prime baseline. Each rule below traces to one of those corrections:
//
//  Q1  ONE net payout: `depositCredit − acceptedCost − fee`, provider is the
//      on-chain sender. No two-transaction netting; the accepted cost simply
//      stays at the provider address. A fee is deductible ONLY if the terms
//      fixed a rule/cap and the buyer signs the exact net.
//  Q2  Completeness needs a close-SEQUENCE boundary, not just a leg list. A
//      list proves the sum; only the boundary proves no leg was omitted or
//      injected. The close statement commits the full ordered leg-status set.
//  Q3  A disputed leg is void-and-unsettled, its reserved value returned, the
//      capability frozen — never silently converted into buyer debt. (Gradual
//      release is the ENFORCEMENT-time defence and lives in the read path;
//      here we only settle what was actually countersigned.)
//  Q4  Withdrawal is a prepared→signed→confirmed state machine, journalled and
//      fsync'd before each irreversible step, idempotent under a semantic
//      withdrawalId (NOT the tx nonce — a fee-bumped replacement keeps the
//      nonce), and `confirmed` only when a receipt's decoded effect matches the
//      statement. Replay derives state from journal + chain, never from live
//      balance arithmetic.
import { createHash } from "node:crypto";
import {
  canonicalize, providerPublicPem, providerSign, readJournal, appendJournal, settleTab,
} from "./ledger.js";
import { createPublicKey, verify as edVerify } from "node:crypto";

export const CLOSE_DOMAIN = "odysseus-dkg:close-statement:v1";
export const WITHDRAWAL_DOMAIN = "odysseus-dkg:withdrawal:v1";
const sha256 = (b: string) => createHash("sha256").update(b).digest("hex");

/** One leg as it appears in a close statement — the buyer already holds these. */
export interface CloseLeg {
  legHash: string;              // sha256 of the canonical signed leg
  sequence: number;             // tab sequence
  previousLegHash: string;      // hash-chain link
  costMicroTrac: number;        // integer
  status: "accepted" | "disputed" | "void";
  /** Present iff status === "accepted": the buyer's countersignature. */
  countersignature?: string;
}

export interface CloseStatement {
  domain: typeof CLOSE_DOMAIN;
  statementVersion: "close/v1";
  chain: string;                // eip155:8453
  tracContract: string;
  providerAddress: string;
  tabPrincipal: string;
  tabEpoch: string;             // opening artifact's expiresAt or a tab id
  priorDeposit: { txHash: string; blockNumber: number; amountMicroTrac: number };
  /** The completeness boundary: the last sequence this statement accounts for.
   *  A verifier rejects any statement whose leg sequences are not exactly
   *  1..closeSequence with no gaps and no extras. This is what a bare list or a
   *  Merkle root cannot give you. (Q2, buyer-found.) */
  closeSequence: number;
  legs: CloseLeg[];             // ordered by sequence, EVERY sequence present
  acceptedCostMicroTrac: number;
  grossRefundMicroTrac: number; // depositCredit − acceptedCost
  feeMicroTrac: number;         // 0 unless terms fixed a fee AND buyer signs net
  netPayoutMicroTrac: number;   // grossRefund − fee, what the buyer receives
  destination: string;          // locked refund address
  withdrawalId: string;         // stable id, the settlement idempotency key
}

/** Build and provider-sign the close statement. Provider asserts; buyer checks. */
export function buildCloseStatement(home: string, args: {
  chain: string; tracContract: string; providerAddress: string;
  tabPrincipal: string; tabEpoch: string;
  priorDeposit: { txHash: string; blockNumber: number; amountMicroTrac: number };
  legs: CloseLeg[];
  feeMicroTrac?: number;
  destination: string;
}): { statement: CloseStatement; digest: string; providerSignature: string } {
  const legs = [...args.legs].sort((a, b) => a.sequence - b.sequence);
  const closeSequence = legs.length ? legs[legs.length - 1].sequence : 0;
  const acceptedCost = legs
    .filter((l) => l.status === "accepted")
    .reduce((s, l) => s + l.costMicroTrac, 0);
  const deposit = args.priorDeposit.amountMicroTrac;
  const grossRefund = Math.max(0, deposit - acceptedCost);
  const fee = args.feeMicroTrac ?? 0;
  const net = Math.max(0, grossRefund - fee);

  const statement: CloseStatement = {
    domain: CLOSE_DOMAIN,
    statementVersion: "close/v1",
    chain: args.chain,
    tracContract: args.tracContract,
    providerAddress: args.providerAddress,
    tabPrincipal: args.tabPrincipal,
    tabEpoch: args.tabEpoch,
    priorDeposit: args.priorDeposit,
    closeSequence,
    legs,
    acceptedCostMicroTrac: acceptedCost,
    grossRefundMicroTrac: grossRefund,
    feeMicroTrac: fee,
    netPayoutMicroTrac: net,
    destination: args.destination,
    // The withdrawal id binds THIS statement: change any field, change the id.
    withdrawalId: "wd:" + sha256(canonicalize({ ...args, legs, closeSequence, acceptedCost, grossRefund, fee, net })).slice(0, 32),
  };
  const digest = "sha256:" + sha256(canonicalize(statement as unknown as Record<string, unknown>));
  const providerSignature = providerSign(home, CLOSE_DOMAIN, digest.slice(7));
  return { statement, digest, providerSignature };
}

export type CloseVerdict =
  | { ok: true; netPayoutMicroTrac: number; withdrawalId: string; digest: string }
  | { ok: false; code: CloseCode; detail?: string };

export type CloseCode =
  | "E_CLOSE_BAD_PROVIDER_SIG"
  | "E_CLOSE_SEQUENCE_GAP"
  | "E_CLOSE_SET_MISMATCH"
  | "E_CLOSE_COUNTERSIG_MISSING"
  | "E_CLOSE_COUNTERSIG_BAD"
  | "E_CLOSE_ARITHMETIC"
  | "E_CLOSE_FEE_UNAGREED"
  | "E_CLOSE_DEST_MISMATCH";

/**
 * The BUYER's verification. Trusts nothing the provider computed: it recomputes
 * the sums, re-derives the accepted set from the buyer's OWN countersigned legs,
 * checks the close-sequence boundary for completeness, and verifies the
 * provider signature. This function is what makes the withdrawal figure
 * provable rather than asserted (Q2).
 */
export function verifyCloseStatement(args: {
  home?: string;                       // provider home, to fetch provider pubkey
  providerPublicPem?: string;          // or supply it directly (buyer side)
  statement: CloseStatement;
  providerSignature: string;
  /** The set the buyer countersigned, as legHash → true. The buyer's ground truth. */
  buyerCountersigned: Set<string>;
  /** Verify each accepted leg's countersignature under this session key. */
  sessionPublicKeyPem: string;
  expectedDestination: string;
  /** A fee is only acceptable if the buyer agreed a cap here; default 0 = none. */
  agreedFeeCapMicroTrac?: number;
}): CloseVerdict {
  const s = args.statement;
  const pub = args.providerPublicPem ?? (args.home ? providerPublicPem(args.home) : undefined);
  if (!pub) return { ok: false, code: "E_CLOSE_BAD_PROVIDER_SIG", detail: "no provider public key" };

  // 1. Provider signature over the exact statement.
  const digest = "sha256:" + sha256(canonicalize(s as unknown as Record<string, unknown>));
  try {
    const ok = edVerify(null, Buffer.concat([Buffer.from(CLOSE_DOMAIN + "\n"), Buffer.from(digest.slice(7))]),
      createPublicKey(pub), Buffer.from(args.providerSignature, "base64"));
    if (!ok) return { ok: false, code: "E_CLOSE_BAD_PROVIDER_SIG" };
  } catch { return { ok: false, code: "E_CLOSE_BAD_PROVIDER_SIG" }; }

  // 2. Completeness: sequences must be exactly 1..closeSequence, no gaps/extras.
  const seqs = s.legs.map((l) => l.sequence).sort((a, b) => a - b);
  for (let i = 0; i < seqs.length; i++) {
    if (seqs[i] !== i + 1) return { ok: false, code: "E_CLOSE_SEQUENCE_GAP", detail: `expected ${i + 1}, saw ${seqs[i]}` };
  }
  if (seqs.length !== s.closeSequence) {
    return { ok: false, code: "E_CLOSE_SEQUENCE_GAP", detail: `${seqs.length} legs but closeSequence ${s.closeSequence}` };
  }

  // 3. The accepted set must equal the buyer's OWN countersigned set. Not the
  //    provider's claim of what the buyer signed — the buyer's record.
  const providerAccepted = new Set(s.legs.filter((l) => l.status === "accepted").map((l) => l.legHash));
  if (providerAccepted.size !== args.buyerCountersigned.size) {
    return { ok: false, code: "E_CLOSE_SET_MISMATCH", detail: `provider accepted ${providerAccepted.size}, buyer signed ${args.buyerCountersigned.size}` };
  }
  for (const h of providerAccepted) {
    if (!args.buyerCountersigned.has(h)) return { ok: false, code: "E_CLOSE_SET_MISMATCH", detail: `accepted leg ${h.slice(0, 12)} not in buyer's set` };
  }

  // 4. Every accepted leg carries a countersignature that verifies.
  for (const l of s.legs) {
    if (l.status !== "accepted") continue;
    if (!l.countersignature) return { ok: false, code: "E_CLOSE_COUNTERSIG_MISSING", detail: l.legHash.slice(0, 12) };
    try {
      const ok = edVerify(null, Buffer.concat([Buffer.from("odysseus-dkg:capability:v1\n"), Buffer.from("sha256:" + l.legHash)]),
        createPublicKey(args.sessionPublicKeyPem), Buffer.from(l.countersignature, "base64"));
      if (!ok) return { ok: false, code: "E_CLOSE_COUNTERSIG_BAD", detail: l.legHash.slice(0, 12) };
    } catch { return { ok: false, code: "E_CLOSE_COUNTERSIG_BAD", detail: l.legHash.slice(0, 12) }; }
  }

  // 5. Recompute every number. The buyer does the arithmetic, not the provider.
  const acceptedCost = s.legs.filter((l) => l.status === "accepted").reduce((sum, l) => sum + l.costMicroTrac, 0);
  if (acceptedCost !== s.acceptedCostMicroTrac) return { ok: false, code: "E_CLOSE_ARITHMETIC", detail: `acceptedCost ${acceptedCost} vs ${s.acceptedCostMicroTrac}` };
  const grossRefund = Math.max(0, s.priorDeposit.amountMicroTrac - acceptedCost);
  if (grossRefund !== s.grossRefundMicroTrac) return { ok: false, code: "E_CLOSE_ARITHMETIC", detail: "grossRefund" };
  // 6. A fee is only acceptable up to a cap the buyer agreed. Default: none.
  const cap = args.agreedFeeCapMicroTrac ?? 0;
  if (s.feeMicroTrac > cap) return { ok: false, code: "E_CLOSE_FEE_UNAGREED", detail: `fee ${s.feeMicroTrac} > agreed cap ${cap}` };
  const net = Math.max(0, grossRefund - s.feeMicroTrac);
  if (net !== s.netPayoutMicroTrac) return { ok: false, code: "E_CLOSE_ARITHMETIC", detail: "netPayout" };

  // 7. The money must go where the buyer expects — the locked refund address.
  if (s.destination.toLowerCase() !== args.expectedDestination.toLowerCase()) {
    return { ok: false, code: "E_CLOSE_DEST_MISMATCH" };
  }

  return { ok: true, netPayoutMicroTrac: net, withdrawalId: s.withdrawalId, digest };
}

// ── Q4: the withdrawal state machine ─────────────────────────────────────────

export type WithdrawalPhase = "prepared" | "signed" | "confirmed";

export interface WithdrawalState {
  withdrawalId: string;
  phase: WithdrawalPhase;
  statementDigest: string;
  amountMicroTrac: number;
  destination: string;
  tabPrincipal?: string;
  chainId: number;
  sender?: string;
  accountNonce?: number;
  txHash?: string;
  confirmedTxHash?: string;      // may differ from txHash: a fee-bumped replacement
}

/** Reconstruct every withdrawal's phase from the journal alone. Never from a
 *  live balance — that is the exact mistake (replay-ignores-refunds) that let a
 *  refunded balance resurrect. State is journal + chain, full stop. */
export function replayWithdrawals(home: string): Map<string, WithdrawalState> {
  const m = new Map<string, WithdrawalState>();
  for (const rec of readJournal(home)) {
    if (rec.kind !== "withdrawal") continue;
    const id = String(rec.withdrawalId);
    const prev = m.get(id);
    const next: WithdrawalState = {
      withdrawalId: id,
      phase: rec.phase as WithdrawalPhase,
      statementDigest: String(rec.statementDigest ?? prev?.statementDigest ?? ""),
      amountMicroTrac: Number(rec.amountMicroTrac ?? prev?.amountMicroTrac ?? 0),
      destination: String(rec.destination ?? prev?.destination ?? ""),
      tabPrincipal: (rec.tabPrincipal as string) ?? prev?.tabPrincipal,
      chainId: Number(rec.chainId ?? prev?.chainId ?? 0),
      sender: (rec.sender as string) ?? prev?.sender,
      accountNonce: rec.accountNonce !== undefined ? Number(rec.accountNonce) : prev?.accountNonce,
      txHash: (rec.txHash as string) ?? prev?.txHash,
      confirmedTxHash: (rec.confirmedTxHash as string) ?? prev?.confirmedTxHash,
    };
    // Phase only advances. A late 'prepared' record can never demote a
    // 'confirmed' withdrawal — replay ordering must not lose a settlement.
    const rank = { prepared: 0, signed: 1, confirmed: 2 } as const;
    if (prev && rank[next.phase] < rank[prev.phase]) { next.phase = prev.phase; }
    m.set(id, next);
  }
  return m;
}

/** CAS-guarded prepare: refuses to open a second withdrawal for the same id. */
export function prepareWithdrawal(home: string, args: {
  withdrawalId: string; statementDigest: string; amountMicroTrac: number;
  destination: string; chainId: number; tabPrincipal?: string;
}): { ok: boolean; code?: string; state?: WithdrawalState } {
  const existing = replayWithdrawals(home).get(args.withdrawalId);
  if (existing) {
    // Idempotent: preparing an already-known withdrawal returns its state
    // rather than creating a duplicate. Keyed by withdrawalId, NOT the nonce.
    return { ok: true, code: "E_WD_ALREADY_EXISTS", state: existing };
  }
  appendJournal(home, {
    kind: "withdrawal", phase: "prepared",
    withdrawalId: args.withdrawalId, statementDigest: args.statementDigest,
    amountMicroTrac: args.amountMicroTrac, destination: args.destination,
    tabPrincipal: args.tabPrincipal ?? args.destination, chainId: args.chainId,
    at: new Date().toISOString(),
  });
  return { ok: true, state: replayWithdrawals(home).get(args.withdrawalId) };
}

/** Record the signed tx BEFORE broadcast, so a crash after broadcast is
 *  recoverable by rebroadcasting the exact bytes. */
export function recordSignedWithdrawal(home: string, args: {
  withdrawalId: string; sender: string; accountNonce: number; txHash: string;
}): { ok: boolean; code?: string } {
  const st = replayWithdrawals(home).get(args.withdrawalId);
  if (!st) return { ok: false, code: "E_WD_NOT_PREPARED" };
  if (st.phase === "confirmed") return { ok: true, code: "E_WD_ALREADY_CONFIRMED" };
  appendJournal(home, {
    kind: "withdrawal", phase: "signed",
    withdrawalId: args.withdrawalId, sender: args.sender,
    accountNonce: args.accountNonce, txHash: args.txHash, at: new Date().toISOString(),
  });
  return { ok: true };
}

/**
 * Confirm ONLY on a receipt whose decoded effect matches the statement. A
 * fee-bumped replacement is accepted iff it pays the same amount to the same
 * destination — its hash may differ from the signed txHash, which is exactly
 * why the nonce alone could never be the idempotency key (Q4).
 */
export function confirmWithdrawal(home: string, args: {
  withdrawalId: string;
  receipt: { txHash: string; to: string; amountMicroTrac: number; success: boolean; confirmations: number };
  requiredConfirmations: number;
}): { ok: boolean; code: string } {
  const st = replayWithdrawals(home).get(args.withdrawalId);
  if (!st) return { ok: false, code: "E_WD_NOT_PREPARED" };
  if (st.phase === "confirmed") return { ok: true, code: "E_WD_ALREADY_CONFIRMED" };
  const r = args.receipt;
  if (!r.success) return { ok: false, code: "E_WD_TX_FAILED" };
  if (r.confirmations < args.requiredConfirmations) return { ok: false, code: "E_WD_UNCONFIRMED" };
  if (r.to.toLowerCase() !== st.destination.toLowerCase()) return { ok: false, code: "E_WD_DEST_MISMATCH" };
  if (r.amountMicroTrac !== st.amountMicroTrac) return { ok: false, code: "E_WD_AMOUNT_MISMATCH" };
  appendJournal(home, {
    kind: "withdrawal", phase: "confirmed",
    withdrawalId: args.withdrawalId, confirmedTxHash: r.txHash, at: new Date().toISOString(),
  });
  // Reconcile the tab: a confirmed payout settles the tab so it shows no
  // residual claim and can never be double-refunded (buyer-found, Bo).
  const principal = st.tabPrincipal ?? st.destination;
  if (principal) settleTab(home, principal, { withdrawalId: args.withdrawalId, txHash: r.txHash, netPaidMicroTrac: st.amountMicroTrac });
  return { ok: true, code: "OK" };
}
