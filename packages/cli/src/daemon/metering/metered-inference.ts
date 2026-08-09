// V2 — metered inference: the billing path for a served model call.
//
// Reuses the read path's authorisation wholesale (anchor → capability →
// funded-requires-EIP-191 → gradual release → open-tab), then meters the call
// under the Bo-ratified recount contract and records an inference leg that
// settles through the same spine. The model call itself is INJECTED (piece 4
// wires Odysseus via the Apache metered-proxy, preserving G1); this core stays
// free of the model dependency and is fully gate-testable.
import { authoriseMeteredRead, type MeteredReadRequest } from "./metered-read.js";
import { recordInferenceLeg } from "./ledger.js";
import {
  verifyInferenceRecount, buildInferenceEvidence, inferenceCostMicroTrac,
  inferencePolicyDigest, INFERENCE_POLICY_CANONICAL,
  type ModelBinding, type RecountTokenizer, type StopBoundary,
} from "./inference-meter.js";
import { isExempt, type MeterConfig } from "./read-meter.js";

/** What a served model call returns — the artifacts the receipt binds. */
export interface ModelResult {
  renderedPrompt: string;
  inputTokenIds: number[];
  deliveredCompletion: string;
  outputTokenIds: number[];
  model: ModelBinding;
  /** canonical request (messages, tools, sampler, seed, stops, max-tokens). */
  requestCanonical: unknown;
  finishReason: string;
  stopBoundary: StopBoundary;
}

export type InferenceOutcome =
  | { ok: false; status: number; code: string; detail?: string }
  | {
      ok: true; status: 200; principal: string; billed: boolean;
      costMicroTrac: number; leg: Record<string, unknown>;
      tab: { before: number; after: number };
      settlement: { admissible: false; reason: string };
    };

/** What a request may ask for. Anything outside this is refused BEFORE serving. */
export interface InferenceRequestShape {
  messages?: unknown;
  tools?: unknown;
  stream?: unknown;
  maxTokens?: unknown;
  sampler?: unknown;
}

export type PreflightOutcome =
  | { ok: false; status: number; code: string; detail?: string }
  | { ok: true; principal: string; bindingMode?: string };

/**
 * PRE-SERVE gate: authorise, then validate the request against the supported
 * feature set and the policy bounds — all WITHOUT touching the model.
 *
 * Buyer-found (Bo, event 7ee42566): the route previously served first and
 * authorised after, so an unauthorised delegation could consume a full
 * generation before being refused. Zero tab mutation was true and beside the
 * point — the compute was already spent. Authorisation and cap validation must
 * happen before a single token is generated.
 *
 * The auth here is side-effect free (it reads capability state, never mutates
 * it), so meterInference re-running it after serving is defence in depth rather
 * than double-counting.
 */
