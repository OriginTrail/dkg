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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { canonicalize, credit, creditFunded, balance, refundOnExpiry, providerPublicPem, providerKeyId, type CreditFundedResult } from "./ledger.js";
import { verifyFundedRunQuote, type FundedRunQuote } from "./inference-quote.js";
import { COEFFICIENTS_CANONICAL } from "./read-meter.js";

/** The signed provider commitment carried in a funded opening (Bo, block #1):
 *  the quote, the provider signature over its digest, and which provider key
 *  signed it. The whole thing is inside the artifact the buyer countersigns. */
export interface FundedQuoteCommitment {
  quote: FundedRunQuote;
  signature: string;      // provider signature over FUNDED_RUN_QUOTE_DOMAIN + digest
  providerKeyId: string;  // the provider key that signed it (must be the node's)
}

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
  // For a FUNDED INFERENCE RUN (Bo, deposit-stage + funded-run blocks): the
  // signed funded-run quote — the quote, its provider SIGNATURE, and the signing
  // key id — is embedded in the opening the buyer countersigns, so the deposit,
  // the opening, the provider commitment, and the run envelope are ONE bound,
  // countersigned object. The credit CAS binds to the quote's tabEpoch +
  // fundedRunTermsDigest, and both openTab and credit verify the signature
  // against the node's pinned provider key.
  funded?: FundedQuoteCommitment;
  createdAt: string;
  expiresAt: string;
}

export function buildOpeningArtifact(tabPrincipal: string, terms: TabTerms, now = Date.now(), funded?: FundedQuoteCommitment): OpeningArtifact {
  if (terms.rolloverPolicy !== "none") throw new Error("E_TERMS_ROLLOVER_NOT_ALLOWED");
  return {
    artifactType: "tab-opening",
    tabPrincipal,
    terms,
    termsDigest: termsDigest(terms),
    refundAddressEcho: terms.refundAddress,
    ...(funded ? { funded } : {}),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + terms.expiryMs).toISOString(),
  };
}

/** Verify a funded quote commitment against the node's PINNED provider key
 *  (Bo, block #1): the signing key id must be the node's own, and the signature
 *  must verify — a self-signed or foreign-key quote is refused. Shared by
 *  openTab (before registration) and creditFundedDeposit (before credit) so the
 *  same authority check gates both. */
