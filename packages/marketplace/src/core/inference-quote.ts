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
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { canonicalize } from "./ledger.js";
import { INFERENCE_POLICY_CANONICAL, inferencePolicyDigest, inferenceCostMicroTrac } from "./inference-meter.js";

const sha256 = (b: string) => "sha256:" + createHash("sha256").update(b).digest("hex");

export const FUNDED_RUN_QUOTE_VERSION = "inference-funded-quote/v1";
// Funded-run tab lifetime — a VERSIONED PROVIDER POLICY constant, advertised in
// and signed into the quote (like the binding-lifetime ceiling the buyer already
// accepted as a policy constant). Buyer-found the hard way (2026-08-10): the
// original 30-minute window was consumed by the review-and-redeploy latency of a
// mid-run audit cycle, expiring the tab before a single billed call could settle.
// A funded run's on-chain settlement window must be robust to at least one
// fix-and-redeploy cycle, so this is set to 24 hours. It still auto-refunds on
// expiry (no rollover); it only widens the window in which the run may complete.
export const FUNDED_RUN_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const FUNDED_RUN_EXPIRY_POLICY_VERSION = "funded-run-expiry/v1";
// A versioned policy MEANS an exact value, or it means nothing (buyer-found, Bo
// 2026-08-10): a quote may otherwise be labeled v1 while carrying an arbitrary
// window. The verifier maps the version to the value and rejects any mismatch,
// so `funded-run-expiry/v1` provably equals 24h at the verification boundary.
export const FUNDED_RUN_EXPIRY_POLICIES: Record<string, number> = Object.freeze({
  "funded-run-expiry/v1": FUNDED_RUN_EXPIRY_MS,
});
// The signing domain the provider commits the quote digest under. The route
// signs `providerSign(home, FUNDED_RUN_QUOTE_DOMAIN, digest)`; the buyer's
// verifier reconstructs the identical preimage to check the signature. Shared
// here so the two can never drift apart.
export const FUNDED_RUN_QUOTE_DOMAIN = "odysseus-dkg:funded-run-quote:v1";
export const TRAC_CONTRACT = "0xA81a52B4dda010896cDd386C7fBdc5CDc835ba23";

export interface FundedRunEnvelope {
  calls: number;                       // N deterministic calls
  streaming: false;                    // unbillable → unservable, so bound false
  tools: false;
  maxAcceptedClaimMicroTrac: number;   // the provider's claim can never exceed this
  withheldLegPolicy: string;           // one leg may be withheld/disputed
  /** Versioned envelope-scale policy governing the permitted range of N
   *  (P2 3.1). ABSENT on legacy quotes, which verify as envelope-scale/v1
   *  (N fixed at 10) — their digests are unchanged. */
  scalePolicyVersion?: string;
  /** Buyer-visible statement of the EFFECTIVE charge bound (P2 3.1, echoing
   *  the RelayOffering deliberation's max-charge principle): the ceiling above
   *  can exceed the deposited principal at large N; the balance CAS binds first. */
  depositBoundNote?: string;
}

