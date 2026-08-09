// V2 — the metered-inference endpoint's testable core.
//
// Same lesson as http-core.ts, re-learned for this route: routes/metered-infer.ts
// imports the daemon's http-utils, which transitively drags in rdf-canonize,
// chain ABIs and websocket transports, so a standalone bundle of the ROUTE
// cannot be executed by a buyer. Bo asked (event 7ee42566) for a runnable
// route/e2e gate in the next immutable bundle — which is impossible while the
// decisions live behind that import graph.
//
// So the decisions live HERE, dependency-light and bundleable, with I/O
// injected; routes/metered-infer.ts is a thin adapter passing the daemon's real
// helpers. The core is what the gates exercise, and the core carries every
// fail-closed rule — including the pre-serve gate.
import { createHash } from "node:crypto";
import { canonicalize, loadMeterConfig } from "./ledger.js";
import { COEFFICIENTS_CANONICAL } from "./read-meter.js";
import { meterInference, preflightInference, type ModelResult } from "./metered-inference.js";
import type { RecountTokenizer } from "./inference-meter.js";
import type { CapabilityState } from "./capability.js";
import { signedBuildAttestation } from "./build-attestation.js";
import { buildFundedRunQuote } from "./inference-quote.js";
import { nextEpochFor, providerSign, providerPublicPem } from "./ledger.js";
import { COEFFICIENTS_CANONICAL as _COEF } from "./read-meter.js";
import { createHash as _ch } from "node:crypto";

const sha256 = (b: string) => createHash("sha256").update(b).digest("hex");

/** Everything the core needs from the outside world. */
export interface InferIo {
  json(status: number, body: unknown): void;
  readBody(): Promise<string>;
}

export interface InferRequest {
  method: string;
  path: string;
  /** resolved chain id, or null when the node cannot resolve one (fail closed). */
  chainId: number | null;
  home: string;
  /** raw query string ("?a=b"), for read-only quote lookups. */
  query?: string;
}

// ── the injected model backend (G1: Odysseus runs as a sidecar over HTTP) ────
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
    backendManifestDigest?: string;
    tokenizerBundleDigest?: string;
  }>;
}

let backend: InferenceBackend | null = null;
export function setInferenceBackend(b: InferenceBackend | null): void { backend = b; }
export function inferenceBackendConfigured(): boolean { return backend !== null; }

// Home-keyed capability state (module-global state must never leak across
// DKG_HOMEs — learned the hard way).
const capStates = new Map<string, Map<string, CapabilityState>>();
function capState(home: string, id: string): CapabilityState {
  if (!capStates.has(home)) capStates.set(home, new Map());
  const m = capStates.get(home)!;
  if (!m.has(id)) m.set(id, { spentMicroTrac: 0, window: { since: Date.now(), spentMicroTrac: 0 }, sequence: 0, revoked: false });
  return m.get(id)!;
}

