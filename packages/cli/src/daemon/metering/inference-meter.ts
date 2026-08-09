// V2 — inference metering. Prices and binds a served model call so it settles
// through the SAME spine as read metering (deposit → EIP-191 → leg → gradual
// release → countersign → close → on-chain withdrawal), unchanged.
//
// Receipt contract ratified by Hermes/Bo (buyer seat, event d4146b41), with the
// one correction that shapes this whole module:
//
//   Re-running sampled inference is NOT a valid recount — sampling is
//   non-deterministic, so the buyer cannot reproduce the call. The receipt
//   carries the EXACT input and output token-ID sequences, and recount is:
//   decode those sequences under the bound tokenizer and check the bytes equal
//   what was delivered. The signed leg is the oracle; provider `usage` is only a
//   claim that must EQUAL the verified leg fields.
//
// Billable = emitted/received tokens ONLY — no EOS, no stop-suppressed suffix,
// no hidden reasoning tokens. Defined at the token-ID level as the exact
// sequence whose decoded bytes form the delivered completion.
//
// This module is split so the PRICING + BINDING are pure (dependency-light,
// gate-testable offline) and the RECOUNT VERIFY takes an injected tokenizer
// (the real HF tokenizer at runtime, a stub in unit gates).
import { createHash } from "node:crypto";
import { canonicalize } from "./ledger.js";

const sha256hex = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const sha256 = (b: string | Buffer) => "sha256:" + sha256hex(b);

// ── pricing (integer µTRAC per token; scaled like COEFFICIENTS_CANONICAL) ──
export const INFERENCE_POLICY_CANONICAL = Object.freeze({
  policyVersion: "inference-policy/v1",
  perInputTokenMicroTrac: 2,   // matches metered-proxy priceVector
  perOutputTokenMicroTrac: 6,
  // Billable output is emitted-only; the policy states it so the buyer can rely
  // on it and reproduce it. (Bo: "if an impl cannot prove that mapping it is not
  // settlement-ready.")
  billableOutput: "emitted-token-ids-only" as const,
  stopTokenPolicy: "generated stop/EOS tokens are NOT billed" as const,
});

export function inferencePolicyDigest(): string {
  return sha256(canonicalize(INFERENCE_POLICY_CANONICAL as unknown as Record<string, unknown>));
}

export function inferenceCostMicroTrac(inputTokens: number, outputTokens: number): number {
  const p = INFERENCE_POLICY_CANONICAL;
  return p.perInputTokenMicroTrac * Math.max(0, inputTokens) + p.perOutputTokenMicroTrac * Math.max(0, outputTokens);
}

// ── the model identity a receipt must bind (all already in policy.json) ──
export interface ModelBinding {
  modelId: string;
  weightsDigest: string;      // provenance only
  tokenizerDigest: string;    // recount substrate
  chatTemplateDigest: string;
}

// ── the artifacts the leg binds (Bo's full ratified set) ──
export interface InferenceEvidence {
  requestDigest: string;          // canonical request: messages, tools, sampler, seed, stops, max-tokens
  renderedPromptBytesDigest: string;
  inputTokenIdsDigest: string;    // digest of the exact input token-ID sequence
  inputTokens: number;
  deliveredResponseBytesDigest: string;
  outputTokenIdsDigest: string;   // digest of the BILLABLE (emitted-only) output token-ID sequence
  outputTokens: number;
  model: ModelBinding;
  policyDigest: string;
  rules: {
    addSpecialTokens: false;      // recount tokenizes with add_special_tokens=false
    billableOutput: "emitted-token-ids-only";
    stopTokensBilled: false;
  };
}

/** A minimal tokenizer interface — the real HF tokenizer at runtime, a stub in
 *  gates. `decode` MUST round-trip the exact bytes a sequence encodes. */
export interface RecountTokenizer {
  encode(text: string, opts: { add_special_tokens: boolean }): number[];
  decode(ids: number[], opts?: { skip_special_tokens?: boolean }): string;
}

export type RecountVerdict =
  | { ok: true; inputTokens: number; outputTokens: number; costMicroTrac: number }
  | { ok: false; code: RecountCode; detail?: string };

export type RecountCode =
  | "E_RECOUNT_INPUT_BYTES"        // rendered prompt bytes digest mismatch
  | "E_RECOUNT_INPUT_SEQ"          // input token-ID sequence does not re-encode
  | "E_RECOUNT_OUTPUT_BYTES"       // delivered bytes ≠ decode(output token-IDs)
  | "E_RECOUNT_OUTPUT_SEQ"         // output token-ID sequence digest mismatch
  | "E_RECOUNT_SPECIAL_TOKEN"      // billable output contains a special/EOS token
  | "E_RECOUNT_COUNT_MISMATCH";    // leg counts ≠ sequence lengths

