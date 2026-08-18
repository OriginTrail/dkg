// The v3 seller public front — exactly the Appendix-A wire contract, mounted
// under `apiBase` (…/marketplace). Contract paths are relative to apiBase:
//
//   GET  /terms                       → 402 + signed quote (bootstrap)
//   POST /tab/open {txHash}           → deposit verified on OUR rpc; hash consumed
//   POST /v1/chat/completions         → metered; signed leg returned
//   POST /v1/query                    → metered; signed leg returned
//   POST /legs/:id/countersign        → buyer agreement recorded
//   POST /legs/:id/withhold           → reason code recorded
//   POST /close                       → buyer's signed close recorded
//   withdraw / settle / credit / release: ABSENT — no handler, daemon 404s
//
// Money truth lives in the ported Iteration-2 ledger (marketplace-namespaced
// journal). This module never mutates balances directly: deposits go through
// tabs.openTab → ledger.credit; serving debits go through recordInferenceLeg /
// recordReadLeg, which refuse overdraft (E_INSUFFICIENT_FUNDS) and replay
// deterministically.
//
// v3 read-leg pricing convention: query cost = flat + perReturnedQuad × quads.
// recordReadLeg's schedule is driven with units ≡ µTRAC and askMicroPer1k=1000
// so the journal debit equals the v3 price exactly, while the breakdown records
// the honest decomposition {base: flat, scope: perQuad×quads, M: quads}.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  canonicalize, providerSign, providerPublicPem, providerKeyId,
  recordInferenceLeg, recordReadLeg,
} from "../core/ledger.js";
import { buildInferenceEvidence } from "../core/inference-meter.js";
import { modelKaFromBinding, modelKaUrn } from "./model-ka.js";
import { verifyRequestAuth, bodyDigest } from "./auth.js";
import { legState, markDelivered, sweepExpiredDeliveries, idempoLookup, idempoRecord, DELIVERY_DEADLINE_MS } from "./lifecycle.js";
import { streamAccumulator, STREAM_SCHEME_VERSION } from "./streaming.js";
import { verifyDepositOnchain, openTab, tabById, txHashConsumed, tabQuantities } from "./tabs.js";
import { completeLlamaCpp, type LlamaCppBinding } from "./connector-llamacpp.js";
import { completeOpenAi, type OpenAiBinding, CHAT_TEMPLATE_CONSTANTS, templateConstantsDigest } from "./connector-openai.js";
import { completeCodexOAuth, type CodexOAuthBinding } from "./connector-codex-oauth.js";
import type { BpeEngine } from "../buyer/bpe.js";
import type { MarketplaceConfig, OfferingConfig } from "../config.js";

export const LEG_DOMAIN_V3 = "nsm:leg:v3";
export const QUOTE_DOMAIN_V3 = "nsm:quote:v3";
export const CLOSE_DOMAIN_V3 = "nsm:close:v3";
export const WITHHOLD_CODES = new Set([
  "E_BYTES_DIGEST", "E_RECOUNT_MISMATCH", "E_TOKENIZER_DRIFT", "E_OVERBILL", "E_LEG_SIGNATURE",
]);

export interface OfferingBinding {
  offering: OfferingConfig;
  binding: LlamaCppBinding | OpenAiBinding | CodexOAuthBinding;
  tokenizerBundleRef: string;   // KA UAL or content digest the offering pins
  offeringUal?: string;         // set once published
  /** counting engine over the declared public bundle (☁ classes) — the SAME
   *  algorithm the buyer recounts with, so honest legs match by construction */
  countEngine?: BpeEngine;
}

export interface FrontDeps {
  home: string;                                     // marketplace namespace dir
  cfg: MarketplaceConfig;
  offerings: Map<string, OfferingBinding>;          // by offering id AND modelId
  providerAddress: string;
  chainId: number;
  rpcUrl: string;
  tracContract?: string;
  /** SPARQL executor injected by the plugin (daemon-owned capability). Returns
   *  serialized bindings + the returned-quad count the meter bills on. */
  queryExecutor: (sparql: string) => Promise<{ body: string; returnedQuads: number }>;
  log: (line: string) => void;
}

