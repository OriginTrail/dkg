// P5 serving core — executes a completion or query against an offering's
// binding and returns COUNTED results. No legs, no per-call signatures over
// billing: both seats count independently (the same algorithms), the
// hash-chained call log carries the evidence, checkpoints reconcile.
// Upstream/backend failure ⇒ error, nothing counted, nothing charged.

import { createHash } from "node:crypto";
import type { OfferingBinding } from "../seller/binding.js";
import { completeLlamaCpp } from "../seller/connector-llamacpp.js";
import { completeOpenAi } from "../seller/connector-openai.js";
import { completeCodexOAuth } from "../seller/connector-codex-oauth.js";
import { CHAT_TEMPLATE_CONSTANTS } from "../seller/connector-openai.js";
import { admissionUnits, deliveryUnits, type QueryCostSchedule, SCHEDULE_V1, DEFAULT_GUARDS, type QueryGuards } from "./query-cost.js";
import { canonicalize } from "../core/canonical.js";

const sha = (b: string | Buffer) => "sha256:" + createHash("sha256").update(b).digest("hex");

export interface ChatMessage { role: string; content: string }

export type ServeChatResult =
  | { ok: true; completion: string; inputTokens: number; outputTokens: number;
      requestDigest: string; responseDigest: string; finishReason?: string }
  | { ok: false; status: number; error: string; detail?: string };

/** Serve one completion. Counting is per binding class:
 *  ⛓ llamacpp — real token ids from the pinned tokenizer;
 *  ☁ codex-oauth — locally verifiable counts under the declared public
 *    bundle (never upstream usage — reasoning tokens are invisible in
 *    delivered bytes and would fail every honest recount);
 *  ☁ openai — upstream usage counts, class-labeled as provider-reported. */
export async function serveChat(ob: OfferingBinding, messages: ChatMessage[], maxTokens: number): Promise<ServeChatResult> {
  const requestDigest = sha(canonicalize({ model: ob.offering.id, messages: messages.map((m) => ({ role: m.role, content: m.content })), max_tokens: maxTokens }));
  try {
    if (ob.binding.kind === "llamacpp") {
      const served = await completeLlamaCpp(ob.binding, messages, maxTokens);
      // bill on bundle counts (both seats compute the identical formula from
      // bytes both hold); generation ids are serving detail only
      const eng = ob.countEngine;
      const per = CHAT_TEMPLATE_CONSTANTS;
      const inputTokens = eng
        ? messages.reduce((s2, m) => s2 + eng.encodeCount(m.content) + eng.encodeCount(m.role) + per.perMessageTokens, 0) + per.perReplyPrimerTokens
        : served.inputTokenIds.length;
      const outputTokens = eng ? eng.encodeCount(served.completion) : served.outputTokenIds.length;
      return { ok: true, completion: served.completion, inputTokens, outputTokens,
               requestDigest, responseDigest: sha(Buffer.from(served.completion, "utf8")),
               finishReason: served.finishReason };
    }
    if (ob.binding.kind === "codex-oauth") {
      const outcome = await completeCodexOAuth(ob.binding, messages, maxTokens);
      if (!outcome.ok) return { ok: false, status: outcome.status === 429 ? 429 : 502, error: outcome.code };
      const eng = ob.countEngine;
      if (!eng) return { ok: false, status: 500, error: "E_COUNT_ENGINE_ABSENT" };
      const per = CHAT_TEMPLATE_CONSTANTS;
      const inputTokens = messages.reduce(
        (s, m) => s + eng.encodeCount(m.content) + eng.encodeCount(m.role) + per.perMessageTokens, 0,
      ) + per.perReplyPrimerTokens;
      return { ok: true, completion: outcome.result.completion,
               inputTokens, outputTokens: eng.encodeCount(outcome.result.completion),
               requestDigest, responseDigest: sha(Buffer.from(outcome.result.completion, "utf8")) };
    }
    const outcome = await completeOpenAi(ob.binding, messages, maxTokens);
    if (!outcome.ok) return { ok: false, status: outcome.status === 429 ? 429 : 502, error: outcome.code };
    return { ok: true, completion: outcome.result.completion,
             inputTokens: outcome.upstreamUsage.prompt_tokens, outputTokens: outcome.upstreamUsage.completion_tokens,
             requestDigest, responseDigest: sha(Buffer.from(outcome.result.completion, "utf8")) };
  } catch (e) {
    return { ok: false, status: 502, error: "E_CONNECTOR", detail: String((e as Error).message).slice(0, 140) };
  }
}

export type ServeQueryResult =
  | { ok: true; body: string; returnedRows: number;
      admission: number; delivery: number; totalUnits: number;
      requestDigest: string; responseDigest: string }
  | { ok: false; aborted: true; reason: string; admission: number; requestDigest: string }
  | { ok: false; aborted?: false; status: number; error: string; detail?: string };

/** Serve one query under the pinned cost schedule + guards. Admission units
 *  are owed the moment the query is admitted; a guard abort keeps ONLY the
 *  admission cost; backend failure before admission charges nothing. */
export async function serveQuery(a: {
  sparql: string;
  executor: (sparql: string) => Promise<{ body: string; returnedQuads: number }>;
  schedule?: QueryCostSchedule;
  guards?: QueryGuards;
}): Promise<ServeQueryResult> {
  const schedule = a.schedule ?? SCHEDULE_V1;
  const guards = a.guards ?? DEFAULT_GUARDS;
  const requestDigest = sha(a.sparql);
  const admission = admissionUnits(a.sparql, schedule);
  let out: { body: string; returnedQuads: number };
  try {
    out = await Promise.race([
      a.executor(a.sparql),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("E_GUARD_TIMEOUT")), guards.timeoutMs)),
    ]);
  } catch (e) {
    const msg = String((e as Error).message);
    if (msg === "E_GUARD_TIMEOUT" || msg.startsWith("E_GUARD")) {
      return { ok: false, aborted: true, reason: msg, admission, requestDigest };
    }
    return { ok: false, status: 502, error: "E_QUERY_BACKEND", detail: msg.slice(0, 140) };
  }
  if (out.returnedQuads > guards.maxRows) {
    // row-cap guard: work beyond the cap is truncated — treated as an abort
    return { ok: false, aborted: true, reason: "E_GUARD_ROW_CAP", admission, requestDigest };
  }
  const delivery = deliveryUnits(out.returnedQuads, schedule);
  return { ok: true, body: out.body, returnedRows: out.returnedQuads,
           admission, delivery, totalUnits: admission + delivery,
           requestDigest, responseDigest: sha(out.body) };
}