/** Returns true when this request was a metered-inference route request. */
export async function handleInfer(req: InferRequest, io: InferIo): Promise<boolean> {
  // GET /api/metering/build — which code is actually serving.
  //
  // It carries NO metering auth: it takes no delegation, bills nothing and
  // touches no ledger state, because a buyer must be able to check the build
  // BEFORE committing money to it and provenance is not a secret. Note what
  // that does and does not mean: the NODE's own transport auth still applies,
  // so this is not a public endpoint — buyers reach it through the provider
  // front's allowlist with a scoped front token. An earlier comment here said
  // "unauthenticated", which was wrong about the deployed reality.
  //
  // Nothing returned is authority-bearing: digests, a signature, and the
  // provider PUBLIC key. The buyer verifies against the key he already holds.
  if (req.path === "/api/metering/build") {
    if (req.method !== "GET") { io.json(405, { error: "E_METHOD" }); return true; }
    io.json(200, signedBuildAttestation({ home: req.home }));
    return true;
  }
  // GET /api/metering/infer-terms?refundAddress=&provider= — the FULLY-BOUND
  // funded-run quote (Bo, deposit-stage). Read-only, ledger-free-of-mutation:
  // it reads the live nextEpoch for the principal and binds it, the inference
  // pricing, and the run envelope into one signed quote with its own digest.
  if (req.path === "/api/metering/infer-terms") {
    if (req.method !== "GET") { io.json(405, { error: "E_METHOD" }); return true; }
    const refundAddress = new URL("http://x" + (req.query ?? "")).searchParams.get("refundAddress");
    const provider = new URL("http://x" + (req.query ?? "")).searchParams.get("provider") ?? "";
    if (!refundAddress || !/^0x[0-9a-fA-F]{40}$/.test(refundAddress)) { io.json(400, { error: "E_MISSING_FIELD", required: ["refundAddress"] }); return true; }
    if (!provider) { io.json(503, { error: "E_NO_PROVIDER_WALLET" }); return true; }
    const scheduleDigest = _ch("sha256").update(canonicalize(_COEF)).digest("hex");
    const quote = buildFundedRunQuote({
      tabEpoch: nextEpochFor(req.home, refundAddress),   // the fresh epoch the deposit opens
      providerAddress: provider,
      refundAddress,
      scheduleDigest,
    });
    // Provider-sign the quote digest, so the buyer can bind it and later prove
    // the provider committed to these exact terms.
    const digest = quote.fundedRunTermsDigest;
    io.json(200, {
      quote,
      signature: providerSign(req.home, "odysseus-dkg:funded-run-quote:v1", digest),
      providerPublicKeyPem: providerPublicPem(req.home),
    });
    return true;
  }
  if (req.path !== "/api/metering/infer") return false;
  if (req.method !== "POST") { io.json(405, { error: "E_METHOD" }); return true; }

  const home = req.home;
  const cfg = loadMeterConfig(home);
  const scheduleDigest = sha256(canonicalize(COEFFICIENTS_CANONICAL as unknown as Record<string, unknown>));

  if (req.chainId === null || !Number.isFinite(req.chainId)) {
    io.json(503, { error: "E_CHAIN_UNRESOLVED" }); return true;
  }

  let body: Record<string, any>;
  try { body = JSON.parse((await io.readBody()) || "{}"); }
  catch { io.json(400, { error: "E_BAD_JSON" }); return true; }

  if (!body.delegation?.capabilityId) {
    io.json(400, { error: "E_MISSING_FIELD", required: ["delegation"] }); return true;
  }
  if (body.messages === undefined) {
    io.json(400, { error: "E_MISSING_FIELD", required: ["messages"] }); return true;
  }
  if (backend === null) {
    // No model wired. Fail closed with a distinct code rather than pretending to
    // serve — the buyer must never be billed for a call that never ran.
    io.json(503, { error: "E_NO_MODEL_BACKEND", detail: "no inference backend configured on this node" }); return true;
  }

  // PRE-SERVE GATE. Buyer-found (Bo, event 7ee42566): this route used to serve
  // first and authorise afterwards, so an unauthorised delegation could consume
  // a full model generation before being refused. The tab never moved, which is
  // exactly the wrong consolation — the compute was already spent. Authorisation
  // and every request-level bound now run BEFORE a single token is generated,
  // and the backend is not touched on any refusal.
  const state = capState(home, body.delegation.capabilityId);
  const pre = preflightInference({
    home, chainId: req.chainId, cfg,
    request: {
      delegation: body.delegation,
      bindingProof: body.bindingProof,
      revocationCheckpoint: body.revocationCheckpoint,
    },
    payload: { messages: body.messages, tools: body.tools, stream: body.stream, maxTokens: body.maxTokens, sampler: body.sampler },
    state,
    scheduleDigest,
    priceVectorDigest: body.priceVectorDigest ?? scheduleDigest,
    nodeClass: body.nodeClass ?? "dkg-edge-mainnet",
    settlementId: body.settlementId ?? "settle-main",
  });
  if (!pre.ok) { io.json(pre.status, { error: pre.code, detail: pre.detail }); return true; }

  // Only now does the model run. A serving failure is a 502 and is never
  // conflated with a metering/auth failure; we do not bill a failed generation.
  let served: Awaited<ReturnType<InferenceBackend["serve"]>>;
  try {
    served = await backend.serve({
      delegation: body.delegation,
      messages: body.messages, tools: body.tools, sampler: body.sampler,
      seed: body.seed, stops: body.stops, maxTokens: body.maxTokens,
      principal: String(body.delegation.tabPrincipal ?? ""),
    });
  } catch (e: unknown) {
    io.json(502, { error: "E_MODEL_SERVE_FAILED", detail: String((e as Error)?.message ?? e).slice(0, 200) }); return true;
  }

  const outcome = meterInference({
    home, chainId: req.chainId, cfg,
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
  if (!outcome.ok) { io.json(outcome.status, { error: outcome.code, detail: outcome.detail }); return true; }

  state.sequence += 1;
  // The completion is returned even in shadow mode, but `billed` is explicit so
  // a buyer never infers billing from the shape of the response.
  io.json(200, {
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
  return true;
}