// ── tiny http helpers (plugin-api's jsonResponse is for daemon routes; the
// front stays framework-free so it is testable without a daemon) ──
type Req = { method?: string; url?: string; headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } };
type Res = {
  headersSent: boolean; writableEnded: boolean;
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(body?: string): unknown;
};
function send(res: Res, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(s)) });
  res.end(s);
}

const legsPath = (home: string) => join(home, "legs.jsonl");
const closesPath = (home: string) => join(home, "closes.jsonl");
function appendLine(p: string, rec: Record<string, unknown>): void {
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(rec) + "\n");
}
function readLines(p: string): Array<Record<string, unknown>> {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; }
  });
}
export function legById(home: string, legId: string): Record<string, unknown> | null {
  // v3.5: lifecycle EVENT rows (delivered/voided) share the legId but are not
  // the leg — only type:"leg" rows carry the signed body + tabId. Returning
  // the last matching row of ANY type made a voided leg 404 on decision
  // attempts (found by drill A).
  const rows = readLines(legsPath(home)).filter((r) => r.legId === legId && r.type === "leg");
  return rows.length ? rows[rows.length - 1] : null;
}
export function legStatus(home: string, legId: string): { status: string; code?: string } {
  const rows = readLines(legsPath(home)).filter((r) => r.legId === legId);
  for (let i = rows.length - 1; i >= 0; i--) {
    const t = rows[i].type;
    if (t === "countersign") return { status: "countersigned" };
    if (t === "withhold") return { status: "withheld", code: String(rows[i].code) };
  }
  return { status: "open" };
}

// ── the signed quote (bootstrap; 402 carries it) ──
export function buildV3Quote(deps: FrontDeps): Record<string, unknown> {
  const offerings = [...deps.offerings.values()]
    .filter((v, i, a) => a.findIndex((x) => x.offering.id === v.offering.id) === i)
    .map((ob) => ({
      id: ob.offering.id,
      modelId: ob.binding.kind === "llamacpp" ? ob.binding.modelId : ob.binding.model,
      provenanceClass: ob.offering.provenanceClass,
      perInputTokenMicroTrac: ob.offering.perInputTokenMicroTrac,
      perOutputTokenMicroTrac: ob.offering.perOutputTokenMicroTrac,
      queryFlatMicroTrac: ob.offering.queryFlatMicroTrac,
      perReturnedQuadMicroTrac: ob.offering.perReturnedQuadMicroTrac,
      tokenizerBundleRef: ob.tokenizerBundleRef,
      // v3.5: transports the offering serves + the canonical Model KA it
      // references. The UI renders ENDPOINTS only from this signed quote —
      // never from KA literals (CLAUDE.md §7; kills v3's stale-apiBase class).
      transports: deps.cfg.transports ?? ["direct", "lane"],
      directUrl: deps.cfg.apiBase ?? null,
      modelRef: modelKaUrn(modelKaFromBinding(ob)),
      servingSettings:
        ob.binding.kind === "llamacpp" ? ob.binding.settings :
        ob.binding.kind === "openai" ? { templateConstantsDigest: ob.binding.templateConstantsDigest } :
        { templateConstantsDigest: templateConstantsDigest(), reasoningEffort: ob.binding.reasoningEffort,
          countingBasis: "local-verifiable", countingBundleSha256: ob.binding.tokenizerFileSha256 },
    }));
  const quote = {
    quoteVersion: "nsm-quote/v3",
    providerAddress: deps.providerAddress,
    chainId: deps.chainId,
    apiBase: deps.cfg.apiBase ?? null,
    offerings,
    providerKeyId: providerKeyId(deps.home),
    issuedAt: new Date().toISOString(),
  };
  const quoteDigest = "sha256:" + createHash("sha256").update(canonicalize(quote)).digest("hex");
  const signature = providerSign(deps.home, QUOTE_DOMAIN_V3, canonicalize(quote));
  return { quote, quoteDigest, signature, providerPublicPem: providerPublicPem(deps.home) };
}

