// V2-B3 — TRAC deposit rail.
//
// Built to the BUYER-SET terms (decision KA `d10-tab-terms`, Hermes/Bo,
// accepted 2026-08-06). These are not defaults chosen by the party that
// benefits from the deposit; they are the bounds set by the party that
// carries the loss:
//
//   1. credit only after CONFIRMATION_DEPTH confirmations observed at the
//      SAFE HEAD — never on a tx receipt alone, never on a mempool sighting;
//   2. minimum initial credit (small on purpose — bounded exposure);
//   3. tab expiry with automatic refund semantics and NO silent rollover;
//   4. refund address LOCKED at tab creation and echoed in the opening
//      artifact, so it cannot be reassigned later;
//   5. the opening artifact carries a TERMS DIGEST, so the buyer's
//      countersignature covers the terms actually agreed (D14 + D10).
//
// Zero new contracts: a deposit is a plain TRAC transfer; settlement is an
// aggregate withdrawal. The journal remains the ledger.
import { createHash } from "node:crypto";
import { canonicalize, credit, balance } from "./ledger.js";

export const TERMS_VERSION = "tab-terms/v1";

export interface TabTerms {
  termsVersion: string;
  chain: string;                    // e.g. "base:8453"
  tracContract: string;
  providerAddress: string;          // deposits are sent here
  refundAddress: string;            // (4) LOCKED at creation
  confirmationDepth: number;        // (1) safe-head depth
  minimumCreditTrac: string;        // (2) decimal string, exact
  expiryMs: number;                 // (3)
  rolloverPolicy: "none";           // (3) no silent rollover — explicit
  refundOnExpiry: true;
  askMicroPer1k: number;
  scheduleVersion: string;
}

export const termsDigest = (t: TabTerms) => "sha256:" + createHash("sha256").update(canonicalize(t as unknown as Record<string, unknown>)).digest("hex");

/** The artifact both sides sign at tab creation. Echoes the locked refund address. */
export interface OpeningArtifact {
  artifactType: "tab-opening";
  tabPrincipal: string;
  terms: TabTerms;
  termsDigest: string;
  refundAddressEcho: string;        // (4) echoed, must equal terms.refundAddress
  createdAt: string;
  expiresAt: string;
}

export function buildOpeningArtifact(tabPrincipal: string, terms: TabTerms, now = Date.now()): OpeningArtifact {
  if (terms.rolloverPolicy !== "none") throw new Error("E_TERMS_ROLLOVER_NOT_ALLOWED");
  return {
    artifactType: "tab-opening",
    tabPrincipal,
    terms,
    termsDigest: termsDigest(terms),
    refundAddressEcho: terms.refundAddress,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + terms.expiryMs).toISOString(),
  };
}

export type DepositVerdict =
  | { ok: true; creditMicroTrac: number }
  | { ok: false; code: "E_DEPOSIT_UNCONFIRMED" | "E_DEPOSIT_BELOW_MINIMUM" | "E_DEPOSIT_WRONG_RECIPIENT" | "E_DEPOSIT_WRONG_TOKEN" | "E_DEPOSIT_WRONG_SENDER" | "E_TAB_EXPIRED"; detail?: string };

export interface ObservedTransfer {
  txHash: string;
  from: string;
  to: string;
  token: string;
  amountTrac: string;        // decimal string as read from the chain
  blockNumber: number;
  safeHeadBlock: number;     // (1) the node's observed SAFE head, not latest
}

const toMicro = (trac: string) => {
  const [i, f = ""] = String(trac).split(".");
  return Number(i) * 1_000_000 + Number((f + "000000").slice(0, 6));
};

/**
 * Decide whether an observed transfer may be credited. Pure and total: every
 * rejection is a stable code, and nothing is credited on a maybe.
 */