export function preflightInference(args: {
  home: string;
  chainId: number;
  cfg: MeterConfig;
  request: {
    delegation: MeteredReadRequest["delegation"];
    bindingProof?: MeteredReadRequest["bindingProof"];
    revocationCheckpoint?: MeteredReadRequest["revocationCheckpoint"];
  };
  payload: InferenceRequestShape;
  state: Parameters<typeof authoriseMeteredRead>[0]["state"];
  scheduleDigest: string;
  priceVectorDigest: string;
  nodeClass: string;
  settlementId: string;
  now?: number;
}): PreflightOutcome {
  // 1. Authorisation FIRST — a stranger gets no compute.
  const auth = authoriseMeteredRead({
    home: args.home, chainId: args.chainId, cfg: args.cfg,
    request: {
      delegation: args.request.delegation,
      bindingProof: args.request.bindingProof,
      sparql: "inference",
      revocationCheckpoint: args.request.revocationCheckpoint,
    },
    state: args.state,
    route: "POST /api/metering/infer",
    nodeClass: args.nodeClass,
    settlementId: args.settlementId,
    scheduleDigest: args.scheduleDigest,
    priceVectorDigest: args.priceVectorDigest,
    now: args.now,
  });
  if (!auth.ok) return { ok: false, status: auth.status, code: auth.code, detail: auth.detail };

  // 2. Unsupported features are refused, not silently served. Streaming and
  //    tool calls are declared untested under this contract and are therefore
  //    unbillable — so they must also be unservable on the metered route,
  //    otherwise "unbillable" would mean "free".
  const p = args.payload ?? {};
  if (p.stream === true || p.stream === "true") {
    return { ok: false, status: 400, code: "E_STREAMING_UNSUPPORTED", detail: "streaming responses are not metered under this contract" };
  }
  if (p.tools !== undefined && p.tools !== null && !(Array.isArray(p.tools) && p.tools.length === 0)) {
    return { ok: false, status: 400, code: "E_TOOLS_UNSUPPORTED", detail: "tool calls are not metered under this contract" };
  }

  // 3. Bounds are REFUSED, never clamped — a clamp silently serves something
  //    other than what was asked for, and hides the disagreement.
  const lim = INFERENCE_POLICY_CANONICAL.limits;
  if (p.maxTokens !== undefined) {
    const n = Number(p.maxTokens);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, status: 400, code: "E_BAD_MAX_TOKENS", detail: "maxTokens must be a positive integer" };
    }
    if (n > lim.maxOutputTokens) {
      return { ok: false, status: 413, code: "E_OVER_POLICY_LIMIT", detail: `maxTokens ${n} > policy maxOutputTokens ${lim.maxOutputTokens}` };
    }
  }
  const requestBytes = Buffer.byteLength(JSON.stringify(p.messages ?? []), "utf8");
  if (requestBytes > lim.maxEvidenceBytes) {
    return { ok: false, status: 413, code: "E_OVER_POLICY_LIMIT", detail: `request ${requestBytes}B > ${lim.maxEvidenceBytes}B` };
  }

  return { ok: true, principal: auth.principal, bindingMode: (auth as { bindingMode?: string }).bindingMode };
}

/**
 * Authorise, meter, and record a metered inference. Separated from the model
 * call so a failure here is never mistaken for a serving failure, and so the
 * provider cannot bill without both passing every auth check AND self-verifying
 * the recount contract before signing.
 */
