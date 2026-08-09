// V2 — inference metering. Prices and binds a served model call so it settles
// through the SAME spine as read metering (deposit → EIP-191 → leg → gradual
// release → countersign → close → on-chain withdrawal), unchanged.
//
// Receipt contract ratified by Hermes/Bo (buyer seat, event d4146b41), then
// REVISED after his adversarial pass (event 1571496d) which blocked v0.4:
//
//   * "Delivered bytes" and "canonical encode" must be PROTOCOL OBJECTS, not
//     implementation assumptions — hence CANONICALIZATION_CANONICAL below, bound
//     by digest into every leg.
//   * Digest+count "cannot be recounted": the leg carries the EXACT token-ID
//     SEQUENCES themselves, not just their digests.
//   * The tokenizer must be content-addressed as a COMPLETE BUNDLE (normalizer,
//     pre-tokenizer, added/special tables, post-processor), with engine+version,
//     so the buyer reproduces the count from artifacts he holds locally rather
//     than by calling any provider endpoint.
//   * A provider's /encode can be self-consistent while /serve runs different
//     weights/template — so the leg binds an immutable BACKEND MANIFEST
//     (weights + tokenizer bundle + engine build + sampler + instance), and the
//     node fails closed on drift.
//
// Billable = emitted/received tokens ONLY — no EOS, no stop-suppressed suffix,
// no hidden reasoning tokens — defined at the token-ID level as the canonical
// re-encode of exactly the bytes delivered to the buyer.
//
// PRICING + BINDING are pure (dependency-light, gate-testable offline); the
// RECOUNT VERIFY takes an injected tokenizer (a real HF tokenizer at runtime, a
// stub in unit gates, the BUYER's local bundle when he recounts).
import { createHash } from "node:crypto";
import { canonicalize } from "./ledger.js";

const sha256hex = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const sha256 = (b: string | Buffer) => "sha256:" + sha256hex(b);

export const RECEIPT_SCHEMA_VERSION = "receipt-v0.5";
export const INFERENCE_ROUTE = "POST /api/metering/infer";
export const INFERENCE_ROUTE_SCHEMA_VERSION = "infer-route/v1";

// ── canonicalization as a PROTOCOL OBJECT (Bo (a)) ──────────────────────────
// Every clause here is a rule two independent implementations must follow to
// derive the same billable count from the same response. It is digest-bound
// into the leg, so a provider that changes any of it changes the receipt.
export const CANONICALIZATION_CANONICAL = Object.freeze({
  version: "inference-canon/v1",
  // WHERE the billable bytes come from. Named exactly, so "delivered bytes" is
  // not an implementation assumption.
  deliveredBytesExtraction: "openai-chat-completion: choices[0].message.content, after the transport JSON parser's own unescaping, taken verbatim",
  encoding: "utf-8",
  // NO normalization. NFC/NFKC would change the bytes the buyer received, and we
  // bill exactly what was delivered — not a normalized paraphrase of it.
  normalization: "none",
  whitespacePolicy: "no trim, no newline mutation, no collapsing, no BOM insertion or removal",
  emptyOutput: "an empty delivered completion is legal and bills zero output tokens",
  tokenization: "tokenizer.encode(deliveredBytes as utf-8 text, add_special_tokens=false)",
  // The hard requirement Bo asked for: if the bundle cannot round-trip the bytes,
  // the call is UNBILLABLE. Failing closed is always cheaper than billing a count
  // the buyer cannot reproduce.
  roundTripRequirement: "decode(encode(bytes)) must equal bytes exactly; otherwise the call is unbillable",
  unrepresentableBytes: "if the delivered bytes cannot round-trip under the bound bundle (invalid sequences, byte-fallback boundaries), the leg is refused, never billed at an approximate count",
});

export function canonicalizationDigest(): string {
  return sha256(canonicalize(CANONICALIZATION_CANONICAL as unknown as Record<string, unknown>));
}

