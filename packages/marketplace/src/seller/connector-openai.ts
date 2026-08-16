// Connector B — ☁ upstream-claimed resale of an OpenAI-compatible API.
//
// The upstream key lives ONLY in the secret store (a gitignored env file);
// it is read at call time, never logged, never echoed into legs or KAs, and
// the redaction fixture asserts its absence from every artifact.
//
// provenanceClass=upstream-claimed is honest labeling: token COUNTS are
// verifiable (public tokenizer bundle, e.g. o200k_base), the WEIGHTS are not —
// the model identity is a claim about the upstream, not a pin.
//
// Upstream 429 / 5xx / timeout ⇒ downstream error and NO LEG: a failure the
// buyer never pays for must never enter the ledger.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { OpenAiConnectorConfig } from "../config.js";
import type { CompletionResult } from "./connector-llamacpp.js";

export interface OpenAiBinding {
  kind: "openai";
  baseUrl: string;
  model: string;
  secretEnvFile: string;           // path only — the key itself is never held on the binding
  tokenizerBundle: string;         // public bundle name (o200k_base, cl100k_base, …)
  templateConstantsDigest: string; // chat-template constants pinned at connect
}

// The message-overhead constants for OpenAI-style chat rendering. Frozen here,
// digested into the offering; a leg claiming different constants is
// E_TOKENIZER_DRIFT at recount. (Values per OpenAI cookbook token counting.)
export const CHAT_TEMPLATE_CONSTANTS = Object.freeze({
  version: "openai-chat-count/v1",
  perMessageTokens: 3,
  perReplyPrimerTokens: 3,
});

export function templateConstantsDigest(): string {
  return "sha256:" + createHash("sha256")
    .update(JSON.stringify(CHAT_TEMPLATE_CONSTANTS))
    .digest("hex");
}

function readUpstreamKey(secretEnvFile: string): string {
  if (!existsSync(secretEnvFile)) throw new Error("E_UPSTREAM_KEY_ABSENT: secret env file missing");
  const line = readFileSync(secretEnvFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("OPENAI_API_KEY="));
  const key = line?.slice("OPENAI_API_KEY=".length).trim();
  if (!key) throw new Error("E_UPSTREAM_KEY_ABSENT: OPENAI_API_KEY not set in secret env file");
  return key;
}

export function connectOpenAi(cfg: OpenAiConnectorConfig): OpenAiBinding {
  // presence check only — the key is not attached to the binding
  readUpstreamKey(cfg.secretEnvFile);
  return {
    kind: "openai",
    baseUrl: cfg.baseUrl.replace(/\/$/, ""),
    model: cfg.model,
    secretEnvFile: cfg.secretEnvFile,
    tokenizerBundle: cfg.tokenizerBundle,
    templateConstantsDigest: templateConstantsDigest(),
  };
}

export type UpstreamOutcome =
  | { ok: true; result: CompletionResult; upstreamUsage: { prompt_tokens: number; completion_tokens: number } }
  | { ok: false; status: number; code: "E_UPSTREAM_RATELIMIT" | "E_UPSTREAM_ERROR" | "E_UPSTREAM_TIMEOUT" };

export async function completeOpenAi(
  b: OpenAiBinding,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
): Promise<UpstreamOutcome> {
  const key = readUpstreamKey(b.secretEnvFile);
  let res: Response;
  try {
    res = await fetch(b.baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: b.model, messages, max_tokens: maxTokens, temperature: 0, stream: false }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return { ok: false, status: 0, code: "E_UPSTREAM_TIMEOUT" };
  }
  if (res.status === 429) return { ok: false, status: 429, code: "E_UPSTREAM_RATELIMIT" };
  if (!res.ok) return { ok: false, status: res.status, code: "E_UPSTREAM_ERROR" };
  const out = (await res.json()) as {
    choices: Array<{ message: { content: string }; finish_reason: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const completion = out.choices[0]?.message?.content ?? "";
  return {
    ok: true,
    result: {
      completion,
      // ☁: token ids are not exposed by the upstream; counts come from usage and
      // are recounted downstream against the PUBLIC tokenizer bundle. Empty id
      // arrays are honest — the evidence carries counts + bundle ref instead.
      inputTokenIds: [],
      outputTokenIds: [],
      finishReason: out.choices[0]?.finish_reason ?? "stop",
      renderedPrompt: "",
    },
    upstreamUsage: {
      prompt_tokens: out.usage?.prompt_tokens ?? 0,
      completion_tokens: out.usage?.completion_tokens ?? 0,
    },
  };
}
