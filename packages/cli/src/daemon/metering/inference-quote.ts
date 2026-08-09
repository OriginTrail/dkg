// V2 — the inference FUNDED-RUN quote.
//
// Buyer-found (Hermes/Bo, deposit-stage block): the generic read quote does not
// bind a fresh epoch or the inference terms, and its termsDigest collides with a
// prior settled lifecycle — so a buyer cannot bind an exact deposit to a fresh
// epoch or distinguish it from the prior tab. This object binds, into one signed
// quote with its OWN digest, everything the buyer needs to commit a funded
// inference run:
//
//   * the fresh tabEpoch this deposit opens, and a quoteId over all bound fields;
//   * the deposit terms (chain, token, provider, locked refund address, exactly
//     1 TRAC principal, 12 safe-head confirmations, 30-minute expiry);
//   * the receipt-v0.6 inference pricing (2 µTRAC/input + 6 µTRAC/output), NOT
//     the generic read ask;
//   * the run envelope — N deterministic non-streaming tool-free calls, a
//     maximum accepted provider claim, and the one-withheld-leg policy;
//   * the canonical deposit-identity fields the ledger dedups by, so crediting
//     is replay-safe and epoch-bound.
//
// Because tabEpoch and the inference fields are inside the digest, this digest
// necessarily differs from the read termsDigest of the same principal/terms.
import { createHash } from "node:crypto";
import { canonicalize } from "./ledger.js";
import { INFERENCE_POLICY_CANONICAL, inferencePolicyDigest, inferenceCostMicroTrac } from "./inference-meter.js";

const sha256 = (b: string) => "sha256:" + createHash("sha256").update(b).digest("hex");

export const FUNDED_RUN_QUOTE_VERSION = "inference-funded-quote/v1";
export const TRAC_CONTRACT = "0xA81a52B4dda010896cDd386C7fBdc5CDc835ba23";

export interface FundedRunEnvelope {
  calls: number;                       // N deterministic calls
  streaming: false;                    // unbillable → unservable, so bound false
  tools: false;
  maxAcceptedClaimMicroTrac: number;   // the provider's claim can never exceed this
  withheldLegPolicy: string;           // one leg may be withheld/disputed
}

export interface FundedRunQuote {
  quoteVersion: string;
  quoteId: string;                     // digest over every bound field below
  tabEpoch: number;                    // the FRESH epoch this deposit opens
  chain: string;                       // eip155:8453
  tracContract: string;
  providerAddress: string;
  refundAddress: string;               // LOCKED
  principalTrac: string;               // "1"
  minimumCreditTrac: string;           // "1"
  confirmationDepth: number;           // 12, safe head
  expiryMs: number;                    // 30 min
  rolloverPolicy: "none";
  refundOnExpiry: true;
  scheduleDigest: string;
  priceVectorDigest: string;
  inferencePricing: {
    policyVersion: string;
    perInputTokenMicroTrac: number;    // 2
    perOutputTokenMicroTrac: number;   // 6
    policyDigest: string;
  };
  envelope: FundedRunEnvelope;
  depositIdentity: { fields: string[]; note: string };
  fundedRunTermsDigest: string;        // the digest a fresh opening/tab will carry
}

/** Digest over the bound fields (everything except the two self-referential
 *  digest fields), so quoteId and fundedRunTermsDigest are reproducible. */
function boundDigest(q: Omit<FundedRunQuote, "quoteId" | "fundedRunTermsDigest">): string {
  return sha256(canonicalize(q as unknown as Record<string, unknown>));
}