export function meterInference(args: {
  home: string;
  chainId: number;
  cfg: MeterConfig;
  request: {
    delegation: MeteredReadRequest["delegation"];
    bindingProof?: MeteredReadRequest["bindingProof"];
    revocationCheckpoint?: MeteredReadRequest["revocationCheckpoint"];
    maxMicroTrac?: number;
  };
  state: Parameters<typeof authoriseMeteredRead>[0]["state"];
  scheduleDigest: string;
  priceVectorDigest: string;
  nodeClass: string;
  settlementId: string;
  model: ModelResult;
  tokenizer: RecountTokenizer;
  specialTokenIds: number[];
  /** the deployment the node observed before serving; drift fails closed. */
  expectedBackendManifestDigest?: string;
  expectedTokenizerBundleDigest?: string;
  requesterKeyRef?: string;
  now?: number;
}): InferenceOutcome {
  // 1. Same auth as a read, but scoped to the inference route. The delegation
  //    must list "POST /api/metering/infer"; a read-only delegation cannot bill
  //    inference and vice-versa.
  const auth = authoriseMeteredRead({
    home: args.home, chainId: args.chainId, cfg: args.cfg,
    request: {
      delegation: args.request.delegation,
      bindingProof: args.request.bindingProof,
      sparql: "inference",                 // placeholder; the meter is token-based
      revocationCheckpoint: args.request.revocationCheckpoint,
    },
    state: args.state,
    route: "POST /api/metering/infer",
    nodeClass: args.nodeClass,
    settlementId: args.settlementId,
    scheduleDigest: args.scheduleDigest,
    priceVectorDigest: args.priceVectorDigest,
    now: args.now,
  });
  if (!auth.ok) return { ok: false, status: auth.status, code: auth.code, detail: auth.detail };

  // 2. Provider SELF-verifies the recount contract before signing. The buyer
  //    will repeat this independently — with HIS OWN tokenizer bundle, not this
  //    node's — before countersigning; a provider that cannot pass its own
  //    recount must not produce a leg.
  const evidence = buildInferenceEvidence({
    requestCanonical: args.model.requestCanonical,
    renderedPrompt: args.model.renderedPrompt,
    inputTokenIds: args.model.inputTokenIds,
    deliveredCompletion: args.model.deliveredCompletion,
    outputTokenIds: args.model.outputTokenIds,
    model: args.model.model,
    finishReason: args.model.finishReason,
    stopBoundary: args.model.stopBoundary,
  });
  const rc = verifyInferenceRecount({
    tokenizer: args.tokenizer,
    renderedPrompt: args.model.renderedPrompt,
    deliveredCompletion: args.model.deliveredCompletion,
    evidence,
    specialTokenIds: args.specialTokenIds,
    // The node pins the deployment it believes served this call; a restart or
    // config change between /manifest and /serve fails closed here.
    expectedBackendManifestDigest: args.expectedBackendManifestDigest,
    expectedTokenizerBundleDigest: args.expectedTokenizerBundleDigest,
  });
  if (!rc.ok) return { ok: false, status: 422, code: rc.code, detail: rc.detail };
  // Bo's DoS note (d14ebae0): a buyer CAN influence output — via prompts,
  // adversarial text, requested quoting, future tool payloads — so a
  // round-trip failure is an availability surface, not merely a provider risk.
  // The answer is bounds and fail-closed refusal with ZERO tab mutation, never
  // an approximate bill. Every refusal above returns before recordInferenceLeg,
  // so no balance moves on any rejected call.
  const lim = INFERENCE_POLICY_CANONICAL.limits;
  if (rc.inputTokens > lim.maxInputTokens || rc.outputTokens > lim.maxOutputTokens) {
    return { ok: false, status: 413, code: "E_OVER_POLICY_LIMIT", detail: `in=${rc.inputTokens}/${lim.maxInputTokens} out=${rc.outputTokens}/${lim.maxOutputTokens}` };
  }

  const cost = inferenceCostMicroTrac(rc.inputTokens, rc.outputTokens);
  const billable = !isExempt(auth.principal, args.cfg);

  // 3. Per-call ceiling: refuse rather than clamp (surface a pricing dispute).
  if (billable && args.request.maxMicroTrac !== undefined && cost > args.request.maxMicroTrac) {
    return { ok: false, status: 402, code: "E_OVER_BUYER_CEILING", detail: `inference prices at ${cost} µTRAC > ceiling ${args.request.maxMicroTrac}` };
  }

  // 4. Shadow mode: return a receipt that does NOT masquerade as a billed leg.
  if (!billable) {
    return {
      ok: true, status: 200, principal: auth.principal, billed: false, costMicroTrac: 0,
      leg: {
        legType: "inference-shadow", schemaVersion: evidence.schemaVersion,
        meter: { inputTokens: rc.inputTokens, outputTokens: rc.outputTokens, policyDigest: inferencePolicyDigest() },
        pricing: { wouldHaveCostMicroTrac: cost, unit: "mockTRAC-u" },
        evidence,
        note: "Metering only. This node is not billing this principal; no ledger entry was made.",
      },
      tab: { before: 0, after: 0 },
      settlement: { admissible: false, reason: "shadow mode — nothing to settle" },
    };
  }

  // 5. Bill it — the same signed, hash-chained, settlement-pending leg as a read.
  let leg: Record<string, unknown>;
  try {
    leg = recordInferenceLeg(args.home, {
      principal: auth.principal,
      inputTokens: rc.inputTokens,
      outputTokens: rc.outputTokens,
      costMicroTrac: cost,
      policyDigest: inferencePolicyDigest(),
      evidence: evidence as unknown as Record<string, unknown>,
      requesterKeyRef: args.requesterKeyRef,
    }) as unknown as Record<string, unknown>;
  } catch (e: unknown) {
    const m = String((e as Error)?.message ?? e);
    return { ok: false, status: m.includes("INSUFFICIENT") || m.includes("EXPIRED") ? 402 : 500, code: m.slice(0, 64) };
  }

  const tab = leg.tab as { before: number; after: number };
  return {
    ok: true, status: 200, principal: auth.principal, billed: true,
    costMicroTrac: (leg.pricing as { costMicroTrac: number }).costMicroTrac,
    leg, tab,
    settlement: { admissible: false, reason: "pending buyer countersignature (D14)" },
  };
}
