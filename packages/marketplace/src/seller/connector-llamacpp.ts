// Connector A — ⛓ weights-pinned local serving via llama.cpp.
//
// The node, not the operator's word, establishes what is served: the GGUF is
// hashed at connect time, the tokenizer bundle is digested file-by-file with
// the frozen tokenizerBundleDigest (same algorithm the buyer recount pins),
// and serving settings are recorded verbatim. Health checks go to loopback
// ONLY — a connector that resolves anywhere else refuses to connect.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tokenizerBundleDigest } from "../core/inference-meter.js";
import type { LlamaCppConnectorConfig } from "../config.js";

export interface LlamaCppBinding {
  kind: "llamacpp";
  baseUrl: string;
  modelId: string;                 // as reported by the server
  ggufSha256: string;              // sha256:… of the served weights file
  ggufBytes: number;
  tokenizerBundleDigest: string;   // frozen-algorithm digest over the bundle dir
  tokenizerFiles: string[];
  settings: { seed: number; temperature: number; ctx: number };
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

async function sha256File(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve("sha256:" + h.digest("hex")))
      .on("error", reject);
  });
}

export async function connectLlamaCpp(cfg: LlamaCppConnectorConfig): Promise<LlamaCppBinding> {
  if (!LOOPBACK.test(cfg.baseUrl.replace(/\/$/, ""))) {
    throw new Error(`E_CONNECTOR_NOT_LOOPBACK: llama.cpp health checks are loopback-only (got ${cfg.baseUrl})`);
  }
  if (!existsSync(cfg.ggufPath)) throw new Error(`E_CONNECTOR_GGUF_ABSENT: ${cfg.ggufPath}`);
  if (!existsSync(cfg.tokenizerDir)) throw new Error(`E_CONNECTOR_TOKENIZER_ABSENT: ${cfg.tokenizerDir}`);

  // health + identity from the server itself
  const res = await fetch(cfg.baseUrl.replace(/\/$/, "") + "/v1/models", { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`E_CONNECTOR_UNHEALTHY: /v1/models → ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  const modelId = body.data?.[0]?.id ?? "unknown";

  const files = readdirSync(cfg.tokenizerDir)
    .filter((f) => statSync(join(cfg.tokenizerDir, f)).isFile())
    .sort();
  const bundle = files.map((name) => ({ name, content: readFileSync(join(cfg.tokenizerDir, name)) }));

  return {
    kind: "llamacpp",
    baseUrl: cfg.baseUrl.replace(/\/$/, ""),
    modelId,
    ggufSha256: await sha256File(cfg.ggufPath),
    ggufBytes: statSync(cfg.ggufPath).size,
    tokenizerBundleDigest: tokenizerBundleDigest(bundle),
    tokenizerFiles: files,
    settings: cfg.settings,
  };
}

export interface CompletionResult {
  completion: string;
  inputTokenIds: number[];
  outputTokenIds: number[];
  finishReason: string;
  renderedPrompt: string;
}

/**
 * Serve one deterministic completion. Token ids come from the server's own
 * /tokenize (the same tokenizer the bundle pins) so counts are recountable.
 */
export async function completeLlamaCpp(b: LlamaCppBinding, messages: Array<{ role: string; content: string }>, maxTokens: number): Promise<CompletionResult> {
  const req = {
    model: b.modelId,
    messages,
    max_tokens: maxTokens,
    temperature: b.settings.temperature,
    seed: b.settings.seed,
    stream: false,
  };
  const res = await fetch(b.baseUrl + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`E_CONNECTOR_UPSTREAM: llama.cpp → ${res.status}`);
  const out = (await res.json()) as {
    choices: Array<{ message: { content: string }; finish_reason: string }>;
    __rendered_prompt?: string;
  };
  const completion = out.choices[0]?.message?.content ?? "";
  const finishReason = out.choices[0]?.finish_reason ?? "stop";

  // llama.cpp exposes /apply-template + /tokenize — recover the exact token ids.
  const tmpl = await fetch(b.baseUrl + "/apply-template", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }), signal: AbortSignal.timeout(10_000),
  });
  const renderedPrompt = tmpl.ok ? ((await tmpl.json()) as { prompt?: string }).prompt ?? "" : "";
  const tokenize = async (content: string): Promise<number[]> => {
    const r = await fetch(b.baseUrl + "/tokenize", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, add_special: false }), signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`E_CONNECTOR_TOKENIZE: ${r.status}`);
    return ((await r.json()) as { tokens: number[] }).tokens;
  };
  return {
    completion,
    inputTokenIds: renderedPrompt ? await tokenize(renderedPrompt) : [],
    outputTokenIds: await tokenize(completion),
    finishReason,
    renderedPrompt,
  };
}
