// P3 Phase A — receipt-v0.7 enclave fields + the buyer verifier.
//
// Implements contract-freeze (d) EXACTLY: the frozen additive fields over
// receipt-v0.6, the attested-deployment-manifest binding, the freshness/
// rollback refusal semantics, and the padding-bucket disclosure rules.
// Phase A populates them from the BOUNDARY-SIM enclave (labeled, simulated);
// the verifier REFUSES simulated quotes unless the caller explicitly opts in
// — a buyer can never mistake the simulation for confidential compute.
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { canonicalize } from "./ledger.js";
import { SIM_ATTESTATION_DOMAIN, quoteBinding, quoteDigestOf, type SimQuote } from "./sim-enclave.js";

const sha256 = (b: Buffer | string) => "sha256:" + createHash("sha256").update(b).digest("hex");

// ── frozen field shapes ──
export type PaddingBucket = "none" | "b128" | "b512" | "b2048";
export const PADDING_BUCKETS: Record<PaddingBucket, number> = { none: 0, b128: 128, b512: 512, b2048: 2048 };
export interface EnclaveReceiptFields {
  enclave: {
    measurement: string;              // sha384:… launch measurement (SIM in Phase A)
    attestationQuoteDigest: string;   // sha256 over the canonical quote (quote content-addressed)
    hpkeKeyId: string;                // the key the prompt was sealed to; bound in report_data
    manifestDigest: string;           // sha256 over canonicalize(attested manifest)
  };
  privacy: { paddingBucket: PaddingBucket };
}

/** Populate the frozen v0.7 fields from an enclave quote. ADDITIVE ONLY:
 *  merged over a v0.6 receipt without touching any existing field. */
export function buildEnclaveReceiptFields(quote: SimQuote, hpkeKeyId: string, manifestDigest: string, paddingBucket: PaddingBucket = "none"): EnclaveReceiptFields {
  return {
    enclave: {
      measurement: quote.measurement,
      attestationQuoteDigest: quoteDigestOf(quote),
      hpkeKeyId,
      manifestDigest,
    },
    privacy: { paddingBucket },
  };
}

/** Published-KA disclosure: exact counts stay counterparty-only when a bucket
 *  is set; the KA carries the count rounded UP to the bucket boundary (an
 *  upper bound leaks less than the exact length; never rounds down — a
 *  published bound must not understate what was billed). */
export function publishedTokenCount(exactCount: number, bucket: PaddingBucket): number {
  if (!Number.isSafeInteger(exactCount) || exactCount < 0) throw new Error("E_BAD_COUNT");
  const b = PADDING_BUCKETS[bucket];
  if (b === 0) return exactCount;
  return Math.ceil(exactCount / b) * b;
}

