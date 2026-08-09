// V2 — the Odysseus/llama-server serving seam, as an InferenceBackend.
//
// G1 (license boundary): Odysseus is AGPL-3.0 and MUST stay a separate process
// reached only over HTTP. This file is the Apache-side HTTP CLIENT. It imports
// no model code and carries no tokenizer dependency.
//
// Bo's blocker (event 1571496d): "a provider-controlled /encode can be
// internally self-consistent while /serve uses different weights, template,
// tokenizer, or configuration." Two changes answer it:
//
//   1. DEPLOYMENT PINNING. The client fetches /manifest (weights digest,
//      tokenizer BUNDLE digest, engine build, sampler, instanceId) BEFORE
//      serving, and /serve must echo the same manifest digest. A restart or a
//      config change between the two calls changes instanceId → the leg is
//      refused, never billed. The manifest digest is bound into the receipt, so
//      the buyer can see WHICH deployment produced the bytes he is paying for.
//
//   2. NO PROVIDER-SIDE INDEPENDENCE CLAIM. The /encode replay below is the
//      PROVIDER's own pre-sign check, and this file says so plainly. Genuine
//      independence lives on the buyer's side: he recounts from a tokenizer
//      bundle he fetched by `bundleDigest` and holds locally, calling nothing
//      here. That is why receipt-v0.5 carries the token-ID arrays and the bundle
//      digest — so his recount needs no endpoint of ours.
import type { InferenceBackend } from "../routes/metered-infer.js";
import type { ModelResult } from "./metered-inference.js";
import type { ModelBinding, RecountTokenizer, StopBoundary, BackendManifest } from "./inference-meter.js";
import { backendManifestDigest } from "./inference-meter.js";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean; status: number; text(): Promise<string>; json(): Promise<any>;
}>;