// ── envelope-scale policy (P2 3.1) — versioned like the expiry policy: the
// version names an exact permitted range, the base verifier refuses any quote
// whose N falls outside its declared version's range, and an UNKNOWN version
// refuses outright. v1 is the historical fixed envelope; legacy quotes carry
// no field and resolve to it.
export const ENVELOPE_SCALE_POLICY_VERSION = "envelope-scale/v2";
export const ENVELOPE_SCALE_POLICIES: Record<string, { minCalls: number; maxCalls: number }> = {
  "envelope-scale/v1": { minCalls: 10, maxCalls: 10 },
  "envelope-scale/v2": { minCalls: 1, maxCalls: 100_000 },
};
// The note text is FROZEN PER SCALE VERSION (review, OpenClaw 3.1): the
// verifier compares against the note of the quote's OWN declared version, so a
// future copy edit means a NEW scale version with its own note — outstanding
// v2 quotes can never be invalidated by an edit to this file.
export const DEPOSIT_BOUND_NOTES: Record<string, string> = Object.freeze({
  "envelope-scale/v2":
    "effective maximum charge = min(deposited principal, maxAcceptedClaimMicroTrac); the tab balance CAS refuses any leg beyond the remaining deposit",
});
export const DEPOSIT_BOUND_NOTE = DEPOSIT_BOUND_NOTES[ENVELOPE_SCALE_POLICY_VERSION];

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
  expiryMs: number;                    // FUNDED_RUN_EXPIRY_MS (24h) — see policy note
  expiryPolicyVersion: string;         // versioned provider policy for the window
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
  // Build-side scale refusal (P2 3.1): N must be an integer inside the CURRENT
  // scale policy's range — a quote outside policy must be unbuildable here, not
  // merely unverifiable later.
  const scale = ENVELOPE_SCALE_POLICIES[ENVELOPE_SCALE_POLICY_VERSION];
  if (!Number.isSafeInteger(calls) || calls < scale.minCalls || calls > scale.maxCalls) {
    throw new Error(`E_ENVELOPE_SCALE: calls must be an integer in [${scale.minCalls}, ${scale.maxCalls}], got ${String(calls)}`);
  }
  // The maximum a provider may EVER claim from this run: N calls each at the
  // policy per-call ceiling for the declared shape (234 µTRAC, the reference
  // call) — the aggregate ceiling stays PROPORTIONAL to N at every scale; a
  // run that would price above it is a pricing dispute the buyer never signed.
  const maxAcceptedClaimMicroTrac = calls * inferenceCostMicroTrac(42, 25); // N × 234
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
    expiryMs: args.expiryMs ?? FUNDED_RUN_EXPIRY_MS,
    expiryPolicyVersion: FUNDED_RUN_EXPIRY_POLICY_VERSION,
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
      scalePolicyVersion: ENVELOPE_SCALE_POLICY_VERSION,
      depositBoundNote: DEPOSIT_BOUND_NOTE,
    },
    depositIdentity: {
      fields: ["chainId", "token", "txHash", "logIndex"],
      note: "the ledger credits a deposit at most once, keyed by this canonical id, and rolls a fresh epoch on a terminal prior tab",
    },
  };
  const d = boundDigest(bound);
  return { ...bound, quoteId: d, fundedRunTermsDigest: d };
}

/** What a buyer PINS ahead of time and requires the quote to match exactly.
 *  These are the external-contract facts a self-consistent foreign quote could
 *  otherwise satisfy internally while being about the wrong chain, token,
 *  provider, refund address, size, or epoch (Bo, deposit-stage block #3). */
export interface ExpectedQuoteBindings {
  chainId: number;
  tracContract: string;
  providerAddress: string;
  refundAddress: string;
  tabEpoch: number;                    // the exact fresh epoch the buyer intends to fund
  principalTrac: string;               // "1"
  confirmationDepth: number;           // 12
  expiryMs: number;                    // must equal the policy's value
  scheduleDigest: string;
  priceVectorDigest?: string;          // defaults to scheduleDigest if omitted
  envelopeCalls: number;               // N
  // REQUIRED (Bo, v2.5 block): a typed buyer verifier MUST pin the policy
  // version, not merely the duration — else a future policy of the same window
  // could satisfy the duration binding while defeating the intended version
  // binding. Compared unconditionally.
  expiryPolicyVersion: string;
  // REQUIRED (P2 3.1, same lesson applied forward): the buyer pins the
  // envelope-scale policy version alongside N. Legacy quotes resolve to
  // "envelope-scale/v1"; a v2 quote pinned as v1 (or vice versa) refuses.
  envelopeScalePolicyVersion: string;
}

export interface VerifyOptions {
  /** When present, every field is checked against the quote (external contract). */
  expected?: ExpectedQuoteBindings;
  /** When present with `signature`, the provider signature is cryptographically
   *  verified against THIS pre-pinned key — a foreign or wrong-key signature is
   *  rejected, not merely "a signature string exists". */
  providerPublicKeyPem?: string;
  signature?: string;                  // base64, over FUNDED_RUN_QUOTE_DOMAIN + "\n" + digest
}