export function verifyFundedCommitment(home: string, c: FundedQuoteCommitment | undefined):
  { ok: true; quote: FundedRunQuote } | { ok: false; code: "E_NO_FUNDED_QUOTE" | "E_QUOTE_WRONG_PROVIDER_KEY" | "E_QUOTE_SIG_INVALID" | "E_OPENING_QUOTE_MISMATCH"; detail?: string } {
  if (!c?.quote) return { ok: false, code: "E_NO_FUNDED_QUOTE" };
  if (c.providerKeyId !== providerKeyId(home)) return { ok: false, code: "E_QUOTE_WRONG_PROVIDER_KEY", detail: "quote is not signed by this node's provider key" };
  const v = verifyFundedRunQuote(c.quote, { providerPublicKeyPem: providerPublicPem(home), signature: c.signature });
  if (!v.ok) return { ok: false, code: v.code === "E_QUOTE_SIG_INVALID" || v.code === "E_QUOTE_SIG_MISSING" ? "E_QUOTE_SIG_INVALID" : "E_OPENING_QUOTE_MISMATCH", detail: v.detail };
  return { ok: true, quote: c.quote };
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
  // The canonical deposit identity is chain:token:tx:log (Bo, block #2); the
  // real chain id and receipt log index MUST travel with the transfer rather
  // than being hard-coded, or two logs in one tx collapse to one identity.
  chainId: number;
  logIndex: number;
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

/**
 * Credit a deposit made against a funded-run quote embedded in the opening
 * (Bo, deposit-stage block). Unlike creditDeposit, this binds the credit to the
 * quote's exact fresh epoch through the ledger CAS, and records the quote's run
 * bounds durably so infer admission enforces the funded envelope. Two integrity
 * checks precede the CAS:
 *   * the opening MUST carry a funded quote, and
 *   * that quote must be internally sound and its digest self-consistent — a
 *     tampered opening whose stated quote digest no longer matches its fields is
 *     refused (E_OPENING_QUOTE_MISMATCH) rather than credited to a foreign quote.
 */
export function creditFundedDeposit(home: string, t: ObservedTransfer, artifact: OpeningArtifact, verdict: Extract<DepositVerdict, { ok: true }>):
  CreditFundedResult | { ok: false; code: "E_NO_FUNDED_QUOTE" | "E_QUOTE_WRONG_PROVIDER_KEY" | "E_QUOTE_SIG_INVALID" | "E_OPENING_QUOTE_MISMATCH" | "E_QUOTE_TERMS_MISMATCH" | "E_QUOTE_TRANSFER_MISMATCH"; detail?: string } {
  // (1) The embedded quote must be signed by THIS node's provider key — a
  //     self-signed or foreign quote never reaches credit (Bo, block #1).
  const vc = verifyFundedCommitment(home, artifact.funded);
  if (!vc.ok) return vc;
  const q = vc.quote;

  // (2) Exact quote ↔ opening-terms equality across every economically relevant
  //     field (Bo, block #2). The signature proves the provider committed these
  //     values; this proves the OPENING the buyer countersigned is about the
  //     same deposit.
  const terms = artifact.terms;
  const schedHex = createHash("sha256").update(canonicalize(COEFFICIENTS_CANONICAL as unknown as Record<string, unknown>)).digest("hex");
  const eq =
    q.chain === terms.chain &&
    q.tracContract.toLowerCase() === terms.tracContract.toLowerCase() &&
    q.providerAddress.toLowerCase() === terms.providerAddress.toLowerCase() &&
    q.refundAddress.toLowerCase() === terms.refundAddress.toLowerCase() &&
    q.principalTrac === terms.minimumCreditTrac &&
    q.confirmationDepth === terms.confirmationDepth &&
    q.expiryMs === terms.expiryMs &&
    q.rolloverPolicy === terms.rolloverPolicy &&
    q.refundOnExpiry === terms.refundOnExpiry &&
    q.scheduleDigest === schedHex;
  if (!eq) return { ok: false, code: "E_QUOTE_TERMS_MISMATCH", detail: "funded quote does not match the opening terms field-for-field" };

  // (3) Exact quote ↔ observed-transfer equality: the on-chain deposit must be
  //     on the quoted chain, in the quoted token, to the quoted provider (Bo #2).
  const transferOk =
    q.chain === `eip155:${t.chainId}` &&
    q.tracContract.toLowerCase() === t.token.toLowerCase() &&
    q.providerAddress.toLowerCase() === t.to.toLowerCase() &&
    q.refundAddress.toLowerCase() === t.from.toLowerCase();   // the depositing wallet IS the refund/tab identity
  if (!transferOk) return { ok: false, code: "E_QUOTE_TRANSFER_MISMATCH", detail: "funded quote does not match the observed transfer" };

  // (4) Credit under the epoch CAS, with the canonical deposit identity built
  //     from the REAL chain id and receipt log index (Bo #2) — never hard-coded.
  return creditFunded(home, artifact.tabPrincipal, verdict.creditMicroTrac, {
    kind: "trac-deposit",
    chainId: t.chainId,
    logIndex: t.logIndex,
    txHash: t.txHash,
    from: t.from,
    to: t.to,
    token: t.token,
    amountTrac: t.amountTrac,
    blockNumber: t.blockNumber,
    safeHeadBlock: t.safeHeadBlock,
    confirmations: t.safeHeadBlock - t.blockNumber + 1,
    termsDigest: artifact.termsDigest,
    refundAddress: artifact.terms.refundAddress,
    fundedRunTermsDigest: q.fundedRunTermsDigest,
  }, {
    expectedEpoch: q.tabEpoch,
    quoteDigest: q.fundedRunTermsDigest,
    calls: q.envelope.calls,
    aggregateCeilingMicroTrac: q.envelope.maxAcceptedClaimMicroTrac,
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

/**
 * Registry of live tab openings, keyed by principal, per DKG_HOME.
 *
 * Found 2026-08-06 with a real funded tab open on production: this was an
 * in-memory Map with no durable store and no boot replay, so a node restart
 * destroyed the opening artifact while the CREDIT remained durable in the
 * journal. That leaves a real balance with no tab to spend from and no terms
 * digest or refund address to refund against — the money is not lost, but the
 * agreement around it is, which is nearly as bad and much harder to explain.
 *
 * Openings are now append-only on disk and replayed on first access. Append-only
 * because an opening is evidence of what was agreed at a moment in time; the
 * latest record for a principal wins, and the earlier ones stay readable.
 */
const openingsByHome = new Map<string, Map<string, OpeningArtifact>>();
const replayedOpenings = new Set<string>();

const openingsPath = (home: string) => `${home}/metering/openings.jsonl`;

function replayOpenings(home: string): Map<string, OpeningArtifact> {
  if (!openingsByHome.has(home)) openingsByHome.set(home, new Map());
  const m = openingsByHome.get(home)!;
  if (replayedOpenings.has(home)) return m;
  replayedOpenings.add(home);
  const p = openingsPath(home);
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const a = JSON.parse(line) as OpeningArtifact;
        if (a?.tabPrincipal) m.set(a.tabPrincipal.toLowerCase(), a);
      } catch { /* a corrupt line must not deny every other tab */ }
    }
  }
  return m;
}

export function registerOpening(home: string, artifact: OpeningArtifact) {
  const m = replayOpenings(home);
  m.set(artifact.tabPrincipal.toLowerCase(), artifact);
  try {
    const dir = `${home}/metering`;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(openingsPath(home), JSON.stringify(artifact) + "\n");
  } catch { /* an unwritable disk must not silently drop a live tab */ }
  return artifact;
}

export function activeOpening(home: string, principal: string): OpeningArtifact | undefined {
  return replayOpenings(home).get(String(principal).toLowerCase());
}

/** Every opening this home knows about, for sweeps and operator inspection. */
export function allOpenings(home: string): OpeningArtifact[] {
  return [...replayOpenings(home).values()];
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

/**
 * Sweep expired tabs and record their refunds.
 *
 * Found 2026-08-06, with 1 TRAC of a counterparty's money sitting in a live
 * tab: `refundOnExpiry` and `evaluateExpiry` were implemented, correct, and
 * covered by six passing gates — and NOTHING called either of them. A refund
 * that no code path invokes is a promise, not a mechanism, and I had described
 * it to the buyer as a mechanism.
 *
 * This is the caller. It is idempotent by construction: `refundOnExpiry`
 * records exactly one refund per (principal, termsDigest), so a sweep that runs
 * every minute forever still produces one entry per expired tab.
 *
 * What it does NOT do, and must not be described as doing: move TRAC on-chain.
 * A ledger refund says the credit is owed back. Returning it is a separate
 * transaction from the provider wallet, requiring its own operator approval.
 */
export function sweepExpiredTabs(home: string, now = Date.now()): Array<{
  principal: string; refundedMicroTrac: number; alreadyRefunded: boolean; refundAddress: string;
}> {
  const out: Array<{ principal: string; refundedMicroTrac: number; alreadyRefunded: boolean; refundAddress: string }> = [];
  for (const a of allOpenings(home)) {
    if (now <= Date.parse(a.expiresAt)) continue;          // still live
    const b = balance(home, a.tabPrincipal);
    if (b.balance <= 0) continue;                           // nothing owed
    const r = refundOnExpiry(home, a.tabPrincipal, a.terms.refundAddress, a.termsDigest);
    out.push({
      principal: a.tabPrincipal,
      refundedMicroTrac: r.refundedMicroTrac,
      alreadyRefunded: r.alreadyRefunded,
      refundAddress: a.terms.refundAddress,
    });
  }
  return out;
}
