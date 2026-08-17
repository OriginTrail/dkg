// Connector C — ☁ upstream-claimed resale of the operator's OWN Codex
// subscription over OAuth (operator decision, CP3 2026-08-17):
//
//   · SCOPE CONSTRAINT (recorded, enforced by deployment topology): buyers are
//     the operator's own / same-team nodes (tailnet-only front). This connector
//     must NOT back offerings sold to genuine third parties — that would be
//     subscription resale, which upstream terms prohibit. The operator owns
//     this boundary; the report states it plainly.
//   · Credentials live ONLY in the Codex CLI's own store (~/.codex/auth.json),
//     written by `codex login` — the human authenticates; this module reads at
//     call time, refreshes on expiry via the standard OAuth refresh flow, and
//     writes refreshed tokens back to the same file. Tokens are never logged,
//     never attached to bindings, legs, KAs, or evidence (redaction fixture).
//   · METERING NEVER TRUSTS UPSTREAM USAGE: codex-class models bill reasoning
//     tokens that are invisible in the delivered bytes, so upstream counts
//     would make every honest leg fail the buyer's recount. Instead the front
//     bills on locally verifiable counts under the DECLARED public bundle
//     (o200k_base): input = template-constants arithmetic, output = BPE of the
//     delivered bytes — the same algorithm the buyer runs, so honest legs match
//     by construction. Upstream usage is recorded as informational evidence
//     only; reasoning-token cost is the operator's margin concern.
//   · Upstream 401 → one refresh + retry; 429/5xx/timeout → downstream error,
//     NO LEG.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CompletionResult } from "./connector-llamacpp.js";

export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_DEFAULT_BASE = "https://chatgpt.com/backend-api/codex";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

export interface CodexOAuthConnectorConfig {
  kind: "codex-oauth";
  /** Codex CLI auth store; written by `codex login`, never by hand */
  authFile: string;
  /** upstream base; default chatgpt backend codex path */
  baseUrl?: string;
  /** model string the offering CLAIMS (upstream-claimed class) */
  model: string;
  /** local path of the public counting bundle (.tiktoken) */
  tokenizerFile: string;
  /** public bundle name declared in the offering, e.g. o200k_base */
  tokenizerBundle: string;
  /** reasoning effort forwarded upstream (cost/latency knob) */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}

export interface CodexOAuthBinding {
  kind: "codex-oauth";
  baseUrl: string;
  model: string;
  authFile: string;                 // path only — tokens never held on the binding
  tokenizerBundle: string;
  tokenizerFileSha256: string;      // pins the exact counting bundle bytes
  reasoningEffort: "minimal" | "low" | "medium" | "high";
}

interface AuthStore {
  tokens?: { access_token?: string; refresh_token?: string; account_id?: string; id_token?: string };
  last_refresh?: string;
  [k: string]: unknown;
}

function readAuth(authFile: string): AuthStore {
  if (!existsSync(authFile)) throw new Error("E_CODEX_AUTH_ABSENT: run `codex login` on this machine");
  const a = JSON.parse(readFileSync(authFile, "utf8")) as AuthStore;
  if (!a.tokens?.access_token || !a.tokens?.refresh_token || !a.tokens?.account_id) {
    throw new Error("E_CODEX_AUTH_ABSENT: auth.json has no subscription tokens (API-key mode?)");
  }
  return a;
}

/** JWT exp (seconds) without verification — freshness heuristic only. */
function jwtExp(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch { return null; }
}

