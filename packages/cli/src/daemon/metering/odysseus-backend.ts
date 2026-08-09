// V2 — the Odysseus/llama-server serving seam, as an InferenceBackend.
//
// G1 (license boundary): Odysseus is AGPL-3.0 and MUST stay a separate process
// reached only over HTTP. This file is the Apache-side HTTP CLIENT. It imports
// no model code and carries no tokenizer dependency; it calls a sidecar that
// serves the model and exposes its tokenizer, and returns the artifacts the
// receipt binds.
//
// The subtlety this file solves: verifyInferenceRecount re-encodes exactly two
// strings — the rendered prompt and the delivered completion — and it does so
// SYNCHRONOUSLY, but the sidecar tokenizer is over HTTP. So we pre-fetch both
// canonical re-encodings at serve time (async) and hand meterInference a
// synchronous REPLAY tokenizer keyed to those exact strings. The recount is
// still a genuine re-encode under the sidecar's tokenizer — not the node
// trusting the ids the sidecar claimed — because the replay values come from a
// SEPARATE /encode of the delivered bytes, so a sidecar that generated a
// non-canonical (e.g. padded) sequence is caught: model.outputTokenIds (what it
// generated) ≠ the canonical re-encode of the bytes it delivered.
import type { InferenceBackend } from "../routes/metered-infer.js";
import type { ModelResult } from "./metered-inference.js";
import type { ModelBinding, RecountTokenizer } from "./inference-meter.js";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean; status: number; text(): Promise<string>; json(): Promise<any>;
}>;

export interface OdysseusBackendConfig {
  /** e.g. http://127.0.0.1:8091 — the sidecar, LAN/loopback only (G4). */
  baseUrl: string;
  /** model identity the receipt binds; the sidecar echoes/confirms it. */
  model: ModelBinding;
  /** ids the billable output must never contain (Qwen2.5 control block). */
  specialTokenIds: number[];
  /** injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * A tokenizer that answers ONLY the exact strings the recount will re-encode,
 * from values fetched off the sidecar. Any other input is a bug (the recount
 * contract re-encodes precisely renderedPrompt and deliveredCompletion), so we
 * fail loud rather than silently returning [].
 */
function replayTokenizer(map: Map<string, number[]>): RecountTokenizer {
  return {
    encode(text: string): number[] {
      const hit = map.get(text);
      if (hit === undefined) throw new Error("E_TOKENIZER_REPLAY_MISS");
      return hit;
    },
    decode(): string {
      // verifyInferenceRecount never decodes (it re-encodes); if that changes,
      // this must be wired to the sidecar's /decode rather than left to throw.
      throw new Error("E_TOKENIZER_REPLAY_DECODE_UNSUPPORTED");
    },
  };
}

export function makeOdysseusBackend(cfg: OdysseusBackendConfig): InferenceBackend {
  const fetchImpl: FetchLike = cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const base = cfg.baseUrl.replace(/\/$/, "");

  const call = async (path: string, payload: unknown): Promise<any> => {
    const r = await fetchImpl(base + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`E_SIDECAR_${r.status}:` + (await r.text()).slice(0, 200));
    return r.json();
  };

  return {
    async serve(request) {
      // 1. Serve the model call. The sidecar renders the chat template, generates,
      //    and returns the rendered prompt, the generated token-ID sequences, and
      //    the delivered completion bytes.
      const s = await call("/serve", {
        messages: request.messages, tools: request.tools, sampler: request.sampler,
        seed: request.seed, stops: request.stops, maxTokens: request.maxTokens,
      });
      const renderedPrompt: string = String(s.renderedPrompt ?? "");
      const deliveredCompletion: string = String(s.deliveredCompletion ?? "");
      const inputTokenIds: number[] = (s.inputTokenIds ?? []).map(Number);
      const outputTokenIds: number[] = (s.outputTokenIds ?? []).map(Number);
      if (!renderedPrompt || inputTokenIds.length === 0) throw new Error("E_SIDECAR_EMPTY_PROMPT");

      // 2. Independently canonical-re-encode the two strings the recount checks.
      //    A SEPARATE /encode, not the /serve claim — this is what makes the
      //    recount adversarial to the sidecar's own generation.
      const [reInput, reOutput] = await Promise.all([
        call("/encode", { text: renderedPrompt, add_special_tokens: false }),
        call("/encode", { text: deliveredCompletion, add_special_tokens: false }),
      ]);
      const map = new Map<string, number[]>([
        [renderedPrompt, (reInput.ids ?? []).map(Number)],
        [deliveredCompletion, (reOutput.ids ?? []).map(Number)],
      ]);

      const model: ModelResult = {
        renderedPrompt, inputTokenIds, deliveredCompletion, outputTokenIds,
        model: cfg.model,
        requestCanonical: {
          messages: request.messages, tools: request.tools ?? null,
          sampler: request.sampler ?? null, seed: request.seed ?? null,
          stops: request.stops ?? null, maxTokens: request.maxTokens ?? null,
        },
      };
      return { model, tokenizer: replayTokenizer(map), specialTokenIds: cfg.specialTokenIds };
    },
  };
}
