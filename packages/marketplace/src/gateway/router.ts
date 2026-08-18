// Buyer gateway — private-by-purpose. Local consumers (Odysseus, scripts)
// spend the buyer's tab through nsm_k_… keys; the gateway signs upstream
// requests with the buyer wallet, RECOUNTS every returned leg before
// countersigning (the veto runs in the machine path, not as an afterthought),
// and books usage to the key's sub-ledger.
//
//   GET  /gateway/v1/models           funded offerings, badged ⛓/☁
//   POST /gateway/v1/chat/completions
//   POST /gateway/v1/query
//   POST /gateway/v1/keys             mint (loopback only)
//   POST /gateway/v1/keys/:id/revoke  (loopback only)
//
// Agent-visible failures: 401 revoked/unknown/expired/scope · 402 budget or
// unfunded tab · 429 rps.
import { authorizeKey, authorizeOperatorImplicit, mintKey, revokeKey, listKeys, recordKeyUsage, type KeyScopes, type KeyVerdict } from "./keys.js";
import { verifyInferenceLegV3, verifyQueryLegV3, type OfferingExpectation } from "../buyer/recount.js";
import type { BuyerClient } from "../buyer/client.js";
import type { BpeEngine } from "../buyer/bpe.js";

export interface GatewayOffering {
  id: string;
  modelId: string;
  provenanceClass: "weights-pinned" | "upstream-claimed";
  expectation: OfferingExpectation;
  engine: BpeEngine;
}

export interface GatewayDeps {
  home: string;                       // buyer marketplace namespace
  client: BuyerClient;
  offerings: Map<string, GatewayOffering>;   // by modelId
  countQuads: (body: string) => number;
  log: (line: string) => void;
  /** true when the caller is the node's operator (loopback / node token) —
   *  routes their spend through the implicit key instead of an nsm_k_. */
  isOperator?: (req: Req) => boolean;
}

type Req = { method?: string; url?: string; headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } };
type Res = { headersSent: boolean; writableEnded: boolean; writeHead(s: number, h?: Record<string, string>): unknown; end(b?: string): unknown };
function send(res: Res, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(s)) });
  res.end(s);
}
async function readBodyBuf(req: Req & AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 2_000_000) throw new Error("E_BODY_TOO_LARGE"); chunks.push(c); }
  return Buffer.concat(chunks);
}
const isLoopback = (req: Req) => {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
};