// ── the buyer verifier (frozen refusal semantics) ──
export interface MeasurementAllowlist {
  version: number;                     // the CURRENT allowlist version the buyer holds
  measurements: string[];              // sha384:… measurements valid AT this version
}
export function verifyEnclaveReceipt(args: {
  fields: EnclaveReceiptFields;
  quote: SimQuote;                     // fetched content-addressed via attestationQuoteDigest
  simRootPublicPem: string;            // the buyer-PINNED root (Phase B: AMD/Intel chain)
  allowlist: MeasurementAllowlist;
  expectedAllowlistVersion: number;    // what the buyer believes is CURRENT
  binding: { tabEpoch: number; providerAddress: string; runtimeConfigDigest: string };
  maxQuoteAgeMs: number;               // from the attested manifest's freshness policy
  nowMs: number;
  /** Phase A only: explicit, labeled opt-in to the SIMULATION. Default false:
   *  a simulated quote REFUSES — it is never confidential compute. */
  acceptLabeledSimulation?: boolean;
}): { ok: true } | { ok: false; code: string; detail?: string } {
  const { fields, quote } = args;
  // 1. STRUCTURAL LABEL check FIRST (review, Hermes P3 #1): a quote lacking the
  //    literal simulated:true is refused before anything else, regardless of
  //    signature — the most fail-closed position. In Phase A there is no
  //    non-simulated domain, so an unlabeled quote is a misrepresentation.
  if (quote.simulated !== true) {
    return { ok: false, code: "E_QUOTE_LABEL_ERASED", detail: "Phase A quotes MUST carry simulated:true — an unlabeled quote is not a real attestation" };
  }
  // 2. signature under the pinned root, over the domain-separated canonical body
  try {
    const { signature, ...body } = quote;
    const valid = edVerify(null,
      Buffer.from(SIM_ATTESTATION_DOMAIN + "\n" + canonicalize(body as unknown as Record<string, unknown>)),
      createPublicKey(args.simRootPublicPem), Buffer.from(signature, "base64"));
    if (!valid) return { ok: false, code: "E_QUOTE_SIG" };
  } catch { return { ok: false, code: "E_QUOTE_SIG" }; }
  // 3. the simulation is opt-in, always — fail closed BEFORE any other comfort
  if (args.acceptLabeledSimulation !== true) {
    return { ok: false, code: "E_QUOTE_SIMULATED", detail: "quote is a labeled BOUNDARY-SIM artifact, not confidential compute — refuse unless explicitly accepting the simulation" };
  }
  if (quote.domain !== SIM_ATTESTATION_DOMAIN) return { ok: false, code: "E_QUOTE_DOMAIN" };
  // 4. ROOT-KEY IDENTITY binding (review, Hermes P3 #2): the quote's declared
  //    simRootKeyId must equal the digest of the PINNED root pem — a rotated
  //    or substituted root cannot ride an old key id (and vice versa).
  const pinnedRootId = "sha256:" + createHash("sha256").update(args.simRootPublicPem).digest("hex");
  if (quote.simRootKeyId !== pinnedRootId) return { ok: false, code: "E_QUOTE_ROOT_KEY_MISMATCH", detail: "quote simRootKeyId ≠ digest of the pinned root key — rotation/substitution must be an explicit re-pin, never silent" };
  // 5. the receipt must reference THIS quote, content-addressed
  if (quoteDigestOf(quote) !== fields.enclave.attestationQuoteDigest) return { ok: false, code: "E_QUOTE_DIGEST", detail: "receipt's attestationQuoteDigest ≠ digest of the presented quote" };
  if (quote.measurement !== fields.enclave.measurement) return { ok: false, code: "E_MEASUREMENT_MISMATCH" };
  // 6. report_data binds key + manifest + the frozen freshness set — a quote
  //    for another epoch/provider/runtime is a REPLAY and refuses
  const expected = quoteBinding({
    hpkeKeyId: fields.enclave.hpkeKeyId, manifestDigest: fields.enclave.manifestDigest,
    tabEpoch: args.binding.tabEpoch, providerAddress: args.binding.providerAddress,
    runtimeConfigDigest: args.binding.runtimeConfigDigest,
  });
  if (quote.reportData !== expected) return { ok: false, code: "E_QUOTE_BINDING", detail: "report_data does not bind {hpkeKeyId, manifestDigest, tabEpoch, providerAddress, runtimeConfigDigest}" };
  // 7. freshness: an old-but-valid quote refuses
  if (!(Number.isFinite(quote.issuedAtMs) && args.nowMs - quote.issuedAtMs <= args.maxQuoteAgeMs && args.nowMs >= quote.issuedAtMs)) {
    return { ok: false, code: "E_QUOTE_STALE", detail: `quote age exceeds maxQuoteAgeMs=${args.maxQuoteAgeMs} (or is from the future)` };
  }
  // 8. rollback refusal: the measurement must be on the CURRENT allowlist —
  //    a validly-measured but superseded image cannot serve
  if (args.allowlist.version !== args.expectedAllowlistVersion) return { ok: false, code: "E_ALLOWLIST_STALE", detail: `allowlist v${args.allowlist.version} ≠ current v${args.expectedAllowlistVersion}` };
  if (!args.allowlist.measurements.includes(quote.measurement)) return { ok: false, code: "E_MEASUREMENT_NOT_ALLOWLISTED" };
  return { ok: true };
}

/** Privacy check for a receipt KA about to publish: digests+amounts only, and
 *  counts must respect the declared bucket (a bucket set + a non-boundary
 *  count means exact counts leaked into the KA). */
export function checkPublishedReceiptPrivacy(ka: Record<string, unknown>, bucket: PaddingBucket):
  { ok: true } | { ok: false; code: string; detail?: string } {
  const FORBIDDEN = new Set(["prompt", "completion", "messages", "renderedPrompt", "tokenIds", "plaintext"]);
  // RECURSIVE (review, Hermes P3 #3): a nested object/array must not smuggle a
  // forbidden field past a top-level check.
  const scan = (v: unknown, path: string): string | null => {
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const r = scan(v[i], `${path}[${i}]`); if (r) return r; } return null; }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (FORBIDDEN.has(k)) return `${path}.${k}`;
        const r = scan(x, `${path}.${k}`); if (r) return r;
      }
    }
    return null;
  };
  const hit = scan(ka, "ka");
  if (hit) return { ok: false, code: "E_KA_PLAINTEXT_FIELD", detail: hit };
  const b = PADDING_BUCKETS[bucket];
  if (b > 0) {
    for (const f of ["inputTokens", "outputTokens"]) {
      const v = ka[f];
      if (typeof v === "number" && v % b !== 0) return { ok: false, code: "E_KA_EXACT_COUNT_LEAK", detail: `${f}=${v} is not a ${bucket} boundary` };
    }
  }
  return { ok: true };
}