async function refreshTokens(authFile: string): Promise<AuthStore> {
  const a = readAuth(authFile);
  // NSM_CODEX_TOKEN_URL: fixture seam — gates stub the refresh endpoint; live
  // runs always use the real auth server.
  const tokenUrl = process.env.NSM_CODEX_TOKEN_URL ?? CODEX_TOKEN_URL;
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: a.tokens!.refresh_token,
      scope: "openid profile email",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`E_CODEX_REFRESH: token refresh → ${res.status}`);
  const t = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
  if (!t.access_token) throw new Error("E_CODEX_REFRESH: no access_token in refresh response");
  const updated: AuthStore = {
    ...a,
    tokens: {
      ...a.tokens,
      access_token: t.access_token,
      ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
      ...(t.id_token ? { id_token: t.id_token } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
  writeFileSync(authFile, JSON.stringify(updated, null, 2));
  return updated;
}

async function freshAuth(authFile: string): Promise<AuthStore> {
  const a = readAuth(authFile);
  const exp = jwtExp(a.tokens!.access_token!);
  // refresh proactively when expired or expiring within 5 minutes
  if (exp !== null && exp * 1000 < Date.now() + 300_000) return refreshTokens(authFile);
  return a;
}

export function connectCodexOAuth(cfg: CodexOAuthConnectorConfig): CodexOAuthBinding {
  readAuth(cfg.authFile);   // presence + shape check only; no network, no spend
  if (!existsSync(cfg.tokenizerFile)) throw new Error(`E_CODEX_TOKENIZER_ABSENT: ${cfg.tokenizerFile}`);
  const sha = "sha256:" + createHash("sha256").update(readFileSync(cfg.tokenizerFile)).digest("hex");
  return {
    kind: "codex-oauth",
    baseUrl: (cfg.baseUrl ?? CODEX_DEFAULT_BASE).replace(/\/$/, ""),
    model: cfg.model,
    authFile: cfg.authFile,
    tokenizerBundle: cfg.tokenizerBundle,
    tokenizerFileSha256: sha,
    reasoningEffort: cfg.reasoningEffort ?? "low",
  };
}

export type CodexOutcome =
  | { ok: true; result: CompletionResult; upstreamUsage: { input_tokens: number; output_tokens: number } }
  | { ok: false; status: number; code: "E_UPSTREAM_RATELIMIT" | "E_UPSTREAM_ERROR" | "E_UPSTREAM_TIMEOUT" | "E_UPSTREAM_AUTH" };

/** One completion over the Responses-API SSE stream. */
export async function completeCodexOAuth(
  b: CodexOAuthBinding,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
): Promise<CodexOutcome> {
  const doRequest = async (accessToken: string, accountId: string): Promise<Response> =>
    fetch(b.baseUrl + "/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
        session_id: randomUUID(),
      },
      body: JSON.stringify({
        model: b.model,
        instructions: "You are a helpful assistant.",
        input: messages.map((m) => ({
          type: "message",
          role: m.role,
          content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }],
        })),
        store: false,
        stream: true,
        max_output_tokens: maxTokens,
        reasoning: { effort: b.reasoningEffort },
      }),
      signal: AbortSignal.timeout(180_000),
    });

  let auth: AuthStore;
  try { auth = await freshAuth(b.authFile); }
  catch { return { ok: false, status: 401, code: "E_UPSTREAM_AUTH" }; }

  let res: Response;
  try {
    res = await doRequest(auth.tokens!.access_token!, auth.tokens!.account_id!);
    if (res.status === 401 || res.status === 403) {
      // one refresh + retry, then give up (no leg either way)
      try { auth = await refreshTokens(b.authFile); } catch { return { ok: false, status: res.status, code: "E_UPSTREAM_AUTH" }; }
      res = await doRequest(auth.tokens!.access_token!, auth.tokens!.account_id!);
    }
  } catch {
    return { ok: false, status: 0, code: "E_UPSTREAM_TIMEOUT" };
  }
  if (res.status === 429) return { ok: false, status: 429, code: "E_UPSTREAM_RATELIMIT" };
  if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, code: "E_UPSTREAM_AUTH" };
  if (!res.ok) return { ok: false, status: res.status, code: "E_UPSTREAM_ERROR" };

  // ── SSE accumulate: output_text deltas + the completed payload ──
  let text = "";
  let finishReason = "stop";
  let usage = { input_tokens: 0, output_tokens: 0 };
  try {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
        const type = String(ev.type ?? "");
        if (type === "response.output_text.delta" && typeof ev.delta === "string") text += ev.delta;
        if (type === "response.completed" || type === "response.incomplete") {
          const r = ev.response as { usage?: { input_tokens?: number; output_tokens?: number }; status?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> } | undefined;
          if (r?.usage) usage = { input_tokens: Number(r.usage.input_tokens ?? 0), output_tokens: Number(r.usage.output_tokens ?? 0) };
          if (type === "response.incomplete") finishReason = "length";
          // fall back to the completed payload's text if no deltas arrived
          if (!text && Array.isArray(r?.output)) {
            for (const item of r.output) {
              for (const c of item.content ?? []) if (c.type === "output_text" && c.text) text += c.text;
            }
          }
        }
        if (type === "response.failed") return { ok: false, status: 502, code: "E_UPSTREAM_ERROR" };
      }
    }
  } catch {
    return { ok: false, status: 0, code: "E_UPSTREAM_TIMEOUT" };
  }
  if (!text) return { ok: false, status: 502, code: "E_UPSTREAM_ERROR" };

  return {
    ok: true,
    result: { completion: text, inputTokenIds: [], outputTokenIds: [], finishReason, renderedPrompt: "" },
    upstreamUsage: usage,
  };
}