export async function handleGateway(deps: GatewayDeps, req: Req & AsyncIterable<Buffer>, res: Res, path: string, basePath: string): Promise<boolean> {
  if (!path.startsWith(basePath + "/gateway/v1/")) return false;
  const sub = path.slice((basePath + "/gateway/v1").length);
  const method = (req.method ?? "GET").toUpperCase();

  // ── key admin: loopback only (never a remote surface) ──
  if (sub === "/keys" && method === "POST") {
    if (!isLoopback(req)) { send(res, 403, { error: "E_LOOPBACK_ONLY" }); return true; }
    const body = await readBodyBuf(req);
    let scopes: KeyScopes;
    try {
      const p = JSON.parse(body.toString("utf8")) as Partial<KeyScopes>;
      scopes = {
        ...(typeof p.label === "string" && p.label ? { label: p.label.slice(0, 64) } : {}),
        budgetMicroTrac: Number(p.budgetMicroTrac ?? 0),
        expiresAt: p.expiresAt ?? null,
        modelAllowlist: p.modelAllowlist ?? null,
        allowQuery: p.allowQuery !== false,
        rps: Number(p.rps ?? 5),
      };
    } catch { send(res, 400, { error: "E_BODY" }); return true; }
    const minted = mintKey(deps.home, scopes);
    deps.log(`key-mint ${minted.record.keyId} budget=${scopes.budgetMicroTrac}µ`);
    // plaintext appears HERE exactly once and never again
    send(res, 200, { key: minted.plaintext, record: minted.record });
    return true;
  }
  const revokeMatch = sub.match(/^\/keys\/(nsm_k_[0-9a-f]{8})\/revoke$/);
  if (revokeMatch && method === "POST") {
    if (!isLoopback(req)) { send(res, 403, { error: "E_LOOPBACK_ONLY" }); return true; }
    const ok = revokeKey(deps.home, revokeMatch[1]);
    send(res, ok ? 200 : 404, ok ? { revoked: revokeMatch[1] } : { error: "E_KEY_UNKNOWN" });
    return true;
  }
  if (sub === "/keys" && method === "GET") {
    if (!isLoopback(req)) { send(res, 403, { error: "E_LOOPBACK_ONLY" }); return true; }
    send(res, 200, { keys: listKeys(deps.home) });   // hashes + prefixes only
    return true;
  }

  // ── consumer surface ──
  const presented = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const operatorCall = !presented.startsWith("nsm_k_") && (deps.isOperator?.(req) ?? false);
  const authorize = (a: { model?: string; isQuery: boolean; estCostMicroTrac: number }): KeyVerdict =>
    operatorCall ? authorizeOperatorImplicit(deps.home, a) : authorizeKey(deps.home, { presented, ...a });

  if (sub === "/models" && method === "GET") {
    const auth = authorize({ isQuery: false, estCostMicroTrac: 0 });
    if (!auth.ok) { send(res, auth.status, { error: auth.code }); return true; }
    send(res, 200, {
      object: "list",
      data: [...deps.offerings.values()].map((o) => ({
        id: o.modelId, object: "model",
        nsm: { offeringId: o.id, provenanceClass: o.provenanceClass, badge: o.provenanceClass === "weights-pinned" ? "⛓" : "☁" },
      })),
    });
    return true;
  }

  if (sub === "/chat/completions" && method === "POST") {
    const body = await readBodyBuf(req);
    let parsed: { model?: string; messages?: Array<{ role: string; content: string }>; max_tokens?: number; stream?: boolean };
    try { parsed = JSON.parse(body.toString("utf8")); } catch { send(res, 400, { error: "E_BODY" }); return true; }
    const off = parsed.model ? deps.offerings.get(parsed.model) : undefined;
    if (!off || !parsed.messages?.length) { send(res, 400, { error: "E_MODEL_UNKNOWN" }); return true; }
    // pre-authorize with a conservative estimate; final usage recorded at actual cost
    const est = 2048 * (off.expectation.perOutputTokenMicroTrac ?? 6) + 4096 * (off.expectation.perInputTokenMicroTrac ?? 2);
    const auth = authorize({ model: parsed.model, isQuery: false, estCostMicroTrac: est });
    if (!auth.ok) { send(res, auth.status, { error: auth.code }); return true; }

    if (parsed.stream === true) {
      // ── streaming pass-through: frames reach the consumer AS they arrive
      // from the seller, the chain verifies incrementally, and the recount
      // still runs before any countersign — verification mid-path, on stream.
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const w = res as unknown as { write(chunk: string): boolean };
      const up = await deps.client.chatStream(
        parsed.model!, parsed.messages, Math.min(Number(parsed.max_tokens ?? 256), 2048),
        (frame, seq) => { w.write(`data: ${JSON.stringify({ seq, frame: frame.toString("base64") })}\n\n`); },
      );
      const finish = (payload: unknown) => { w.write(`data: ${JSON.stringify(payload)}\n\n`); w.write("data: [DONE]\n\n"); res.end(); };
      if (up.status !== 200 || !up.body.nsm) { finish({ error: up.status === 402 ? "E_402" : "E_UPSTREAM", detail: up.body.error ?? up.status }); return true; }
      const sLeg = (up.body.nsm as { leg: Record<string, unknown> }).leg;
      if (!up.stream?.ok) {
        // chain broke — the counts/bytes no longer reproduce from the wire
        await deps.client.withhold(String(sLeg.legId), "E_RECOUNT_MISMATCH", up.stream?.detail ?? "stream chain unverifiable");
        deps.log(`gateway WITHHOLD ${sLeg.legId} E_RECOUNT_MISMATCH (stream: ${up.stream?.detail ?? "no claims"})`);
        finish({ error: "E_LEG_WITHHELD", code: "E_RECOUNT_MISMATCH", detail: up.stream?.detail, legId: sLeg.legId });
        return true;
      }
      const sCompletion = up.stream.bytes.toString("utf8");
      const sVerdict = verifyInferenceLegV3({
        leg: sLeg, deliveredBytes: up.stream.bytes,
        promptMessages: parsed.messages, offering: off.expectation, engine: off.engine,
        provenanceClass: off.provenanceClass,
      });
      if (sVerdict.decision === "withhold") {
        const code = sVerdict.violations[0].code;
        await deps.client.withhold(String(sLeg.legId), code, sVerdict.violations[0].detail);
        deps.log(`gateway WITHHOLD ${sLeg.legId} ${code} (streamed)`);
        finish({ error: "E_LEG_WITHHELD", code, violations: sVerdict.violations, legId: sLeg.legId });
        return true;
      }
      await deps.client.countersign(String(sLeg.legId));
      const sCost = Number((sLeg.pricing as { costMicroTrac: number }).costMicroTrac);
      recordKeyUsage(deps.home, { keyId: auth.record.keyId, legId: String(sLeg.legId), costMicroTrac: sCost, kind: "inference" });
      deps.log(`gateway countersign ${sLeg.legId} ${sCost}µ key=${auth.record.keyId} (streamed, ${up.stream.frames} frames)`);
      finish({ final: { ...up.body, nsm: { leg: sLeg, decision: "countersigned", keyId: auth.record.keyId, stream: { verified: true, frames: up.stream.frames } } } });
      void sCompletion;
      return true;
    }

    const upstream = await deps.client.chat(parsed.model!, parsed.messages, Math.min(Number(parsed.max_tokens ?? 256), 2048));
    if (upstream.status !== 200) { send(res, upstream.status === 402 ? 402 : 502, upstream.body); return true; }
    const leg = (upstream.body.nsm as { leg: Record<string, unknown> }).leg;
    const completion = String(((upstream.body.choices as Array<{ message: { content: string } }>)[0]).message.content);

    // ── the veto, in-path: recount before countersigning ──
    const verdict = verifyInferenceLegV3({
      leg, deliveredBytes: Buffer.from(completion, "utf8"),
      promptMessages: parsed.messages, offering: off.expectation, engine: off.engine,
      provenanceClass: off.provenanceClass,
    });
    if (verdict.decision === "withhold") {
      const code = verdict.violations[0].code;
      await deps.client.withhold(String(leg.legId), code, verdict.violations[0].detail);
      deps.log(`gateway WITHHOLD ${leg.legId} ${code}`);
      send(res, 502, { error: "E_LEG_WITHHELD", code, violations: verdict.violations, legId: leg.legId });
      return true;
    }
    await deps.client.countersign(String(leg.legId));
    const cost = Number((leg.pricing as { costMicroTrac: number }).costMicroTrac);
    recordKeyUsage(deps.home, { keyId: auth.record.keyId, legId: String(leg.legId), costMicroTrac: cost, kind: "inference" });
    deps.log(`gateway countersign ${leg.legId} ${cost}µ key=${auth.record.keyId}`);
    send(res, 200, { ...upstream.body, nsm: { leg, decision: "countersigned", keyId: auth.record.keyId } });
    return true;
  }

  if (sub === "/query" && method === "POST") {
    const body = await readBodyBuf(req);
    let parsed: { sparql?: string; offeringId?: string };
    try { parsed = JSON.parse(body.toString("utf8")); } catch { send(res, 400, { error: "E_BODY" }); return true; }
    if (!parsed.sparql) { send(res, 400, { error: "E_SPARQL" }); return true; }
    const off = [...deps.offerings.values()][0];
    if (!off) { send(res, 400, { error: "E_OFFERING_UNKNOWN" }); return true; }
    const auth = authorize({ isQuery: true, estCostMicroTrac: (off.expectation.queryFlatMicroTrac ?? 0) + 1000 * (off.expectation.perReturnedQuadMicroTrac ?? 0) });
    if (!auth.ok) { send(res, auth.status, { error: auth.code }); return true; }

    const upstream = await deps.client.query(parsed.sparql, parsed.offeringId);
    if (upstream.status !== 200) { send(res, upstream.status === 402 ? 402 : 502, upstream.body); return true; }
    const leg = (upstream.body.nsm as { leg: Record<string, unknown> }).leg;
    const resultBody = JSON.stringify(upstream.body.result);

    const verdict = verifyQueryLegV3({
      leg, deliveredBody: Buffer.from(resultBody, "utf8"),
      countQuads: deps.countQuads, offering: off.expectation,
    });
    if (verdict.decision === "withhold") {
      const code = verdict.violations[0].code;
      await deps.client.withhold(String(leg.legId), code, verdict.violations[0].detail);
      deps.log(`gateway WITHHOLD ${leg.legId} ${code}`);
      send(res, 502, { error: "E_LEG_WITHHELD", code, violations: verdict.violations, legId: leg.legId });
      return true;
    }
    await deps.client.countersign(String(leg.legId));
    const cost = Number((leg.pricing as { costMicroTrac: number }).costMicroTrac);
    recordKeyUsage(deps.home, { keyId: auth.record.keyId, legId: String(leg.legId), costMicroTrac: cost, kind: "query" });
    deps.log(`gateway countersign ${leg.legId} ${cost}µ key=${auth.record.keyId}`);
    send(res, 200, { ...upstream.body, nsm: { leg, decision: "countersigned", keyId: auth.record.keyId } });
    return true;
  }

  return false;
}