const eqAddr = (a: string, b: string) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * The buyer's check. In its base form (no options) it confirms the quote is
 * internally sound: the digest covers the bound fields, the pricing equals the
 * live inference policy, and the envelope is well-formed. With `expected` it
 * additionally enforces the EXTERNAL contract — chain, token, provider, locked
 * refund address, principal, confirmations, expiry, schedule, epoch, and N —
 * so a self-consistent foreign quote is refused. With `providerPublicKeyPem` +
 * `signature` it cryptographically verifies the provider's commitment against a
 * pre-pinned key.
 */
export function verifyFundedRunQuote(q: FundedRunQuote, opts: VerifyOptions = {}): { ok: true } | { ok: false; code: string; detail: string } {
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
  // ── envelope scale is a VERSIONED INVARIANT (P2 3.1, same shape as the
  //    expiry policy): the quote's declared scale version must be known, and N
  //    must be an integer inside exactly that version's range. Legacy quotes
  //    carry no field and resolve to envelope-scale/v1 (N fixed at 10) — their
  //    digests and verification are unchanged. ──
  const scaleVersion = q.envelope.scalePolicyVersion ?? "envelope-scale/v1";
  const scalePolicy = ENVELOPE_SCALE_POLICIES[scaleVersion];
  if (scalePolicy === undefined) return { ok: false, code: "E_QUOTE_ENVELOPE_SCALE", detail: `unknown envelope-scale policy ${scaleVersion}` };
  if (!Number.isSafeInteger(q.envelope.calls) || q.envelope.calls < scalePolicy.minCalls || q.envelope.calls > scalePolicy.maxCalls) {
    return { ok: false, code: "E_QUOTE_ENVELOPE_SCALE", detail: `N ${q.envelope.calls} outside ${scaleVersion} range [${scalePolicy.minCalls}, ${scalePolicy.maxCalls}]` };
  }
  // The buyer-visible effective-charge statement is a v2 VERIFIER INVARIANT
  // (review, Hermes 3.1 #1): a v2 quote must carry EXACTLY the canonical note —
  // a self-consistent quote that omits or rewords the min(deposit, ceiling)
  // disclosure is refused at the base verifier, not merely discouraged.
  // Legacy (v1) quotes predate the field and carry neither.
  if (scaleVersion !== "envelope-scale/v1" && q.envelope.depositBoundNote !== DEPOSIT_BOUND_NOTES[scaleVersion]) {
    return { ok: false, code: "E_QUOTE_DEPOSIT_NOTE", detail: `quote must carry byte-exactly the ${scaleVersion} deposit-bound note (effective max charge = min(principal, ceiling))` };
  }
  if (JSON.stringify(q.depositIdentity?.fields) !== JSON.stringify(["chainId", "token", "txHash", "logIndex"])) {
    return { ok: false, code: "E_QUOTE_DEPOSIT_ID", detail: "deposit-identity fields ≠ the canonical chain:token:tx:log" };
  }
  // ── expiry policy is a VERSIONED INVARIANT (Bo, v2.4 block): the version must
  //    be a known policy AND the quote's expiryMs must equal exactly that
  //    policy's value. A quote labeled v1 carrying any other window is refused
  //    here, at the base verifier — before any opening adopts it. ──
  const policyExpiry = FUNDED_RUN_EXPIRY_POLICIES[q.expiryPolicyVersion as string];
  if (policyExpiry === undefined) return { ok: false, code: "E_QUOTE_EXPIRY_POLICY", detail: `unknown expiry policy ${q.expiryPolicyVersion}` };
  if (q.expiryMs !== policyExpiry) return { ok: false, code: "E_QUOTE_EXPIRY_POLICY", detail: `expiry ${q.expiryMs} ≠ policy ${q.expiryPolicyVersion} value ${policyExpiry}` };

  // ── external-contract binding (a foreign self-consistent quote fails here) ──
  const e = opts.expected;
  if (e) {
    if (q.chain !== `eip155:${e.chainId}`) return { ok: false, code: "E_QUOTE_EXPECT_CHAIN", detail: `chain ${q.chain} ≠ eip155:${e.chainId}` };
    if (!eqAddr(q.tracContract, e.tracContract)) return { ok: false, code: "E_QUOTE_EXPECT_TOKEN", detail: "TRAC contract ≠ expected" };
    if (!eqAddr(q.providerAddress, e.providerAddress)) return { ok: false, code: "E_QUOTE_EXPECT_PROVIDER", detail: "provider address ≠ expected" };
    if (!eqAddr(q.refundAddress, e.refundAddress)) return { ok: false, code: "E_QUOTE_EXPECT_REFUND", detail: "refund address ≠ the locked one the buyer expects" };
    if (q.tabEpoch !== e.tabEpoch) return { ok: false, code: "E_QUOTE_EXPECT_EPOCH", detail: `tabEpoch ${q.tabEpoch} ≠ expected fresh epoch ${e.tabEpoch}` };
    if (q.principalTrac !== e.principalTrac) return { ok: false, code: "E_QUOTE_EXPECT_PRINCIPAL", detail: `principal ${q.principalTrac} ≠ ${e.principalTrac} TRAC` };
    if (q.confirmationDepth !== e.confirmationDepth) return { ok: false, code: "E_QUOTE_EXPECT_CONFIRMATIONS", detail: `confirmations ${q.confirmationDepth} ≠ ${e.confirmationDepth}` };
    if (q.expiryMs !== e.expiryMs) return { ok: false, code: "E_QUOTE_EXPECT_EXPIRY", detail: `expiry ${q.expiryMs} ≠ ${e.expiryMs}` };
    // Unconditional: a buyer that supplies `expected` MUST pin the policy version.
    if (q.expiryPolicyVersion !== e.expiryPolicyVersion) return { ok: false, code: "E_QUOTE_EXPECT_EXPIRY", detail: `expiry policy ${q.expiryPolicyVersion} ≠ expected ${e.expiryPolicyVersion}` };
    if (q.rolloverPolicy !== "none" || q.refundOnExpiry !== true) return { ok: false, code: "E_QUOTE_EXPECT_POLICY", detail: "rollover must be none and refundOnExpiry true" };
    if (q.scheduleDigest !== e.scheduleDigest) return { ok: false, code: "E_QUOTE_EXPECT_SCHEDULE", detail: "scheduleDigest ≠ expected" };
    if (q.priceVectorDigest !== (e.priceVectorDigest ?? e.scheduleDigest)) return { ok: false, code: "E_QUOTE_EXPECT_SCHEDULE", detail: "priceVectorDigest ≠ expected" };
    if (q.envelope.calls !== e.envelopeCalls) return { ok: false, code: "E_QUOTE_EXPECT_ENVELOPE", detail: `N ${q.envelope.calls} ≠ expected ${e.envelopeCalls}` };
    if (scaleVersion !== e.envelopeScalePolicyVersion) return { ok: false, code: "E_QUOTE_EXPECT_ENVELOPE", detail: `envelope-scale ${scaleVersion} ≠ expected ${e.envelopeScalePolicyVersion}` };
  }

  // ── provider signature (a forged or wrong-key signature fails here) ──
  if (opts.providerPublicKeyPem || opts.signature) {
    if (!opts.providerPublicKeyPem || !opts.signature) {
      return { ok: false, code: "E_QUOTE_SIG_MISSING", detail: "both a pinned provider key and a signature are required to verify the commitment" };
    }
    let valid = false;
    try {
      const preimage = Buffer.concat([Buffer.from(FUNDED_RUN_QUOTE_DOMAIN + "\n"), Buffer.from(fundedRunTermsDigest)]);
      valid = edVerify(null, preimage, createPublicKey(opts.providerPublicKeyPem), Buffer.from(opts.signature, "base64"));
    } catch {
      valid = false;   // a malformed key or signature is an invalid signature, never a throw
    }
    if (!valid) return { ok: false, code: "E_QUOTE_SIG_INVALID", detail: "provider signature does not verify against the pinned key" };
  }

  return { ok: true };
}
