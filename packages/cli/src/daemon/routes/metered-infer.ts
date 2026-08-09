// V2 — POST /api/metering/infer : the capability-authenticated metered inference.
//
// Sibling of /api/metering/read, and deliberately separate for the same reason:
// it authenticates by delegation and bills the delegation's tabPrincipal, not the
// transport token holder. The model itself is NOT in this package. G1 (license
// boundary) requires Odysseus — AGPL-3.0 — to run only as a separate sidecar over
// HTTP; this Apache route calls an INJECTED backend that returns the served
// artifacts (rendered prompt, token-ID sequences, delivered bytes, model + a
// recount tokenizer). With no backend registered the route is 503, never a
// self-billed no-op.
//
// The route never trusts the backend's token counts: meterInference re-derives
// them from the artifacts under the Bo-ratified recount contract before any leg
// is signed. The backend is a serving convenience, not a billing oracle.
import type { RequestContext } from "./context.js";
import { jsonResponse, readBody, SMALL_BODY_BYTES } from "../http-utils.js";
import { createHash } from "node:crypto";
import { loadMeterConfig, canonicalize } from "../metering/ledger.js";
import { COEFFICIENTS_CANONICAL } from "../metering/read-meter.js";
import { meterInference, type ModelResult } from "../metering/metered-inference.js";
import type { RecountTokenizer } from "../metering/inference-meter.js";
import type { CapabilityState } from "../metering/capability.js";
import { chainIdOf } from "./metering.js";

const sha256 = (b: string) => createHash("sha256").update(b).digest("hex");
const meterHome = () => process.env.DKG_HOME ?? `${process.env.HOME}/.dkg`;

// ── the injected model backend (G1: Odysseus runs as a sidecar) ──────────────
// A backend serves the request and returns the exact artifacts a receipt binds,
// plus the tokenizer the recount runs under. It NEVER decides what is billed.
export interface InferenceBackend {
  serve(request: {
    delegation: Record<string, unknown>;
    messages: unknown;
    tools?: unknown;
    sampler?: unknown;
    seed?: unknown;
    stops?: unknown;
    maxTokens?: unknown;
    principal: string;
  }): Promise<{
    model: ModelResult; tokenizer: RecountTokenizer; specialTokenIds: number[];
    /** the deployment observed before serving; bound into the leg. */
    backendManifestDigest?: string;
    tokenizerBundleDigest?: string;
  }>;
}

let backend: InferenceBackend | null = null;
/** Piece 4 wires the Odysseus metered-proxy client here at daemon startup. */
export function setInferenceBackend(b: InferenceBackend | null): void { backend = b; }
export function inferenceBackendConfigured(): boolean { return backend !== null; }

// Home-keyed capability state, exactly as the read route (module-global state
// must never leak across DKG_HOMEs — learned the hard way).
const capStates = new Map<string, Map<string, CapabilityState>>();
function capState(home: string, id: string): CapabilityState {
  if (!capStates.has(home)) capStates.set(home, new Map());
  const m = capStates.get(home)!;
  if (!m.has(id)) m.set(id, { spentMicroTrac: 0, window: { since: Date.now(), spentMicroTrac: 0 }, sequence: 0, revoked: false });
  return m.get(id)!;
}

export async function handleMeteredInferRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path } = ctx;
  if (path !== "/api/metering/infer") return;
  if (req.method !== "POST") return jsonResponse(res, 405, { error: "E_METHOD" });

  const home = meterHome();
  const cfg = loadMeterConfig(home);
  const scheduleDigest = sha256(canonicalize(COEFFICIENTS_CANONICAL as unknown as Record<string, unknown>));

  const chainId = chainIdOf(ctx);
  if (chainId === null || !Number.isFinite(chainId)) {
    return jsonResponse(res, 503, { error: "E_CHAIN_UNRESOLVED" });
  }

  let body: Record<string, any>;
  try { body = JSON.parse((await readBody(req, SMALL_BODY_BYTES)) || "{}"); }
  catch { return jsonResponse(res, 400, { error: "E_BAD_JSON" }); }

  if (!body.delegation?.capabilityId) {
    return jsonResponse(res, 400, { error: "E_MISSING_FIELD", required: ["delegation"] });
  }
  if (body.messages === undefined) {
    return jsonResponse(res, 400, { error: "E_MISSING_FIELD", required: ["messages"] });
  }
  if (backend === null) {
    // No model wired. Fail closed with a distinct code rather than pretending
    // to serve — the buyer must never be billed for a call that never ran.
    return jsonResponse(res, 503, { error: "E_NO_MODEL_BACKEND", detail: "no inference backend configured on this node" });
  }

  // Serve the model call in the sidecar FIRST — a serving failure is a 502 and
  // is never conflated with a metering/auth failure. We do not bill on a failed
  // generation.
  const state = capState(home, body.delegation.capabilityId);
  let served: Awaited<ReturnType<InferenceBackend["serve"]>>;
  try {
    served = await backend.serve({
      delegation: body.delegation,
      messages: body.messages, tools: body.tools, sampler: body.sampler,
      seed: body.seed, stops: body.stops, maxTokens: body.maxTokens,
      principal: String(body.delegation.tabPrincipal ?? ""),
    });
  } catch (e: unknown) {
    return jsonResponse(res, 502, { error: "E_MODEL_SERVE_FAILED", detail: String((e as Error)?.message ?? e).slice(0, 200) });
  }

  const outcome = meterInference({
    home, chainId, cfg,
    request: {
      delegation: body.delegation,
      bindingProof: body.bindingProof,
      revocationCheckpoint: body.revocationCheckpoint,
      maxMicroTrac: body.maxMicroTrac,
    },
    state,
    scheduleDigest,
    priceVectorDigest: body.priceVectorDigest ?? scheduleDigest,
    nodeClass: body.nodeClass ?? "dkg-edge-mainnet",
    settlementId: body.settlementId ?? "settle-main",
    model: served.model,
    tokenizer: served.tokenizer,
    specialTokenIds: served.specialTokenIds,
    expectedBackendManifestDigest: served.backendManifestDigest,
    expectedTokenizerBundleDigest: served.tokenizerBundleDigest,
    requesterKeyRef: body.delegation.sessionPublicKeyPem ? "sha256:" + sha256(body.delegation.sessionPublicKeyPem) : undefined,
  });
  if (!outcome.ok) return jsonResponse(res, outcome.status, { error: outcome.code, detail: outcome.detail });

  state.sequence += 1;
  // The completion is returned even in shadow mode, but `billed` is explicit so
  // a buyer never infers billing from the shape of the response.
  return jsonResponse(res, 200, {
    completion: served.model.deliveredCompletion,
    metering: {
      principal: outcome.principal,
      billed: outcome.billed,
      costMicroTrac: outcome.costMicroTrac,
      tab: outcome.tab,
      settlement: outcome.settlement,
      leg: outcome.leg,
    },
  });
}
