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
import { canonicalize, loadMeterConfig, legBySequence } from "./ledger.js";
import { COEFFICIENTS_CANONICAL } from "./read-meter.js";
import { meterInference, preflightInference, type ModelResult } from "./metered-inference.js";
import type { RecountTokenizer } from "./inference-meter.js";
import type { CapabilityState } from "./capability.js";
import { signedBuildAttestation } from "./build-attestation.js";
import { buildFundedRunQuote, FUNDED_RUN_QUOTE_DOMAIN, ENVELOPE_SCALE_POLICIES, ENVELOPE_SCALE_POLICY_VERSION } from "./inference-quote.js";
import { nextEpochFor, providerSign, providerPublicPem, providerKeyId } from "./ledger.js";
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
  /** the provider EVM address, resolved from NODE CONFIGURATION by the route
   *  adapter (ctx.opWallets), never from a caller-supplied value (Bo #4). */
  providerAddress?: string | null;
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
    if (!refundAddress || !/^0x[0-9a-fA-F]{40}$/.test(refundAddress)) { io.json(400, { error: "E_MISSING_FIELD", required: ["refundAddress"] }); return true; }
    // The provider address is the node's CONFIGURED operational wallet, passed in
    // by the route adapter (Bo #4). A caller-supplied `provider` value is ignored
    // entirely — the node never signs a quote naming a provider it does not
    // control. If the node has no operational wallet, it cannot quote.
    const provider = req.providerAddress ?? "";
    if (!provider || !/^0x[0-9a-fA-F]{40}$/.test(provider)) { io.json(503, { error: "E_NO_PROVIDER_WALLET" }); return true; }
    const scheduleDigest = _ch("sha256").update(canonicalize(_COEF)).digest("hex");
    // Optional envelope size (P2 3.1): strict decimal string, validated against
    // the CURRENT scale policy — anything else refuses with the allowed range
    // (never coerced, never silently clamped). Absent → the historical default.
    const callsRaw = new URL("http://x" + (req.query ?? "")).searchParams.get("calls");
    let calls: number | undefined;
    if (callsRaw !== null) {
      const scale = ENVELOPE_SCALE_POLICIES[ENVELOPE_SCALE_POLICY_VERSION];
      if (!/^\d{1,7}$/.test(callsRaw) || !Number.isSafeInteger(Number(callsRaw)) || Number(callsRaw) < scale.minCalls || Number(callsRaw) > scale.maxCalls) {
        io.json(400, { error: "E_ENVELOPE_SCALE", detail: `calls must be an integer in [${scale.minCalls}, ${scale.maxCalls}] (${ENVELOPE_SCALE_POLICY_VERSION})` });
        return true;
      }
      calls = Number(callsRaw);
    }
    const quote = buildFundedRunQuote({
      tabEpoch: nextEpochFor(req.home, refundAddress),   // the fresh epoch the deposit opens
      providerAddress: provider,
      refundAddress,
      scheduleDigest,
      calls,
    });
    // Provider-sign the quote digest under the shared domain constant, so the
    // buyer's verifier reconstructs the identical preimage and can prove the
    // provider committed to these exact terms with its pinned key.
    const digest = quote.fundedRunTermsDigest;
    io.json(200, {
      quote,
      signature: providerSign(req.home, FUNDED_RUN_QUOTE_DOMAIN, digest),
      // Both are returned so the buyer can (a) build the FundedQuoteCommitment
      // {quote, signature, providerKeyId} to embed in the countersigned opening,
      // and (b) verify the signature against the key. The node also re-verifies
      // this commitment against its OWN pinned key at openTab and credit.
      providerKeyId: providerKeyId(req.home),
      providerPublicKeyPem: providerPublicPem(req.home),
    });
    return true;
  }
  // POST /api/metering/leg/replay — buyer-authenticated, read-only recovery of a
  // served inference leg's exact delivered bytes (Bo, epoch-2 seq-1 recovery).
  //
  // Why this exists: the recount contract binds the bytes the BUYER received, and
  // there is deliberately no provider-asserted re-count — so if the buyer's copy
  // of the delivered completion is lost (a crash, or a first verify rejected under
  // the wrong leg domain before the bytes were persisted), it can neither
  // countersign nor withhold, because both need the exact signed leg + bytes and
  // the close endpoint exposes only hash/sequence/cost. The provider journal DOES
  // hold the full signed leg, but not the raw completion (only its digest). So
  // this endpoint returns the signed leg AND deterministically RE-SERVES the
  // committed request, then proves the reproduced bytes against the leg's own
  // serve-time-signed `deliveredResponseBytesDigest` before returning them.
  //
  // This is not a trust shortcut and not a free-inference oracle:
  //  • It bills NOTHING and mutates NO ledger state — no debit, no capability
  //    spend, no sequence advance. It is a pure read + a verify.
  //  • It can only ever return bytes that hash to an ALREADY-BILLED leg's
  //    committed digest. A caller cannot mine novel completions: if the re-served
  //    bytes don't match the leg's signed digest, the call is REFUSED and nothing
  //    is returned. You get back exactly the one completion you already paid for.
  //  • The buyer still verifies the provider signature over the leg under
  //    LEG_DOMAIN and recounts locally from the returned bytes under its own
  //    tokenizer bundle. The provider's word is never the basis of acceptance.
  if (req.path === "/api/metering/leg/replay") {
    if (req.method !== "POST") { io.json(405, { error: "E_METHOD" }); return true; }
    if (backend === null) { io.json(503, { error: "E_NO_MODEL_BACKEND", detail: "no inference backend configured on this node" }); return true; }
    let rbody: Record<string, any>;
    try { rbody = JSON.parse((await io.readBody()) || "{}"); }
    catch { io.json(400, { error: "E_BAD_JSON" }); return true; }
    const principal = String(rbody.principal ?? "");
    const sequence = Number(rbody.sequence);
    // Optional but STRONGLY advised: the leg `sequence` resets each epoch, so on a
    // tab that has rolled epochs (a re-deposit, a prior refund) sequence alone is
    // ambiguous. A buyer recovering "epoch 2, sequence 1" passes epoch:2 and can
    // never be handed a stale prior-epoch leg with the same sequence.
    const epoch = rbody.epoch === undefined ? undefined : Number(rbody.epoch);
    const request = rbody.request ?? {};
    if (!/^0x[0-9a-fA-F]{40}$/.test(principal) || !Number.isInteger(sequence) || sequence < 1) {
      io.json(400, { error: "E_MISSING_FIELD", required: ["principal", "sequence", "request"] }); return true;
    }
    if (epoch !== undefined && (!Number.isInteger(epoch) || epoch < 0)) {
      io.json(400, { error: "E_BAD_FIELD", detail: "epoch must be a non-negative integer" }); return true;
    }
    if (request.messages === undefined) {
      io.json(400, { error: "E_MISSING_FIELD", required: ["request.messages"] }); return true;
    }
    // The authoritative signed leg, byte-identical to what was appended at serve
    // time. This alone unblocks a lost-artifact withhold (it needs the full leg).
    const leg = legBySequence(req.home, principal, sequence, epoch);
    if (!leg) { io.json(404, { error: "E_LEG_NOT_FOUND", detail: `no leg at sequence ${sequence} for ${principal}` }); return true; }
    if ((leg as any).legType !== "inference") { io.json(409, { error: "E_LEG_NOT_INFERENCE", detail: "replay recovers inference legs only" }); return true; }
    const committedBytesDigest = (leg as any)?.evidence?.deliveredResponseBytesDigest;
    if (typeof committedBytesDigest !== "string") { io.json(409, { error: "E_LEG_NO_BYTES_DIGEST", detail: "leg omits deliveredResponseBytesDigest" }); return true; }

    // Re-serve the committed request. No preflight/meter is invoked, so this path
    // cannot debit or advance any counter — it only runs the model to reproduce
    // the delivered bytes. A serving failure is a 502, distinct from any refusal.
    let reserved: Awaited<ReturnType<InferenceBackend["serve"]>>;
    try {
      reserved = await backend.serve({
        delegation: request.delegation ?? {},
        messages: request.messages, tools: request.tools, sampler: request.sampler,
        seed: request.seed, stops: request.stops, maxTokens: request.maxTokens,
        principal,
      });
    } catch (e: unknown) {
      io.json(502, { error: "E_MODEL_SERVE_FAILED", detail: String((e as Error)?.message ?? e).slice(0, 200) }); return true;
    }
    const reproduced = reserved.model.deliveredCompletion;
    // Digest the exact UTF-8 bytes IDENTICALLY to how the leg committed them —
    // inference-meter uses `"sha256:" + hex(Buffer.from(deliveredCompletion,"utf8"))`.
    // The "sha256:" prefix matters: without it the compare below never matches.
    const reproducedBytesDigest = "sha256:" + _ch("sha256").update(Buffer.from(reproduced, "utf8")).digest("hex");
    if (reproducedBytesDigest !== committedBytesDigest) {
      // The deployment could not reproduce the exact delivered bytes for this leg
      // (a different request was supplied, or generation is not reproducible on
      // this backend). We refuse rather than hand back non-matching bytes: the
      // leg can then only be disputed/withheld → refunded, never mis-settled.
      io.json(409, {
        error: "E_REPLAY_NONDETERMINISTIC",
        detail: "re-served bytes do not match the leg's serve-time-signed digest",
        committedBytesDigest, reproducedBytesDigest,
      });
      return true;
    }
    io.json(200, {
      leg,                                   // full signed leg, incl providerSignature
      legDomain: "odysseus-dkg:read-leg:v0.3",  // the domain the leg signature is over
      deliveredCompletion: reproduced,       // exact bytes, proven == committed digest
      deliveredResponseBytesDigest: committedBytesDigest,
      renderedPrompt: reserved.model.renderedPrompt,  // convenience; buyer can re-derive it too
      reproduced: true,
      backendManifestDigest: reserved.backendManifestDigest,
      providerKeyId: providerKeyId(req.home),
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
  // The buyer names the funded-run quote this call spends against (either field
  // is accepted; they are equal by construction). A funded tab REQUIRES it and
  // enforces the quote's durable envelope; a non-funded tab ignores it.
  const requestQuoteDigest: string | undefined = body.fundedRunTermsDigest ?? body.quoteId;

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
    requestQuoteDigest,
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
    requestQuoteDigest,
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