// ── pricing (integer µTRAC per token; scaled like COEFFICIENTS_CANONICAL) ──
export const INFERENCE_POLICY_CANONICAL = Object.freeze({
  policyVersion: "inference-policy/v1",
  perInputTokenMicroTrac: 2,   // matches metered-proxy priceVector
  perOutputTokenMicroTrac: 6,
  currency: "TRAC",
  unit: "microTRAC (1e-6 TRAC)",
  arithmetic: "cost = perInputTokenMicroTrac * inputTokens + perOutputTokenMicroTrac * outputTokens, integer micro-units, no rounding",
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

// ── the tokenizer as a content-addressed BUNDLE (Bo (a)/(b)) ────────────────
// A digest over tokenizer.json alone is not enough: the normalizer,
// pre-tokenizer, added/special-token tables and post-processor all change the
// count. The buyer fetches this bundle by digest and recounts locally.
export interface TokenizerBinding {
  /** digest over the COMPLETE bundle (every file in `bundleFiles`, in order). */
  bundleDigest: string;
  /** the exact file list the digest covers — so "complete" is auditable. */
  bundleFiles: string[];
  /** the implementation that produced the counts, and its version. */
  engine: string;
  engineVersion: string;
}

/** Digest a tokenizer bundle: name+content of each file, order-independent. */
export function tokenizerBundleDigest(files: Array<{ name: string; content: Buffer | string }>): string {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parts = sorted.map((f) => `${f.name}\n${sha256hex(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, "utf8"))}`);
  return sha256(parts.join("\n"));
}

// ── the immutable backend deployment (Bo (b)) ───────────────────────────────
// Binds ONE serving deployment to the leg. `instanceId` changes on restart, so a
// receipt cannot silently span a config change; the node fails closed on drift.
export interface BackendManifest {
  instanceId: string;
  weightsDigest: string;
  tokenizerBundleDigest: string;
  engineBuild: string;
  samplerConfig: Record<string, unknown>;
  chatTemplateDigest: string;
}

export function backendManifestDigest(m: BackendManifest): string {
  return sha256(canonicalize(m as unknown as Record<string, unknown>));
}

// ── the model identity a receipt must bind ──────────────────────────────────
export interface ModelBinding {
  modelId: string;
  weightsDigest: string;      // provenance
  tokenizerDigest: string;    // tokenizer.json alone (kept for continuity)
  chatTemplateDigest: string;
  tokenizer: TokenizerBinding;        // recount substrate, content-addressed
  backendManifestDigest: string;      // the deployment that produced the bytes
}

/** How generation ended, and — for a stop sequence — exactly where. */
export interface StopBoundary {
  kind: "eos" | "stop-sequence" | "length" | "other";
  /** the exact stop string matched, when kind === "stop-sequence". */
  match?: string;
}

// ── the artifacts the leg binds (Bo's revised set, receipt-v0.5) ────────────
export interface InferenceEvidence {
  schemaVersion: string;
  route: { path: string; schemaVersion: string };
  canonicalization: { version: string; digest: string };

  requestDigest: string;          // canonical request: messages, tools, sampler, seed, stops, max-tokens
  renderedPromptBytesDigest: string;
  /** the EXACT input token-ID sequence — arrays, not just a digest (Bo (c)). */
  inputTokenIds: number[];
  inputTokenIdsDigest: string;
  inputTokens: number;

  deliveredResponseBytesDigest: string;
  /** the EXACT billable output token-ID sequence. */
  outputTokenIds: number[];
  outputTokenIdsDigest: string;
  outputTokens: number;

  finishReason: string;
  stopBoundary: StopBoundary;

  model: ModelBinding;
  policyDigest: string;
  pricing: {
    perInputTokenMicroTrac: number;
    perOutputTokenMicroTrac: number;
    currency: string;
    unit: string;
    arithmetic: string;
    costMicroTrac: number;
  };
  rules: {
    addSpecialTokens: false;
    billableOutput: "emitted-token-ids-only";
    stopTokensBilled: false;
    roundTripRequired: true;
  };
}

/** A minimal tokenizer interface — a real HF tokenizer at runtime, a stub in
 *  gates, the BUYER's locally-held bundle when he recounts. `decode` MUST
 *  round-trip the exact bytes a sequence encodes. */
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
  | "E_RECOUNT_OUTPUT_BYTES"       // delivered bytes digest mismatch
  | "E_RECOUNT_OUTPUT_SEQ"         // billable sequence ≠ canonical re-encode
  | "E_RECOUNT_SPECIAL_TOKEN"      // billable output contains a special/EOS token
  | "E_RECOUNT_COUNT_MISMATCH"     // leg counts ≠ sequence lengths
  | "E_RECOUNT_ROUND_TRIP"         // decode(encode(bytes)) ≠ bytes — UNBILLABLE
  | "E_RECOUNT_CANON_VERSION"      // leg's canonicalization rules are not ours
  | "E_RECOUNT_PRICING"            // leg's stated cost ≠ policy arithmetic
  | "E_RECOUNT_MANIFEST";          // leg's model binding disagrees with the manifest

const seqEq = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The BUYER's recount, and the provider's own pre-sign check. Trusts nothing the
 * provider claimed about counts: it re-derives them from the bytes actually
 * delivered, under a tokenizer the verifier supplies.
 *
 * The buyer runs this with HIS OWN local bundle (fetched by `bundleDigest`) and
 * never calls a provider endpoint — that independence is the point of binding
 * the bundle and the arrays rather than digests alone.
 */
export function verifyInferenceRecount(args: {
  tokenizer: RecountTokenizer;
  renderedPrompt: string;
  deliveredCompletion: string;
  evidence: InferenceEvidence;
  /** ids that must never appear in a BILLABLE output sequence (EOS/BOS/special). */
  specialTokenIds: number[];
  /** the verifier's own tokenizer bundle digest; must equal the leg's. */
  expectedTokenizerBundleDigest?: string;
  /** the manifest the verifier believes served this call. */
  expectedBackendManifestDigest?: string;
}): RecountVerdict {
  const e = args.evidence;

  // ── the leg must be written under OUR rules, or the counts mean something else ──
  if (e.canonicalization?.digest !== canonicalizationDigest() || e.canonicalization?.version !== CANONICALIZATION_CANONICAL.version) {
    return { ok: false, code: "E_RECOUNT_CANON_VERSION", detail: "leg canonicalization rules differ from this verifier's" };
  }
  if (e.policyDigest !== inferencePolicyDigest()) {
    return { ok: false, code: "E_RECOUNT_PRICING", detail: "leg pricing policy differs from this verifier's" };
  }

  // ── provenance: the tokenizer that counted, and the deployment that served ──
  if (args.expectedTokenizerBundleDigest !== undefined && e.model?.tokenizer?.bundleDigest !== args.expectedTokenizerBundleDigest) {
    return { ok: false, code: "E_RECOUNT_MANIFEST", detail: "leg tokenizer bundle ≠ the bundle this verifier holds" };
  }
  if (args.expectedBackendManifestDigest !== undefined && e.model?.backendManifestDigest !== args.expectedBackendManifestDigest) {
    return { ok: false, code: "E_RECOUNT_MANIFEST", detail: "leg backend manifest ≠ the deployment this verifier observed" };
  }
  if (e.model?.tokenizer?.bundleDigest === undefined || e.model?.backendManifestDigest === undefined) {
    return { ok: false, code: "E_RECOUNT_MANIFEST", detail: "leg omits tokenizer bundle or backend manifest binding" };
  }

  // ── input: rendered prompt bytes + re-encoded sequence ──
  if (sha256(Buffer.from(args.renderedPrompt, "utf8")) !== e.renderedPromptBytesDigest) {
    return { ok: false, code: "E_RECOUNT_INPUT_BYTES" };
  }
  const reInput = args.tokenizer.encode(args.renderedPrompt, { add_special_tokens: false });
  if (!seqEq(reInput, e.inputTokenIds ?? [])) {
    return { ok: false, code: "E_RECOUNT_INPUT_SEQ", detail: "re-encoded prompt ≠ leg input sequence" };
  }
  if (sha256(canonicalize(reInput)) !== e.inputTokenIdsDigest) {
    return { ok: false, code: "E_RECOUNT_INPUT_SEQ", detail: "input sequence digest mismatch" };
  }
  if (reInput.length !== e.inputTokens) {
    return { ok: false, code: "E_RECOUNT_COUNT_MISMATCH", detail: "input" };
  }

  // ── output: the BILLABLE sequence is the CANONICAL re-encoding of the
  //    delivered bytes — NOT the provider's claimed emitted sequence.
  //
  // Why re-encode rather than decode-and-compare: a decode check passes for a
  // sequence padded with empty-decode tokens (bytes unchanged, count inflated),
  // and only catches it if every padding token is on a special-token list, which
  // a determined provider can dodge. Billing the canonical tokenization of
  // exactly the bytes the buyer received makes the count deterministic,
  // buyer-reproducible, and structurally unpaddable. The provider bears the risk
  // of any non-canonical generation; the payer only ever pays the canonical cost
  // of the bytes delivered. (Bo, buyer seat — accepted conditionally at 1571496d.)
  if (sha256(Buffer.from(args.deliveredCompletion, "utf8")) !== e.deliveredResponseBytesDigest) {
    return { ok: false, code: "E_RECOUNT_OUTPUT_BYTES", detail: "delivered bytes digest mismatch" };
  }
  const canonicalOut = args.tokenizer.encode(args.deliveredCompletion, { add_special_tokens: false });

  // Round-trip is a HARD precondition (Bo (a)): a bundle that cannot reproduce
  // the delivered bytes from its own encoding cannot be used to bill them.
  const roundTrip = args.tokenizer.decode(canonicalOut, { skip_special_tokens: false });
  if (roundTrip !== args.deliveredCompletion) {
    return { ok: false, code: "E_RECOUNT_ROUND_TRIP", detail: "decode(encode(deliveredBytes)) ≠ deliveredBytes — unbillable" };
  }

  const special = new Set(args.specialTokenIds);
  if (canonicalOut.some((id) => special.has(id))) {
    return { ok: false, code: "E_RECOUNT_SPECIAL_TOKEN", detail: "canonical output re-encode contains a special token" };
  }
  if (!seqEq(canonicalOut, e.outputTokenIds ?? [])) {
    return { ok: false, code: "E_RECOUNT_OUTPUT_SEQ", detail: "billed sequence ≠ canonical re-encode of delivered bytes (padding?)" };
  }
  if (sha256(canonicalize(canonicalOut)) !== e.outputTokenIdsDigest) {
    return { ok: false, code: "E_RECOUNT_OUTPUT_SEQ", detail: "output sequence digest mismatch" };
  }
  if (canonicalOut.length !== e.outputTokens) {
    return { ok: false, code: "E_RECOUNT_COUNT_MISMATCH", detail: "output" };
  }

  // ── the arithmetic the leg states must be the arithmetic we compute ──
  const cost = inferenceCostMicroTrac(e.inputTokens, e.outputTokens);
  if (e.pricing?.costMicroTrac !== cost) {
    return { ok: false, code: "E_RECOUNT_PRICING", detail: `leg says ${e.pricing?.costMicroTrac}, policy computes ${cost}` };
  }

  return { ok: true, inputTokens: e.inputTokens, outputTokens: e.outputTokens, costMicroTrac: cost };
}

/** Build the evidence block from verified artifacts. Pure; no tokenizer. */
export function buildInferenceEvidence(args: {
  requestCanonical: unknown;
  renderedPrompt: string;
  inputTokenIds: number[];
  deliveredCompletion: string;
  outputTokenIds: number[];
  model: ModelBinding;
  finishReason: string;
  stopBoundary: StopBoundary;
}): InferenceEvidence {
  const inputTokens = args.inputTokenIds.length;
  const outputTokens = args.outputTokenIds.length;
  const p = INFERENCE_POLICY_CANONICAL;
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    route: { path: INFERENCE_ROUTE, schemaVersion: INFERENCE_ROUTE_SCHEMA_VERSION },
    canonicalization: { version: CANONICALIZATION_CANONICAL.version, digest: canonicalizationDigest() },

    requestDigest: sha256(canonicalize(args.requestCanonical as Record<string, unknown>)),
    renderedPromptBytesDigest: sha256(Buffer.from(args.renderedPrompt, "utf8")),
    inputTokenIds: [...args.inputTokenIds],
    inputTokenIdsDigest: sha256(canonicalize(args.inputTokenIds)),
    inputTokens,

    deliveredResponseBytesDigest: sha256(Buffer.from(args.deliveredCompletion, "utf8")),
    outputTokenIds: [...args.outputTokenIds],
    outputTokenIdsDigest: sha256(canonicalize(args.outputTokenIds)),
    outputTokens,

    finishReason: args.finishReason,
    stopBoundary: args.stopBoundary,

    model: args.model,
    policyDigest: inferencePolicyDigest(),
    pricing: {
      perInputTokenMicroTrac: p.perInputTokenMicroTrac,
      perOutputTokenMicroTrac: p.perOutputTokenMicroTrac,
      currency: p.currency,
      unit: p.unit,
      arithmetic: p.arithmetic,
      costMicroTrac: inferenceCostMicroTrac(inputTokens, outputTokens),
    },
    rules: { addSpecialTokens: false, billableOutput: "emitted-token-ids-only", stopTokensBilled: false, roundTripRequired: true },
  };
}