export function buildFundedRunQuote(args: {
  tabEpoch: number;                    // the fresh epoch (current+1 if terminal, else current)
  providerAddress: string;
  refundAddress: string;
  scheduleDigest: string;
  priceVectorDigest?: string;
  chainId?: number;
  calls?: number;                      // N, default 10
  expiryMs?: number;
}): FundedRunQuote {
  const p = INFERENCE_POLICY_CANONICAL;
  const calls = args.calls ?? 10;
  // The maximum a provider may EVER claim from this run: N calls each at the
  // policy per-call ceiling for the declared shape. We bind the buyer-agreed
  // envelope of 2,340 µTRAC (N=10 × 234, the reference call) as the ceiling; a
  // run that would price above it is a pricing dispute the buyer never signed.
  const maxAcceptedClaimMicroTrac = calls * inferenceCostMicroTrac(42, 25); // 10 × 234 = 2340
  const bound: Omit<FundedRunQuote, "quoteId" | "fundedRunTermsDigest"> = {
    quoteVersion: FUNDED_RUN_QUOTE_VERSION,
    tabEpoch: args.tabEpoch,
    chain: `eip155:${args.chainId ?? 8453}`,
    tracContract: TRAC_CONTRACT,
    providerAddress: args.providerAddress,
    refundAddress: args.refundAddress,
    principalTrac: "1",
    minimumCreditTrac: "1",
    confirmationDepth: 12,
    expiryMs: args.expiryMs ?? 30 * 60 * 1000,
    rolloverPolicy: "none",
    refundOnExpiry: true,
    scheduleDigest: args.scheduleDigest,
    priceVectorDigest: args.priceVectorDigest ?? args.scheduleDigest,
    inferencePricing: {
      policyVersion: p.policyVersion,
      perInputTokenMicroTrac: p.perInputTokenMicroTrac,
      perOutputTokenMicroTrac: p.perOutputTokenMicroTrac,
      policyDigest: inferencePolicyDigest(),
    },
    envelope: {
      calls,
      streaming: false,
      tools: false,
      maxAcceptedClaimMicroTrac,
      withheldLegPolicy: "the buyer may withhold/dispute up to one leg; a disputed leg is void and excluded from the provider claim",
    },
    depositIdentity: {
      fields: ["chainId", "token", "txHash", "logIndex"],
      note: "the ledger credits a deposit at most once, keyed by this canonical id, and rolls a fresh epoch on a terminal prior tab",
    },
  };
  const d = boundDigest(bound);
  return { ...bound, quoteId: d, fundedRunTermsDigest: d };
}

/** The buyer's check: recompute the digest over the received bound fields and
 *  confirm quoteId + fundedRunTermsDigest match — so nothing was altered in
 *  transit, and the digest genuinely covers the epoch and the envelope. */
export function verifyFundedRunQuote(q: FundedRunQuote): { ok: true } | { ok: false; code: string; detail: string } {
  if (q?.quoteVersion !== FUNDED_RUN_QUOTE_VERSION) return { ok: false, code: "E_QUOTE_VERSION", detail: "not a funded-run quote" };
  const { quoteId, fundedRunTermsDigest, ...bound } = q;
  const d = boundDigest(bound);
  if (d !== quoteId) return { ok: false, code: "E_QUOTE_DIGEST", detail: "quoteId ≠ digest of the bound fields" };
  if (d !== fundedRunTermsDigest) return { ok: false, code: "E_QUOTE_DIGEST", detail: "fundedRunTermsDigest ≠ digest of the bound fields" };
  if (q.inferencePricing.perInputTokenMicroTrac !== INFERENCE_POLICY_CANONICAL.perInputTokenMicroTrac
    || q.inferencePricing.perOutputTokenMicroTrac !== INFERENCE_POLICY_CANONICAL.perOutputTokenMicroTrac
    || q.inferencePricing.policyDigest !== inferencePolicyDigest()) {
    return { ok: false, code: "E_QUOTE_PRICING", detail: "quote pricing ≠ the live inference policy" };
  }
  if (q.envelope.streaming !== false || q.envelope.tools !== false) return { ok: false, code: "E_QUOTE_ENVELOPE", detail: "streaming/tools must be false (unbillable)" };
  if (q.envelope.maxAcceptedClaimMicroTrac !== q.envelope.calls * inferenceCostMicroTrac(42, 25)) {
    return { ok: false, code: "E_QUOTE_ENVELOPE", detail: "maxAcceptedClaim ≠ N × reference-call cost" };
  }
  return { ok: true };
}