export function evaluateDeposit(t: ObservedTransfer, artifact: OpeningArtifact, now = Date.now()): DepositVerdict {
  const terms = artifact.terms;
  if (now > Date.parse(artifact.expiresAt)) return { ok: false, code: "E_TAB_EXPIRED" };
  if (t.to.toLowerCase() !== terms.providerAddress.toLowerCase()) return { ok: false, code: "E_DEPOSIT_WRONG_RECIPIENT" };
  if (t.token.toLowerCase() !== terms.tracContract.toLowerCase()) return { ok: false, code: "E_DEPOSIT_WRONG_TOKEN" };
  // The depositing wallet IS the tab identity; a stranger cannot fund someone
  // else's tab and thereby bind their refund address.
  if (t.from.toLowerCase() !== artifact.tabPrincipal.toLowerCase()) return { ok: false, code: "E_DEPOSIT_WRONG_SENDER" };
  const confirmations = t.safeHeadBlock - t.blockNumber + 1;
  if (confirmations < terms.confirmationDepth) {
    return { ok: false, code: "E_DEPOSIT_UNCONFIRMED", detail: `${Math.max(0, confirmations)}/${terms.confirmationDepth} at safe head` };
  }
  const micro = toMicro(t.amountTrac);
  if (micro < toMicro(terms.minimumCreditTrac)) return { ok: false, code: "E_DEPOSIT_BELOW_MINIMUM" };
  return { ok: true, creditMicroTrac: micro };
}

/** Credit an accepted deposit, recording the full evidence chain. */
export function creditDeposit(home: string, t: ObservedTransfer, artifact: OpeningArtifact, verdict: Extract<DepositVerdict, { ok: true }>) {
  return credit(home, artifact.tabPrincipal, verdict.creditMicroTrac, {
    kind: "trac-deposit",
    txHash: t.txHash,
    from: t.from,
    to: t.to,
    token: t.token,
    amountTrac: t.amountTrac,
    blockNumber: t.blockNumber,
    safeHeadBlock: t.safeHeadBlock,
    confirmations: t.safeHeadBlock - t.blockNumber + 1,
    termsDigest: artifact.termsDigest,
    refundAddress: artifact.terms.refundAddress,   // (4) travels with the credit
  });
}

export interface ExpiryOutcome {
  expired: boolean;
  refundMicroTrac: number;
  refundAddress: string;
  earnedMicroTrac: number;
  rollover: "none";
}

/**
 * (3) Expiry is a first-class state: unspent balance is refundable to the
 * LOCKED address, earned-but-unsettled remains payable to the provider, and
 * nothing rolls over silently.
 */
export function evaluateExpiry(home: string, artifact: OpeningArtifact, creditedMicroTrac: number, now = Date.now()): ExpiryOutcome {
  const expired = now > Date.parse(artifact.expiresAt);
  const b = balance(home, artifact.tabPrincipal);
  return {
    expired,
    refundMicroTrac: expired ? Math.max(0, b.balance) : 0,
    refundAddress: artifact.terms.refundAddress,
    earnedMicroTrac: Math.max(0, creditedMicroTrac - b.balance),
    rollover: "none",
  };
}

// ── Bo's amendment (2026-08-06): expiry must be ENFORCED, IDEMPOTENT and
// OBSERVABLE — "no debit path after expiry; any later payment requires a new
// tab and digest". The pure evaluator above was not enough: the ledger had no
// notion of expiry, so a read could still debit a dead tab. These two
// functions close that.

/** Registry of live tab openings, keyed by principal, per DKG_HOME. */
const openingsByHome = new Map<string, Map<string, OpeningArtifact>>();

export function registerOpening(home: string, artifact: OpeningArtifact) {
  if (!openingsByHome.has(home)) openingsByHome.set(home, new Map());
  openingsByHome.get(home)!.set(artifact.tabPrincipal.toLowerCase(), artifact);
  return artifact;
}

export function activeOpening(home: string, principal: string): OpeningArtifact | undefined {
  return openingsByHome.get(home)?.get(String(principal).toLowerCase());
}

/**
 * Debit gate: called before any charge. Returns a stable code when the tab is
 * expired or absent so the caller can refuse service rather than bill a dead
 * tab. Any later payment requires a NEW tab + digest (Bo).
 */
export function debitAllowed(home: string, principal: string, now = Date.now()):
  { ok: true; artifact: OpeningArtifact } | { ok: false; code: "E_TAB_EXPIRED" | "E_NO_OPEN_TAB" } {
  const a = activeOpening(home, principal);
  if (!a) return { ok: false, code: "E_NO_OPEN_TAB" };
  if (now > Date.parse(a.expiresAt)) return { ok: false, code: "E_TAB_EXPIRED" };
  return { ok: true, artifact: a };
}