/**
 * The BUYER's recount, and the provider's own pre-sign check. Trusts nothing
 * the provider claimed about counts: it re-derives them from the exact token-ID
 * sequences and the bytes actually delivered.
 *
 *  input : re-encode the rendered prompt under the bound tokenizer → must equal
 *          the leg's input token-ID sequence (and its digest, and its count).
 *  output: DECODE the billable output token-ID sequence → its bytes must equal
 *          the delivered completion bytes exactly. The model is never re-run.
 */
export function verifyInferenceRecount(args: {
  tokenizer: RecountTokenizer;
  renderedPrompt: string;
  inputTokenIds: number[];
  deliveredCompletion: string;
  outputTokenIds: number[];
  evidence: InferenceEvidence;
  /** ids that must never appear in a BILLABLE output sequence (EOS/BOS/special). */
  specialTokenIds: number[];
}): RecountVerdict {
  const e = args.evidence;

  // ── input: rendered prompt bytes + re-encoded sequence ──
  if (sha256(Buffer.from(args.renderedPrompt, "utf8")) !== e.renderedPromptBytesDigest) {
    return { ok: false, code: "E_RECOUNT_INPUT_BYTES" };
  }
  const reInput = args.tokenizer.encode(args.renderedPrompt, { add_special_tokens: false });
  if (sha256(canonicalize(reInput)) !== e.inputTokenIdsDigest) {
    return { ok: false, code: "E_RECOUNT_INPUT_SEQ", detail: "re-encoded prompt ≠ leg input sequence" };
  }
  if (reInput.length !== e.inputTokens || args.inputTokenIds.length !== e.inputTokens) {
    return { ok: false, code: "E_RECOUNT_COUNT_MISMATCH", detail: "input" };
  }

  // ── output: the BILLABLE sequence is the CANONICAL re-encoding of the
  //    delivered bytes — NOT the provider's claimed emitted sequence.
  //
  // Why re-encode rather than decode-and-compare: a decode check passes for a
  // sequence padded with empty-decode tokens (bytes unchanged, count inflated),
  // and it only catches such padding if every padding token happens to be on a
  // special-token list — which a determined provider can dodge. Billing the
  // canonical tokenization of exactly the bytes the buyer received makes the
  // count deterministic, buyer-reproducible, and structurally unpaddable, and
  // it directly answers "can two conforming parties get different sequences for
  // the same bytes" — they re-encode the same bytes under the same tokenizer.
  // The provider bears the risk of any non-canonical generation; the payer only
  // ever pays the canonical cost of the bytes delivered. (Bo, buyer seat.)
  if (sha256(Buffer.from(args.deliveredCompletion, "utf8")) !== e.deliveredResponseBytesDigest) {
    return { ok: false, code: "E_RECOUNT_OUTPUT_BYTES", detail: "delivered bytes digest mismatch" };
  }
  const canonicalOut = args.tokenizer.encode(args.deliveredCompletion, { add_special_tokens: false });
  const special = new Set(args.specialTokenIds);
  if (canonicalOut.some((id) => special.has(id))) {
    // A visible-text re-encode should never contain a special token; if it does
    // the tokenizer/vocab is misbound.
    return { ok: false, code: "E_RECOUNT_SPECIAL_TOKEN", detail: "canonical output re-encode contains a special token" };
  }
  if (sha256(canonicalize(canonicalOut)) !== e.outputTokenIdsDigest) {
    return { ok: false, code: "E_RECOUNT_OUTPUT_SEQ", detail: "billed sequence ≠ canonical re-encode of delivered bytes (padding?)" };
  }
  if (canonicalOut.length !== e.outputTokens || args.outputTokenIds.length !== e.outputTokens) {
    return { ok: false, code: "E_RECOUNT_COUNT_MISMATCH", detail: "output" };
  }

  return {
    ok: true,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    costMicroTrac: inferenceCostMicroTrac(e.inputTokens, e.outputTokens),
  };
}

/** Build the evidence block from verified artifacts. Pure; no tokenizer. */
export function buildInferenceEvidence(args: {
  requestCanonical: unknown;
  renderedPrompt: string;
  inputTokenIds: number[];
  deliveredCompletion: string;
  outputTokenIds: number[];
  model: ModelBinding;
}): InferenceEvidence {
  return {
    requestDigest: sha256(canonicalize(args.requestCanonical as Record<string, unknown>)),
    renderedPromptBytesDigest: sha256(Buffer.from(args.renderedPrompt, "utf8")),
    inputTokenIdsDigest: sha256(canonicalize(args.inputTokenIds)),
    inputTokens: args.inputTokenIds.length,
    deliveredResponseBytesDigest: sha256(Buffer.from(args.deliveredCompletion, "utf8")),
    outputTokenIdsDigest: sha256(canonicalize(args.outputTokenIds)),
    outputTokens: args.outputTokenIds.length,
    model: args.model,
    policyDigest: inferencePolicyDigest(),
    rules: { addSpecialTokens: false, billableOutput: "emitted-token-ids-only", stopTokensBilled: false },
  };
}