// ── leg construction ──
function signLeg(home: string, body: Record<string, unknown>): Record<string, unknown> {
  const legId = "leg_" + createHash("sha256").update(canonicalize(body)).digest("hex").slice(0, 20);
  const withId = { ...body, legId };
  const signature = providerSign(home, LEG_DOMAIN_V3, canonicalize(withId));
  return { ...withId, signature };
}

async function readBodyBuf(req: Req & AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2_000_000) throw new Error("E_BODY_TOO_LARGE");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/**
 * Handle one request against the front. Returns true if the path belonged to
 * the marketplace surface (response written), false to fall through.
 * `basePath` is the mount prefix, e.g. "/marketplace".
 */
export async function handleFront(deps: FrontDeps, req: Req & AsyncIterable<Buffer>, res: Res, path: string, basePath: string): Promise<boolean> {
  if (!path.startsWith(basePath + "/")) return false;
  const sub = path.slice(basePath.length);        // "/terms", "/tab/open", …
  const method = (req.method ?? "GET").toUpperCase();

  // Settlement mutations are ABSENT by design: no route below matches them, so
  // the daemon's fallthrough 404s. (Probe fixture asserts this.)

  // ── bootstrap quote ──
  if (sub === "/terms" && method === "GET") {
    send(res, 402, buildV3Quote(deps));
    return true;
  }

  // ── open a tab from an on-chain deposit ──
  if (sub === "/tab/open" && method === "POST") {
    const body = await readBodyBuf(req);
    let parsed: { txHash?: string; identityKaUal?: string };
    try { parsed = JSON.parse(body.toString("utf8")); } catch { send(res, 400, { error: "E_BODY" }); return true; }
    if (!parsed.txHash || !/^0x[0-9a-fA-F]{64}$/.test(parsed.txHash)) { send(res, 400, { error: "E_TXHASH" }); return true; }
    if (txHashConsumed(deps.home, parsed.txHash)) { send(res, 409, { error: "E_TXHASH_CONSUMED" }); return true; }
    const check = await verifyDepositOnchain({
      rpcUrl: deps.rpcUrl, txHash: parsed.txHash, providerAddress: deps.providerAddress,
      tracContract: deps.tracContract,
    });
    if (!check.ok) { send(res, 402, { error: check.code, detail: check.detail }); return true; }
    const opened = openTab(deps.home, {
      txHash: parsed.txHash, from: check.from, amountMicroTrac: check.amountMicroTrac,
      identityKaUal: parsed.identityKaUal,
    });
    if (!opened.ok) { send(res, 409, { error: opened.code }); return true; }
    deps.log(`tab-open ${opened.tab.tabId} principal=${opened.tab.principal} deposit=${opened.tab.depositMicroTrac}µ`);
    send(res, 200, { tab: opened.tab });
    return true;
  }

  // Everything below requires an open tab + EIP-191 auth.
  const requireAuth = async (body: Buffer): Promise<{ tabId: string; principal: string } | null> => {
    const tabId = String(req.headers["x-nsm-tab"] ?? "");
    const tab = tabId ? tabById(deps.home, tabId) : null;
    if (!tab) { send(res, 401, { error: "E_TAB_UNKNOWN" }); return null; }
    const verdict = verifyRequestAuth(deps.home, {
      method, path: sub, body, tabId,
      headers: {
        address: String(req.headers["x-nsm-address"] ?? ""),
        nonce: String(req.headers["x-nsm-nonce"] ?? ""),
        signature: String(req.headers["x-nsm-signature"] ?? ""),
      },
      expectedAddress: tab.principal,
    });
    if (!verdict.ok) { send(res, 401, { error: verdict.code, detail: verdict.detail }); return null; }
    return { tabId, principal: tab.principal };
  };

  // ── metered inference ──
  if (sub === "/v1/chat/completions" && method === "POST") {
    const body = await readBodyBuf(req);
    const auth = await requireAuth(body);
    if (!auth) return true;
    // v3.5 lifecycle: sweep any pending-delivery legs past deadline (auto-void
    // + billing reversal) before serving new work — the ledger never carries a
    // stale provisional debit into a new serve.
    for (const v of sweepExpiredDeliveries(deps.home)) deps.log(`leg ${v} VOIDED (delivery deadline missed) — billing reversed`);
    // v3.5 idempotency: a retry with the same (tab, key) returns the SAME leg
    // and response — at-most-once billing across retries.
    const transport = String(req.headers["x-nsm-transport"] ?? "direct");
    const idemKey = String(req.headers["x-nsm-idempotency"] ?? "");
    if (idemKey) {
      const prior = idempoLookup(deps.home, auth.tabId, idemKey);
      if (prior) {
        const stored = (prior as unknown as { responseB64?: string }).responseB64;
        deps.log(`idempotent replay (tab=${auth.tabId} key=${idemKey.slice(0, 12)}…) → leg ${prior.legId}, no new billing`);
        if (stored) { send(res, 200, { ...JSON.parse(Buffer.from(stored, "base64").toString("utf8")), nsmReplay: true }); return true; }
        send(res, 200, { nsmReplay: true, legId: prior.legId, responseDigest: prior.responseDigest });
        return true;
      }
    }
    let parsed: { model?: string; messages?: Array<{ role: string; content: string }>; max_tokens?: number; stream?: boolean };
    try { parsed = JSON.parse(body.toString("utf8")); } catch { send(res, 400, { error: "E_BODY" }); return true; }
    const ob = parsed.model ? deps.offerings.get(parsed.model) : undefined;
    if (!ob || !parsed.messages?.length) { send(res, 400, { error: "E_MODEL_UNKNOWN" }); return true; }
    const maxTokens = Math.min(Math.max(1, Number(parsed.max_tokens ?? 256)), 2048);

    const priced = (inTok: number, outTok: number) =>
      inTok * ob.offering.perInputTokenMicroTrac + outTok * ob.offering.perOutputTokenMicroTrac;
    const pricingPolicy = {
      version: "nsm-pricing/v3",
      perInputTokenMicroTrac: ob.offering.perInputTokenMicroTrac,
      perOutputTokenMicroTrac: ob.offering.perOutputTokenMicroTrac,
    };
    const policyDigest = "sha256:" + createHash("sha256").update(canonicalize(pricingPolicy)).digest("hex");

    let evidence: Record<string, unknown>;
    let inputTokens: number, outputTokens: number, completion: string;

    if (ob.binding.kind === "llamacpp") {
      let served;
      try {
        served = await completeLlamaCpp(ob.binding, parsed.messages, maxTokens);
      } catch (e) {
        send(res, 502, { error: "E_CONNECTOR", detail: String((e as Error).message).slice(0, 120) });
        return true;   // no leg on serving failure
      }
      completion = served.completion;
      inputTokens = served.inputTokenIds.length;
      outputTokens = served.outputTokenIds.length;
      evidence = buildInferenceEvidence({
        requestCanonical: { model: parsed.model, messages: parsed.messages, max_tokens: maxTokens },
        renderedPrompt: served.renderedPrompt,
        inputTokenIds: served.inputTokenIds,
        deliveredCompletion: completion,
        outputTokenIds: served.outputTokenIds,
        model: {
          modelId: ob.binding.modelId,
          weightsDigest: ob.binding.ggufSha256,
          tokenizer: { bundleDigest: ob.binding.tokenizerBundleDigest, files: ob.binding.tokenizerFiles },
        } as never,
        finishReason: served.finishReason,
        stopBoundary: { maxTokens } as never,
      }) as unknown as Record<string, unknown>;
    } else if (ob.binding.kind === "codex-oauth") {
      const outcome = await completeCodexOAuth(ob.binding, parsed.messages, maxTokens);
      if (!outcome.ok) {
        // upstream failure (incl. auth) ⇒ downstream error, NO LEG
        send(res, outcome.status === 429 ? 429 : 502, { error: outcome.code });
        return true;
      }
      completion = outcome.result.completion;
      // ── bill on LOCALLY VERIFIABLE counts under the declared public bundle,
      // never upstream usage (reasoning tokens are invisible in delivered
      // bytes and would fail every honest buyer recount) ──
      const eng = ob.countEngine;
      if (!eng) { send(res, 500, { error: "E_COUNT_ENGINE_ABSENT" }); return true; }
      const per = CHAT_TEMPLATE_CONSTANTS;
      inputTokens = parsed.messages.reduce(
        (s2, m) => s2 + eng.encodeCount(m.content) + eng.encodeCount(m.role) + per.perMessageTokens, 0,
      ) + per.perReplyPrimerTokens;
      outputTokens = eng.encodeCount(completion);
      evidence = {
        schemaVersion: "nsm-cloud-evidence/v3",
        requestDigest: "sha256:" + createHash("sha256").update(canonicalize({ model: parsed.model, messages: parsed.messages, max_tokens: maxTokens })).digest("hex"),
        deliveredResponseBytesDigest: "sha256:" + createHash("sha256").update(Buffer.from(completion, "utf8")).digest("hex"),
        meteredCounts: { basis: "local-verifiable", bundle: ob.binding.tokenizerBundle, bundleSha256: ob.binding.tokenizerFileSha256 },
        upstreamUsage: { informational: true, ...outcome.upstreamUsage },
        tokenizerBundle: ob.binding.tokenizerBundle,
        templateConstantsDigest: templateConstantsDigest(),
      };
    } else {
      const outcome = await completeOpenAi(ob.binding, parsed.messages, maxTokens);
      if (!outcome.ok) {
        // upstream failure ⇒ downstream error, NO LEG (rule: buyer never pays for a failure)
        send(res, outcome.status === 429 ? 429 : 502, { error: outcome.code });
        return true;
      }
      completion = outcome.result.completion;
      inputTokens = outcome.upstreamUsage.prompt_tokens;
      outputTokens = outcome.upstreamUsage.completion_tokens;
      evidence = {
        schemaVersion: "nsm-cloud-evidence/v3",
        requestDigest: "sha256:" + createHash("sha256").update(canonicalize({ model: parsed.model, messages: parsed.messages, max_tokens: maxTokens })).digest("hex"),
        deliveredResponseBytesDigest: "sha256:" + createHash("sha256").update(Buffer.from(completion, "utf8")).digest("hex"),
        upstreamUsage: { inputTokens, outputTokens },
        tokenizerBundle: ob.binding.tokenizerBundle,
        templateConstantsDigest: ob.binding.templateConstantsDigest,
      };
    }

    const cost = priced(inputTokens, outputTokens);
    try {
      recordInferenceLeg(deps.home, {
        principal: auth.principal, inputTokens, outputTokens,
        costMicroTrac: cost, policyDigest, evidence,
      });
    } catch (e) {
      const code = String((e as Error).message);
      send(res, code === "E_INSUFFICIENT_FUNDS" ? 402 : 500, { error: code });
      return true;
    }
    const deadlineMs = DELIVERY_DEADLINE_MS[transport] ?? DELIVERY_DEADLINE_MS.direct;
    // v3.5 wire streaming: the SIGNED leg binds the exact frames the wire will
    // carry (chain root + count) alongside the classic bytes digest — a
    // tampered, dropped, or reordered frame breaks the chain mid-stream.
    let frames: Buffer[] | null = null;
    let streaming: Record<string, unknown> | undefined;
    if (parsed.stream === true) {
      const bytes = Buffer.from(completion, "utf8");
      frames = [];
      for (let i = 0; i < bytes.length; i += 48) frames.push(bytes.subarray(i, Math.min(i + 48, bytes.length)));
      if (frames.length === 0) frames.push(Buffer.alloc(0));
      const acc = streamAccumulator();
      for (const f of frames) acc.push(f);
      streaming = { scheme: STREAM_SCHEME_VERSION, streamChainRoot: acc.root(), frameCount: acc.frameCount() };
    }
    const leg = signLeg(deps.home, {
      type: "leg", legType: "inference", tabId: auth.tabId, principal: auth.principal,
      offeringId: ob.offering.id, provenanceClass: ob.offering.provenanceClass,
      meter: { inputTokens, outputTokens },
      pricing: { ...pricingPolicy, costMicroTrac: cost, policyDigest },
      evidence,
      ...(streaming ? { streaming } : {}),
      tokenizerBundleRef: ob.tokenizerBundleRef,
      transport, deliveryDeadline: new Date(Date.now() + deadlineMs).toISOString(),
      at: new Date().toISOString(),
    });
    appendLine(legsPath(deps.home), leg);
    deps.log(`leg ${leg.legId} inference ${inputTokens}/${outputTokens} tok ${cost}µ tab=${auth.tabId} [pending-delivery, ${transport}]`);
    const responseBody = {
      id: String(leg.legId), object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: completion }, finish_reason: "stop" }],
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
      nsm: { leg },
    };
    if (idemKey) {
      idempoRecord(deps.home, { tabId: auth.tabId, key: idemKey, legId: String(leg.legId),
        responseDigest: "sha256:" + createHash("sha256").update(JSON.stringify(responseBody)).digest("hex"),
        at: new Date().toISOString(),
        ...( { responseB64: Buffer.from(JSON.stringify(responseBody), "utf8").toString("base64") } as object ),
      } as never);
    }
    if (frames) {
      // SSE: every frame exactly as chained into the signed leg, then the
      // final event carrying the leg. Delivery is durable once the stream
      // ends — markDelivered only after the last byte is out.
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const w = res as unknown as { write(chunk: string): boolean };
      for (let i = 0; i < frames.length; i++) {
        w.write(`data: ${JSON.stringify({ seq: i, frame: frames[i].toString("base64") })}\n\n`);
      }
      w.write(`data: ${JSON.stringify({ final: responseBody })}\n\n`);
      w.write("data: [DONE]\n\n");
      res.end();
      if (transport === "direct") markDelivered(deps.home, String(leg.legId), "direct");
      return true;
    }
    send(res, 200, responseBody);
    // DIRECT transport: the response is written — delivery is durable from the
    // seller's side the moment the socket flushed. LANE: the executor marks
    // delivered only after the response KA publish succeeded.
    if (transport === "direct") markDelivered(deps.home, String(leg.legId), "direct");
    return true;
  }

  // ── metered query ──
  if (sub === "/v1/query" && method === "POST") {
    const body = await readBodyBuf(req);
    const auth = await requireAuth(body);
    if (!auth) return true;
    let parsed: { sparql?: string; offeringId?: string };
    try { parsed = JSON.parse(body.toString("utf8")); } catch { send(res, 400, { error: "E_BODY" }); return true; }
    if (!parsed.sparql) { send(res, 400, { error: "E_SPARQL" }); return true; }
    const ob = [...deps.offerings.values()].find((o) => o.offering.id === (parsed.offeringId ?? o.offering.id));
    if (!ob) { send(res, 400, { error: "E_OFFERING_UNKNOWN" }); return true; }

    let result: { body: string; returnedQuads: number };
    try {
      result = await deps.queryExecutor(parsed.sparql);
    } catch (e) {
      send(res, 502, { error: "E_QUERY_BACKEND", detail: String((e as Error).message).slice(0, 120) });
      return true;   // no leg on backend failure
    }
    const cost = ob.offering.queryFlatMicroTrac + ob.offering.perReturnedQuadMicroTrac * result.returnedQuads;
    try {
      recordReadLeg(deps.home, {
        principal: auth.principal,
        units: cost, askMicroPer1k: 1000,   // v3 convention: units ≡ µTRAC (see header)
        breakdown: { base: ob.offering.queryFlatMicroTrac, scope: ob.offering.perReturnedQuadMicroTrac * result.returnedQuads, M: result.returnedQuads, egress: 0, kib: 0, markers: {} },
        scopeQuads: result.returnedQuads,
        sparql: parsed.sparql,
        responseBody: result.body,
      });
    } catch (e) {
      const code = String((e as Error).message);
      send(res, code === "E_INSUFFICIENT_FUNDS" ? 402 : 500, { error: code });
      return true;
    }
    const qTransport = String(req.headers["x-nsm-transport"] ?? "direct");
    const leg = signLeg(deps.home, {
      type: "leg", legType: "query", tabId: auth.tabId, principal: auth.principal,
      offeringId: ob.offering.id, provenanceClass: ob.offering.provenanceClass,
      transport: qTransport,
      deliveryDeadline: new Date(Date.now() + (DELIVERY_DEADLINE_MS[qTransport] ?? DELIVERY_DEADLINE_MS.direct)).toISOString(),
      meter: { returnedQuads: result.returnedQuads },
      pricing: {
        version: "nsm-pricing/v3",
        queryFlatMicroTrac: ob.offering.queryFlatMicroTrac,
        perReturnedQuadMicroTrac: ob.offering.perReturnedQuadMicroTrac,
        costMicroTrac: cost,
      },
      evidence: {
        sparqlDigest: "sha256:" + createHash("sha256").update(parsed.sparql).digest("hex"),
        deliveredResponseBytesDigest: "sha256:" + createHash("sha256").update(Buffer.from(result.body, "utf8")).digest("hex"),
        returnedQuads: result.returnedQuads,
      },
      at: new Date().toISOString(),
    });
    appendLine(legsPath(deps.home), leg);
    deps.log(`leg ${leg.legId} query quads=${result.returnedQuads} ${cost}µ tab=${auth.tabId}`);
    send(res, 200, { result: JSON.parse(result.body), nsm: { leg } });
    if (qTransport === "direct") markDelivered(deps.home, String(leg.legId), "direct");
    return true;
  }

  // ── countersign / withhold ──
  const legAction = sub.match(/^\/legs\/(leg_[a-f0-9]{20})\/(countersign|withhold)$/);
  if (legAction && method === "POST") {
    const body = await readBodyBuf(req);
    const auth = await requireAuth(body);
    if (!auth) return true;
    const [, legId, action] = legAction;
    const leg = legById(deps.home, legId);
    if (!leg || leg.tabId !== auth.tabId) { send(res, 404, { error: "E_LEG_UNKNOWN" }); return true; }
    // v3.5 lifecycle: decisions are only legal FROM `delivered`. A pending leg
    // cannot be countersigned OR withheld (v3's gray case), and a voided leg is
    // final — its billing was already reversed.
    const ls = legState(deps.home, legId);
    if (ls.state === "pending-delivery") { send(res, 409, { error: "E_LEG_PENDING_DELIVERY", deadline: ls.deadline }); return true; }
    if (ls.state === "voided") { send(res, 409, { error: "E_LEG_VOIDED" }); return true; }
    if (ls.state !== "delivered") { send(res, 409, { error: "E_LEG_DECIDED", state: ls.state }); return true; }
    if (action === "withhold") {
      let parsed: { code?: string; detail?: string };
      try { parsed = JSON.parse(body.toString("utf8")); } catch { parsed = {}; }
      if (!parsed.code || !WITHHOLD_CODES.has(parsed.code)) { send(res, 400, { error: "E_WITHHOLD_CODE", allowed: [...WITHHOLD_CODES] }); return true; }
      appendLine(legsPath(deps.home), { type: "withhold", legId, tabId: auth.tabId, code: parsed.code, detail: String(parsed.detail ?? "").slice(0, 300), at: new Date().toISOString() });
      deps.log(`withhold ${legId} ${parsed.code}`);
      send(res, 200, { legId, status: "withheld", code: parsed.code });
    } else {
      appendLine(legsPath(deps.home), { type: "countersign", legId, tabId: auth.tabId, by: auth.principal, at: new Date().toISOString() });
      deps.log(`countersign ${legId}`);
      send(res, 200, { legId, status: "countersigned" });
    }
    return true;
  }

  // ── close ──
  if (sub === "/close" && method === "POST") {
    const body = await readBodyBuf(req);
    const auth = await requireAuth(body);
    if (!auth) return true;
    const q = tabQuantities(deps.home, auth.principal);
    // sweep first so a pending leg past deadline voids rather than blocking
    for (const v of sweepExpiredDeliveries(deps.home)) deps.log(`leg ${v} VOIDED at close-sweep — billing reversed`);
    const rows = readLines(legsPath(deps.home)).filter((r) => r.tabId === auth.tabId && r.type === "leg");
    const decided = rows.map((r) => ({ legId: r.legId, state: legState(deps.home, String(r.legId)).state }));
    const countersigned = decided.filter((d) => d.state === "countersigned");
    const withheld = decided.filter((d) => d.state === "withheld");
    const voided = decided.filter((d) => d.state === "voided");
    const open = decided.filter((d) => d.state === "pending-delivery" || d.state === "delivered");
    if (open.length) { send(res, 409, { error: "E_LEGS_UNDECIDED", open: open.map((o) => o.legId) }); return true; }
    // v3.5: the close attests the TOKEN volume it settles — catalog "settled
    // volume" renders ONLY from these countersigned, close-attested sums
    // (never self-reported traffic; catalog.volume.tip is literal truth)
    const csIds = new Set(countersigned.map((d) => String(d.legId)));
    const settledTokens = rows.filter((r) => csIds.has(String(r.legId))).reduce((s, r) => {
      const m = r.meter as { inputTokens?: number; outputTokens?: number } | undefined;
      return s + Number(m?.inputTokens ?? 0) + Number(m?.outputTokens ?? 0);
    }, 0);
    const closeBody = {
      type: "close", tabId: auth.tabId, principal: auth.principal,
      billedMicroTrac: q.billed,
      legsCountersigned: countersigned.length, legsWithheld: withheld.length, legsVoided: voided.length,
      settledTokens,
      at: new Date().toISOString(),
    };
    const closeDigest = "sha256:" + createHash("sha256").update(canonicalize(closeBody)).digest("hex");
    const providerSig = providerSign(deps.home, CLOSE_DOMAIN_V3, canonicalize(closeBody));
    appendLine(closesPath(deps.home), { ...closeBody, closeDigest, providerSig });
    deps.log(`close ${auth.tabId} billed=${q.billed}µ cs=${countersigned.length} wh=${withheld.length} digest=${closeDigest.slice(0, 18)}…`);
    send(res, 200, { close: closeBody, closeDigest, providerSig, quantities: q });
    return true;
  }

  // Anything else under the mount (including withdraw/settle/credit/release):
  // fall through — the daemon's default handling produces the 404. ABSENT, not
  // forbidden.
  return false;
}

// ── settlement election: threshold-gated, LOOPBACK-ONLY, never HTTP-mounted ──
export function providerMaySettleV3(a: { unsettledEarnedMicroTrac: number; gasMicroTrac: number; epsilon: number }): {
  allowed: boolean; thresholdMicroTrac: number;
} {
  const threshold = Math.ceil(a.gasMicroTrac / a.epsilon);
  return { allowed: a.unsettledEarnedMicroTrac > threshold, thresholdMicroTrac: threshold };
}
