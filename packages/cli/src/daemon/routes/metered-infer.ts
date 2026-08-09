// V2 — POST /api/metering/infer : thin adapter over metering/infer-http-core.
//
// Every decision lives in the core so a buyer can execute it standalone (this
// file's http-utils import drags in rdf-canonize, chain ABIs and websocket
// transports — the exact reason an earlier archive was unrunnable). The adapter
// does three things: resolve the chain id, hand the core a body reader and a
// JSON writer, and stay out of the way.
//
// It ALSO carries the operator's backend wiring (Gate I0 of the funded run,
// proposed at event f7a40bb0). Deliberately HERE and not in metering/*: this
// file is outside METERING_MODULE_MANIFEST, so wiring a backend does not move
// the audited build pin — the code that DECIDES what is billed is unchanged and
// still attests as sha256:27802835…; only the plumbing that connects a model to
// it is new, and it ships as its own audit artifact.
import type { RequestContext } from "./context.js";
import { jsonResponse, readBody, SMALL_BODY_BYTES } from "../http-utils.js";
import { handleInfer, setInferenceBackend, inferenceBackendConfigured } from "../metering/infer-http-core.js";
import { makeOdysseusBackend } from "../metering/odysseus-backend.js";
import { parseInferenceBackendConfig } from "./infer-wiring-config.js";
import { chainIdOf } from "./metering.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const meterHome = () => process.env.DKG_HOME ?? `${process.env.HOME}/.dkg`;

export {
  setInferenceBackend, inferenceBackendConfigured,
  type InferenceBackend,
} from "../metering/infer-http-core.js";

// ── operator-controlled backend wiring ───────────────────────────────────────
// $DKG_HOME/metering/inference-backend.json:
//   {
//     "baseUrl": "http://127.0.0.1:9312",          // loopback sidecar (G4)
//     "modelId": "Qwen/Qwen2.5-1.5B-Instruct",
//     "specialTokenIdRanges": [[151643, 151665]],   // never billable in output
//     "expectedTokenizerBundleDigest": "sha256:…"   // sidecar drift fails closed
//   }
// Absent file → the route stays 503 E_NO_MODEL_BACKEND, exactly as before this
// commit. A malformed file also stays 503 — a half-understood config must never
// produce a half-wired billing surface — and the reason is logged once, not
// silently swallowed on every request.
let wiringAttempted = false;
let wiringError: string | null = null;

function tryWireBackendFromConfig(home: string): void {
  if (inferenceBackendConfigured()) return;
  const f = join(home, "metering", "inference-backend.json");
  if (!existsSync(f)) { wiringAttempted = false; return; }   // may appear later; keep checking
  if (wiringAttempted) return;                               // parsed once; restart to re-read
  wiringAttempted = true;
  try {
    // Validation lives in infer-wiring-config.ts — a PURE module Bo's clean-room
    // verifier executes directly. His I0 block (fe9485f0) found four fail-open
    // defects in the inline predecessor; the parser now rejects them all, and a
    // rejection keeps the route unwired at 503, never "configured but degraded".
    const parsed = parseInferenceBackendConfig(JSON.parse(readFileSync(f, "utf8")));
    if (!parsed.ok) throw new Error(parsed.reason);
    const { baseUrl, modelId, specialTokenIds, expectedTokenizerBundleDigest, timeoutMs, maxConcurrent } = parsed.cfg;

    // ── transport hardening (buyer's I0 list, event 71f17798) ──
    //   * loopback re-checked on EVERY request against the LITERAL address, and
    //     redirects are hard errors — a compromised sidecar answering 302 must
    //     not turn the node into an SSRF proxy;
    //   * every sidecar call carries a hard timeout;
    //   * concurrency fails fast (E_BACKEND_BUSY → deterministic 502) instead
    //     of queueing unboundedly. The parser guarantees both numbers are
    //     finite integers in bounds, so the cap cannot be NaN-disabled.
    let inFlight = 0;
    const hardenedFetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      const u = new URL(url);
      if (u.protocol !== "http:" || u.hostname !== "127.0.0.1") throw new Error("E_NON_LOOPBACK_FETCH");
      return fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) }) as never;
    };
    const inner = makeOdysseusBackend({
      baseUrl, modelId, specialTokenIds,
      expectedTokenizerBundleDigest,
      fetchImpl: hardenedFetch as never,
    });
    setInferenceBackend({
      async serve(request) {
        if (inFlight >= maxConcurrent) throw new Error(`E_BACKEND_BUSY: ${inFlight} in flight, cap ${maxConcurrent}`);
        inFlight++;
        try { return await inner.serve(request); } finally { inFlight--; }
      },
    });
    console.log(`[metered-infer] backend wired: ${modelId} via ${baseUrl} (bundle ${expectedTokenizerBundleDigest.slice(0, 18)}…, timeout ${timeoutMs}ms, cap ${maxConcurrent})`);
  } catch (e: unknown) {
    wiringError = String((e as Error)?.message ?? e);
    console.error(`[metered-infer] inference-backend.json REJECTED, route stays 503: ${wiringError}`);
  }
}

export function inferenceWiringStatus(): { configured: boolean; rejectedReason: string | null } {
  return { configured: inferenceBackendConfigured(), rejectedReason: wiringError };
}

export async function handleMeteredInferRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path } = ctx;
  if (path !== "/api/metering/infer" && path !== "/api/metering/build" && path !== "/api/metering/infer-terms") return;

  const home = meterHome();
  tryWireBackendFromConfig(home);

  const rawQuery = (() => { try { return new URL(req.url ?? "", "http://x").search; } catch { return ""; } })();
  await handleInfer(
    { method: req.method ?? "GET", path, chainId: chainIdOf(ctx), home, query: rawQuery },
    {
      json: (status, body) => jsonResponse(res, status, body as Record<string, unknown>),
      readBody: () => readBody(req, SMALL_BODY_BYTES),
    },
  );
}