export interface OdysseusBackendConfig {
  /** e.g. http://127.0.0.1:9312 — the sidecar, LAN/loopback only (G4). */
  baseUrl: string;
  modelId: string;
  /** ids the billable output must never contain (Qwen2.5 control block). */
  specialTokenIds: number[];
  /** the tokenizer bundle the node expects; mismatch fails closed. */
  expectedTokenizerBundleDigest?: string;
  /** injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

/**
 * A tokenizer that answers ONLY the exact strings the recount re-encodes, from
 * values fetched off the sidecar. Any other input is a bug (the recount contract
 * re-encodes precisely renderedPrompt and deliveredCompletion), so we fail loud
 * rather than silently returning [].
 */
function replayTokenizer(enc: Map<string, number[]>, dec: Map<string, string>): RecountTokenizer {
  return {
    encode(text: string): number[] {
      const hit = enc.get(text);
      if (hit === undefined) throw new Error("E_TOKENIZER_REPLAY_MISS");
      return hit;
    },
    decode(ids: number[]): string {
      const hit = dec.get(JSON.stringify(ids));
      if (hit === undefined) throw new Error("E_TOKENIZER_REPLAY_DECODE_MISS");
      return hit;
    },
  };
}

/** Map a finish reason + requested stops onto an explicit stop boundary. */
export function stopBoundaryOf(finishReason: string, delivered: string, stops?: unknown): StopBoundary {
  if (finishReason === "length") return { kind: "length" };
  const list = Array.isArray(stops) ? stops.filter((s): s is string => typeof s === "string") : [];
  // llama-server truncates BEFORE the stop string, so a matched stop is the one
  // whose absence at the tail we can attribute; report it explicitly when a
  // single stop was requested, otherwise record that generation ended naturally.
  if (list.length && finishReason === "stop") {
    const matched = list.find((s) => !delivered.includes(s));
    if (matched !== undefined && list.length === 1) return { kind: "stop-sequence", match: matched };
    if (matched !== undefined) return { kind: "stop-sequence" };
  }
  if (finishReason === "stop") return { kind: "eos" };
  return { kind: "other" };
}

export function makeOdysseusBackend(cfg: OdysseusBackendConfig): InferenceBackend {
  const fetchImpl: FetchLike = cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const base = cfg.baseUrl.replace(/\/$/, "");

  const call = async (path: string, payload?: unknown): Promise<any> => {
    const r = await fetchImpl(base + path, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    if (!r.ok) throw new Error(`E_SIDECAR_${r.status}:` + (await r.text()).slice(0, 200));
    return r.json();
  };

  return {
    async serve(request) {
      // 0. Pin the deployment BEFORE serving. The digest is computed HERE over a
      //    field set this node defines — never taken from the provider's own
      //    self-reported digest, and never over whatever extra keys it sends.
      const raw = await call("/manifest");
      const manifest: BackendManifest = {
        instanceId: String(raw?.instanceId ?? ""),
        weightsDigest: String(raw?.weightsDigest ?? ""),
        tokenizerBundleDigest: String(raw?.tokenizerBundleDigest ?? ""),
        engineBuild: String(raw?.engineBuild ?? ""),
        samplerConfig: (raw?.samplerConfig ?? {}) as Record<string, unknown>,
        chatTemplateDigest: String(raw?.chatTemplateDigest ?? ""),
      };
      for (const k of ["instanceId", "weightsDigest", "tokenizerBundleDigest", "engineBuild", "chatTemplateDigest"] as const) {
        if (!manifest[k]) throw new Error(`E_MANIFEST_INCOMPLETE:${k}`);
      }
      const manifestDigest = backendManifestDigest(manifest);
      if (cfg.expectedTokenizerBundleDigest !== undefined && manifest.tokenizerBundleDigest !== cfg.expectedTokenizerBundleDigest) {
        throw new Error("E_TOKENIZER_BUNDLE_DRIFT");
      }

      // 1. Serve the model call.
      const s = await call("/serve", {
        messages: request.messages, tools: request.tools, sampler: request.sampler,
        seed: request.seed, stops: request.stops, maxTokens: request.maxTokens,
      });
      const renderedPrompt: string = String(s.renderedPrompt ?? "");
      const deliveredCompletion: string = String(s.deliveredCompletion ?? "");
      const inputTokenIds: number[] = (s.inputTokenIds ?? []).map(Number);
      const outputTokenIds: number[] = (s.outputTokenIds ?? []).map(Number);
      if (!renderedPrompt || inputTokenIds.length === 0) throw new Error("E_SIDECAR_EMPTY_PROMPT");

      // 2. The deployment must not have changed under us.
      if (s.manifestDigest !== manifestDigest) throw new Error("E_BACKEND_DRIFT");

      // 3. Canonical re-encode + round-trip decode, via calls SEPARATE from
      //    /serve. This is the provider's own pre-sign check — not a claim of
      //    independence; the buyer recounts from his own local bundle.
      const [reInput, reOutput] = await Promise.all([
        call("/encode", { text: renderedPrompt, add_special_tokens: false }),
        call("/encode", { text: deliveredCompletion, add_special_tokens: false }),
      ]);
      const outIds: number[] = (reOutput.ids ?? []).map(Number);
      const back = await call("/decode", { ids: outIds, skip_special_tokens: false });

      const enc = new Map<string, number[]>([
        [renderedPrompt, (reInput.ids ?? []).map(Number)],
        [deliveredCompletion, outIds],
      ]);
      const dec = new Map<string, string>([[JSON.stringify(outIds), String(back.text ?? "")]]);

      const model: ModelBinding = {
        modelId: cfg.modelId,
        weightsDigest: manifest.weightsDigest,
        tokenizerDigest: manifest.tokenizerBundleDigest,
        chatTemplateDigest: manifest.chatTemplateDigest,
        tokenizer: {
          bundleDigest: manifest.tokenizerBundleDigest,
          bundleFiles: (s.tokenizerBundleFiles ?? []) as string[],
          engine: String(s.tokenizerEngine ?? "unknown"),
          engineVersion: String(s.tokenizerEngineVersion ?? "unknown"),
        },
        backendManifestDigest: manifestDigest,
      };

      const result: ModelResult = {
        renderedPrompt, inputTokenIds, deliveredCompletion, outputTokenIds,
        model,
        requestCanonical: {
          messages: request.messages, tools: request.tools ?? null,
          sampler: request.sampler ?? null, seed: request.seed ?? null,
          stops: request.stops ?? null, maxTokens: request.maxTokens ?? null,
        },
        finishReason: String(s.finishReason ?? "stop"),
        stopBoundary: stopBoundaryOf(String(s.finishReason ?? "stop"), deliveredCompletion, request.stops),
      };
      return {
        model: result, tokenizer: replayTokenizer(enc, dec), specialTokenIds: cfg.specialTokenIds,
        backendManifestDigest: manifestDigest,
        tokenizerBundleDigest: manifest.tokenizerBundleDigest,
      };
    },
  };
}
