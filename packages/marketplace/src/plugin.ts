// @origintrail-official/marketplace — NSM v5 route plugin: the subscription
// rail. The tab rail (deposit → spend → refund) is DELETED, not dormant:
// tab/deposit/refund/withdraw/settle/credit/release have no handlers here,
// so the daemon 404s them like any unknown path (probe-enforced).
//
// marketplace.enabled=false (default, incl. missing/malformed config) ⇒
// handle() returns untouched ⇒ every marketplace route is ABSENT.
import type { RoutePlugin, RequestContext } from "@origintrail-official/dkg/daemon/plugin-api";
import { loadMarketplaceConfig, marketplaceHome, type MarketplaceConfig } from "./config.js";
import { connectLlamaCpp, type LlamaCppBinding } from "./seller/connector-llamacpp.js";
import { connectOpenAi, type OpenAiBinding } from "./seller/connector-openai.js";
import { connectCodexOAuth, type CodexOAuthBinding } from "./seller/connector-codex-oauth.js";
import type { OfferingBinding } from "./seller/binding.js";
import { hfEngine, tiktokenEngine, type BpeEngine } from "./buyer/bpe.js";
import { tiktokenEngine as tk } from "./buyer/bpe.js";
import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Plan } from "./subs/objects.js";
import { activePlan, allowances, appendCallLog, planSummaryPct, readJournal, subsHome } from "./subs/journal.js";
import { buildPlan, purchasePlan, topUp, expirePeriod, requestSwitch, nextCycle } from "./subs/plan.js";
import { seedAsk, publishAsk, askInForce, queuedAsk, readAsks } from "./subs/asks.js";
import { admit, recordDelivery, recordProviderFailure } from "./subs/gateway.js";
import { serveChat, serveQuery, type ChatMessage } from "./subs/serve.js";
import { emitCheckpoint, verifyPeerCheckpoint, freshness, checkpointChain } from "./subs/checkpoint.js";
import { seatTotals, buildStatement, statementDigest, saveStatement, readStatements } from "./subs/statement.js";
import { evaluatePayment, type ObservedTransfer } from "./subs/payment-verify.js";
import { providerSign, providerPublicPem, canonicalize } from "./core/canonical.js";
import { authorizeOperatorImplicit, listKeys, keySpent, mintKey, authorizeKey } from "./gateway/keys.js";

const BASE = "/marketplace";
const dkgHome = () => process.env.DKG_HOME ?? `${process.env.HOME}/.dkg`;

function subsCfgStamp(): string {
  const p = join(marketplaceHome(dkgHome()), "subs-buyer.json");
  try { return existsSync(p) ? String(statSync(p).mtimeMs) : "none"; } catch { return "none"; }
}

// ── self-kick (carried from v3.5): mount() runs lazily on the first HTTP
// request; a quiet seller would otherwise never start its checkpoint
// emitters. The plugin pings its own operate/status until the daemon
// answers once. Fail-soft everywhere.
(function selfKick() {
  let attempts = 0;
  const timer = setInterval(() => {
    attempts++;
    if (attempts > 60) { clearInterval(timer); return; }
    try {
      const home = dkgHome();
      const portRaw = readFileSync(join(home, "api.port"), "utf8").trim();
      const port = Number(portRaw.split("\n")[0]);
      if (!Number.isFinite(port) || port <= 0) return;
      let token = "";
      try {
        token = readFileSync(join(home, "auth.token"), "utf8").split("\n")
          .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))[0] ?? "";
      } catch { /* token optional on loopback */ }
      fetch(`http://127.0.0.1:${port}${BASE}/operate/status`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(5_000),
      }).then((res) => { if (res.status !== 404) clearInterval(timer); })
        .catch(() => { /* daemon not up yet */ });
    } catch { /* api.port not written yet */ }
  }, 3_000);
  timer.unref?.();
})();

// ── buyer-side plan config: which sellers serve which offerings, and how to
// reach + recount them. Written by the composer flow; read fresh per request.
interface SubsBuyerCfg {
  buyer: string;                                  // buyer principal address
  periodMs: number;
  sellers: Record<string, { apiBase: string }>;   // seller address → endpoint
  offerings: Array<{
    offeringId: string; seller: string; unit: "tokens" | "query-units";
    bundlePath?: string; bundleKind?: "hf" | "tiktoken";   // buyer-side recount engine
  }>;
}
function readBuyerCfg(home: string): SubsBuyerCfg | null {
  const p = join(home, "subs-buyer.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as SubsBuyerCfg; } catch { return null; }
}

interface SellerDeps {
  home: string;
  cfg: MarketplaceConfig;
  offerings: Map<string, OfferingBinding>;
  providerAddress: string;
  queryExecutor: (sparql: string) => Promise<{ body: string; returnedQuads: number }>;
  log: (l: string) => void;
}

interface Mounted { seller: SellerDeps | null; loadedAt: number; configDigestish: string }
let mounted: Mounted | null = null;
let mountInFlight: Promise<Mounted> | null = null;

async function mount(cfg: MarketplaceConfig, ctx: RequestContext, log: (l: string) => void): Promise<Mounted> {
  const home = marketplaceHome(dkgHome());
  const offerings = new Map<string, OfferingBinding>();

  for (const off of cfg.offerings) {
    try {
      if (off.connector.kind === "llamacpp") {
        const binding: LlamaCppBinding = await connectLlamaCpp(off.connector);
        const ob: OfferingBinding = { offering: off, binding, tokenizerBundleRef: binding.tokenizerBundleDigest };
        offerings.set(off.id, ob);
        offerings.set(binding.modelId, ob);
        log(`offering ${off.id} ⛓ ${binding.modelId} gguf=${binding.ggufSha256.slice(0, 18)}… tok=${binding.tokenizerBundleDigest.slice(0, 18)}…`);
      } else if (off.connector.kind === "codex-oauth") {
        const binding: CodexOAuthBinding = connectCodexOAuth(off.connector);
        const ob: OfferingBinding = {
          offering: off, binding,
          tokenizerBundleRef: "public:" + binding.tokenizerBundle,
          countEngine: tk(readFileSync(off.connector.tokenizerFile, "utf8")),
        };
        offerings.set(off.id, ob);
        offerings.set(binding.model, ob);
        log(`offering ${off.id} ☁ codex-oauth ${binding.model} bundle=${binding.tokenizerBundle}@${binding.tokenizerFileSha256.slice(0, 18)}…`);
      } else {
        const binding: OpenAiBinding = connectOpenAi(off.connector);
        const ob: OfferingBinding = { offering: off, binding, tokenizerBundleRef: "public:" + binding.tokenizerBundle };
        offerings.set(off.id, ob);
        offerings.set(binding.model, ob);
        log(`offering ${off.id} ☁ ${binding.model} bundle=${binding.tokenizerBundle}`);
      }
    } catch (e) {
      // an offering that cannot connect is NOT served — fail closed per offering
      log(`offering ${off.id} NOT MOUNTED: ${String((e as Error).message).slice(0, 120)}`);
    }
  }

  // restore publish state — offeringUal drives the Operate PUBLISHED column
  try {
    const pub = JSON.parse(readFileSync(join(home, "published.json"), "utf8")) as Record<string, string>;
    for (const [id, ual] of Object.entries(pub)) {
      const ob = offerings.get(id);
      if (ob) ob.offeringUal = ual;
    }
  } catch { /* nothing persisted yet */ }

  let seller: SellerDeps | null = null;
  const providerAddress = cfg.providerAddress ?? null;
  if (providerAddress && offerings.size > 0) {
    seller = {
      home, cfg, offerings, providerAddress,
      queryExecutor: async (sparql: string) => {
        const token = [...ctx.validTokens][0];
        const res = await fetch(`http://127.0.0.1:${ctx.apiPortRef.value}/api/query`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ sparql }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`query backend ${res.status}`);
        const out = (await res.json()) as { result?: { bindings?: unknown[] } };
        const bindings = out.result?.bindings ?? [];
        return { body: JSON.stringify(out.result ?? {}), returnedQuads: bindings.length };
      },
      log,
    };
  }
  return { seller, loadedAt: Date.now(), configDigestish: JSON.stringify([cfg.enabled, cfg.offerings.length, providerAddress, cfg.apiBase ?? null, subsCfgStamp()]) };
}

// ── tiny http helpers ──────────────────────────────────────────────────────
type Req = RequestContext["req"];
type Res = RequestContext["res"];
async function readBody(req: Req & AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
function send(res: Res, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(s)) });
  res.end(s);
}
function isLocalOrToken(ctx: RequestContext): boolean {
  const remote = ctx.req.socket.remoteAddress ?? "";
  if (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") return true;
  const bearer = String(ctx.req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  return !!bearer && ctx.validTokens.has(bearer);
}

// seller-side enrollment store: which buyers subscribed this period
interface Enrollment { plan: Plan; verifiedPaymentIdentity: string; enrolledAt: string }
function enrollmentsPath(home: string): string { return join(subsHome(home), "enrollments.jsonl"); }
function readEnrollments(home: string): Enrollment[] {
  const p = enrollmentsPath(home);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Enrollment);
}

export const plugin: RoutePlugin = {
  name: "nsm-marketplace-v5",
  async handle(ctx: RequestContext): Promise<void> {
    const cfg = loadMarketplaceConfig(dkgHome());
    if (!cfg.enabled) return;                       // flag off ⇒ routes ABSENT
    const path = ctx.path;
    if (!path.startsWith(BASE + "/")) return;

    const log = (line: string) => console.log(`[marketplace] ${line}`);
    const digestish = JSON.stringify([cfg.enabled, cfg.offerings.length, cfg.providerAddress ?? null, cfg.apiBase ?? null, subsCfgStamp()]);
    if (!mounted || mounted.configDigestish !== digestish) {
      // single-flight (v3.5 bug #11): parallel mounts each hashed multi-GB
      // GGUFs and starved the event loop
      if (!mountInFlight) mountInFlight = mount(cfg, ctx, log).finally(() => { mountInFlight = null; });
      mounted = await mountInFlight;
    }

    const home = marketplaceHome(dkgHome());
    const req = ctx.req as Req & AsyncIterable<Buffer>;
    const res = ctx.res;
    const method = (ctx.req.method ?? "GET").toUpperCase();
    const now = new Date();

    // ── node-native upstream OAuth (carried verbatim from v3.5): tokens land
    // in the node's secret store, NEVER over HTTP. Operator-only.
    if (path === BASE + "/operate/upstream-auth/start" || path === BASE + "/operate/upstream-auth/status") {
      if (!isLocalOrToken(ctx)) { send(res, 401, { error: "E_TOKEN" }); return; }
      const { startCodexAuthFlow, flowStatus } = await import("./seller/oauth-flow.js");
      const secretPath = join(home, ".secrets", "codex-auth.json");
      const state = path.endsWith("/start") && method === "POST" ? startCodexAuthFlow(secretPath) : flowStatus();
      send(res, 200, { ...state, secretPath: path.endsWith("/start") ? secretPath : undefined });
      return;
    }

    // ── offering KA publish (carried from v3.5, incl. bug-#13 persistence) ──
    if (path === BASE + "/operate/publish" && method === "POST") {
      if (!isLocalOrToken(ctx)) { send(res, 401, { error: "E_TOKEN" }); return; }
      let out: Record<string, unknown>;
      try {
        const parsed = JSON.parse((await readBody(req)) || "{}") as { offeringId?: string; contextGraphId?: string };
        const ob = parsed.offeringId ? mounted.seller?.offerings.get(parsed.offeringId) : undefined;
        if (!ob || !mounted.seller) out = { error: "E_OFFERING_UNKNOWN" };
        else {
          const { publishOffering } = await import("./seller/offering.js");
          const token = cfg.nodeToken ?? [...ctx.validTokens][0] ?? "";
          const { scheduleDigest, SCHEDULE_V1 } = await import("./subs/query-cost.js");
          const cyc = nextCycle(home) - 1 || 1;
          const inForce = askInForce(home, ob.offering.id, mounted.seller.providerAddress, cyc) ?? undefined;
          out = await publishOffering(`http://127.0.0.1:${ctx.apiPortRef.value}`, token, ob, {
            providerAddress: mounted.seller.providerAddress,
            chainId: cfg.chainId ?? 8453,
            apiBase: cfg.apiBase ?? "",
            contextGraphId: parsed.contextGraphId ?? cfg.registryContextGraphId ?? "nsm-registry",
            ask: inForce ? { askMicroPerUnit: inForce.askMicroPerUnit, unit: inForce.unit, effectiveFromCycle: inForce.effectiveFromCycle } : undefined,
            revenueWallet: cfg.revenueWallet,
            queryCostScheduleRef: scheduleDigest(SCHEDULE_V1),
            cycle: cyc,
          }) as unknown as Record<string, unknown>;
          if (!out.error && typeof out.ual === "string" && parsed.offeringId) {
            ob.offeringUal = out.ual;
            const p = join(home, "published.json");
            let cur: Record<string, string> = {};
            try { cur = JSON.parse(readFileSync(p, "utf8")) as Record<string, string>; } catch { /* first publish */ }
            cur[parsed.offeringId] = out.ual;
            writeFileSync(p, JSON.stringify(cur, null, 2) + "\n");
          }
        }
      } catch (e) {
        out = { error: "E_PUBLISH", detail: String((e as Error).message).slice(0, 160) };
      }
      send(res, (out as { error?: unknown }).error ? 400 : 200, out);
      return;
    }

    // ── ask commitments (seller Operate: takes effect next cycle) ──────────
    if (path === BASE + "/operate/ask" && method === "POST") {
      if (!isLocalOrToken(ctx)) { send(res, 401, { error: "E_TOKEN" }); return; }
      try {
        const b = JSON.parse(await readBody(req)) as { offeringId: string; unit: "tokens" | "query-units"; askMicroPerUnit: number; effectiveFromCycle: number; currentCycle: number; seed?: boolean };
        const ask = { seller: mounted.seller?.providerAddress ?? cfg.providerAddress ?? "", offeringId: b.offeringId, unit: b.unit, askMicroPerUnit: b.askMicroPerUnit, effectiveFromCycle: b.effectiveFromCycle };
        send(res, 200, b.seed ? seedAsk(home, ask) : publishAsk(home, ask, b.currentCycle));
      } catch (e) { send(res, 400, { error: String((e as Error).message) }); }
      return;
    }

    // ── subscription wire: enroll (buyer → seller, payment-verified) ───────
    if (path === BASE + "/subs/enroll" && method === "POST") {
      try {
        const b = JSON.parse(await readBody(req)) as { plan: Plan; transfer: ObservedTransfer };
        if (!mounted.seller) { send(res, 503, { error: "E_NOT_SELLING" }); return; }
        const myLines = b.plan.allocations.filter((a) => a.seller.toLowerCase() === mounted!.seller!.providerAddress.toLowerCase());
        if (!myLines.length) { send(res, 400, { error: "E_NOT_MY_PLAN" }); return; }
        // frozen asks must match MY committed asks for the cycle — trust but verify
        for (const l of myLines) {
          const mine = askInForce(home, l.offeringId, mounted.seller.providerAddress, b.plan.cycle);
          if (!mine || mine.askMicroPerUnit !== l.frozenAskMicroPerUnit) {
            send(res, 400, { error: "E_ASK_MISMATCH", offeringId: l.offeringId }); return;
          }
        }
        const owed = myLines.reduce((s, l) => s + l.allocationMicroTrac, 0);
        const verdict = evaluatePayment(b.transfer, {
          sellerRevenueWallet: cfg.revenueWallet ?? mounted.seller.providerAddress,
          tracContract: cfg.tracContract ?? "0xA81a52B4dda010896cDd386C7fBdc5CDc835ba23", buyer: b.plan.buyer,
          confirmationDepth: cfg.confirmationDepth ?? 3, minimumMicroTrac: owed,
        });
        if (!verdict.ok) { send(res, 402, verdict); return; }
        writeFileSync(enrollmentsPath(home),
          readEnrollments(home).map((e) => JSON.stringify(e)).concat(JSON.stringify({
            plan: b.plan, verifiedPaymentIdentity: verdict.identity, enrolledAt: now.toISOString(),
          } satisfies Enrollment)).join("\n") + "\n");
        log(`enrolled ${b.plan.buyer.slice(0, 10)}… for ${myLines.length} offering(s), ${owed} µ verified`);
        send(res, 200, { ok: true, paymentIdentity: verdict.identity, providerPublicPem: providerPublicPem(home) });
      } catch (e) { send(res, 400, { error: "E_ENROLL", detail: String((e as Error).message).slice(0, 140) }); }
      return;
    }

    // ── subscription wire: serve (seller side; both-sides metering) ────────
    if ((path === BASE + "/subs/serve/chat" || path === BASE + "/subs/serve/query") && method === "POST") {
      if (!mounted.seller) { send(res, 503, { error: "E_NOT_SELLING" }); return; }
      try {
        const b = JSON.parse(await readBody(req)) as {
          buyer: string; offeringId: string; callId: string; keyId?: string;
          messages?: ChatMessage[]; maxTokens?: number; sparql?: string;
        };
        const enr = readEnrollments(home).filter((e) => e.plan.buyer.toLowerCase() === b.buyer.toLowerCase()
          && new Date(e.plan.startedAt) <= now && now < new Date(e.plan.expiresAt)).pop();
        if (!enr) { send(res, 402, { error: "no_active_plan" }); return; }
        const sellerAdm = admit(home, { plan: enr.plan, offeringId: b.offeringId });
        if (!sellerAdm.ok) { send(res, sellerAdm.status, sellerAdm.body); return; }
        const ob = mounted.seller.offerings.get(b.offeringId);
        if (!ob && path.endsWith("/chat")) { send(res, 400, { error: "E_OFFERING_UNKNOWN" }); return; }

        if (path.endsWith("/chat")) {
          const served = await serveChat(ob!, b.messages ?? [], b.maxTokens ?? 256);
          if (!served.ok) { send(res, served.status, { error: served.error, charged: 0, detail: served.detail }); return; }
          const units = served.inputTokens + served.outputTokens;
          recordDelivery(home, { plan: enr.plan, allowance: sellerAdm.allowance, callId: b.callId, units,
            unit: "tokens", requestDigest: served.requestDigest, responseDigest: served.responseDigest,
            keyId: b.keyId ?? "wire", now, sign: (d) => providerSign(home, "nsm:ckpt:v5", d) });
          send(res, 200, { completion: served.completion, inputTokens: served.inputTokens,
            outputTokens: served.outputTokens, requestDigest: served.requestDigest,
            responseDigest: served.responseDigest, units });
          return;
        }
        // query
        const served = await serveQuery({ sparql: b.sparql ?? "", executor: mounted.seller.queryExecutor });
        if (!served.ok && served.aborted) {
          recordDelivery(home, { plan: enr.plan, allowance: sellerAdm.allowance, callId: b.callId,
            units: served.admission, unit: "query-units", phase: "admission",
            requestDigest: served.requestDigest, keyId: b.keyId ?? "wire", now,
            sign: (d) => providerSign(home, "nsm:ckpt:v5", d) });
          send(res, 200, { aborted: true, reason: served.reason, unitsCharged: served.admission });
          return;
        }
        if (!served.ok) { send(res, served.status, { error: served.error, charged: 0 }); return; }
        recordDelivery(home, { plan: enr.plan, allowance: sellerAdm.allowance, callId: b.callId,
          units: served.totalUnits, unit: "query-units",
          requestDigest: served.requestDigest, responseDigest: served.responseDigest,
          keyId: b.keyId ?? "wire", now, sign: (d) => providerSign(home, "nsm:ckpt:v5", d) });
        send(res, 200, { body: served.body, returnedRows: served.returnedRows,
          units: served.totalUnits, admission: served.admission, delivery: served.delivery,
          requestDigest: served.requestDigest, responseDigest: served.responseDigest });
      } catch (e) { send(res, 400, { error: "E_SERVE", detail: String((e as Error).message).slice(0, 140) }); }
      return;
    }

    // ── subscription wire: checkpoint ingest (SWM/lane delivery lands here) ─
    if (path === BASE + "/subs/checkpoint" && method === "POST") {
      try {
        const b = JSON.parse(await readBody(req));
        const verdict = verifyPeerCheckpoint(home, b.checkpoint, { periodStartAt: b.periodStartAt });
        send(res, 200, verdict);
      } catch (e) { send(res, 400, { error: String((e as Error).message).slice(0, 140) }); }
      return;
    }

    // ── subscription wire: statement build/co-sign ─────────────────────────
    if (path === BASE + "/subs/statement" && method === "POST") {
      try {
        const b = JSON.parse(await readBody(req)) as { pair: string; periodId: string; periodStartAt: string; theirTotals: Record<string, number>; theirUnits: Record<string, "tokens" | "query-units"> };
        const st = buildStatement({ home, pair: b.pair, periodId: b.periodId, periodStartAt: b.periodStartAt,
          ours: seatTotals(home, b.pair, b.periodStartAt),
          theirs: { totals: b.theirTotals, units: b.theirUnits } });
        const digest = statementDigest(st);
        const signed = { ...st, sellerSignature: providerSign(home, "nsm:stmt:v5", digest) };
        saveStatement(home, signed);
        send(res, 200, { statement: signed, digest });
      } catch (e) { send(res, 400, { error: String((e as Error).message).slice(0, 140) }); }
      return;
    }

    // ── buyer loopback rails (operator-only): plan / meters / actions ──────
    if (path.startsWith(BASE + "/subs/") && !isLocalOrToken(ctx)) { send(res, 401, { error: "E_TOKEN" }); return; }

    if (path === BASE + "/subs/status" && method === "GET") {
      const bc = readBuyerCfg(home);
      const plan = activePlan(home, now);
      const meters = plan ? allowances(home, plan) : [];
      const activity = readJournal(home).filter((e) => e.kind === "consumed").slice(-20).reverse();
      const pairs = bc && plan ? [...new Set(plan.allocations.map((a) => `${plan.buyer.toLowerCase()}~${a.seller.toLowerCase()}`))] : [];
      send(res, 200, {
        plan, meters, summaryPct: plan ? planSummaryPct(home, plan) : null, activity,
        freshness: pairs.map((p) => ({ pair: p, ...freshness(home, p, now) })),
        statements: readStatements(home).slice(-5),
        keys: listKeys(home).map((k) => ({ ...k, spentMicroTrac: keySpent(home, k.keyId) })),
      });
      return;
    }

    if (path === BASE + "/subs/plan" && method === "POST") {
      try {
        const b = JSON.parse(await readBody(req)) as {
          buyer: string; periodMs: number; lines: { offeringId: string; seller: string; allocationMicroTrac: number }[];
          asks: Parameters<typeof buildPlan>[0]["asks"]; paymentTxBySeller: Record<string, string>;
        };
        const plan = buildPlan({ buyer: b.buyer, periodMs: b.periodMs, cycle: nextCycle(home),
          lines: b.lines, asks: b.asks, now, paymentTxBySeller: b.paymentTxBySeller });
        purchasePlan(home, plan);
        send(res, 200, { plan });
      } catch (e) { send(res, 400, { error: String((e as Error).message).slice(0, 140) }); }
      return;
    }

    if (path === BASE + "/subs/topup" && method === "POST") {
      try {
        const b = JSON.parse(await readBody(req)) as { offeringId: string; seller: string; microTrac: number; tx: string };
        const plan = activePlan(home, now);
        if (!plan) { send(res, 402, { error: "no_active_plan" }); return; }
        send(res, 200, { addedUnits: topUp(home, plan, b.offeringId, b.seller, b.microTrac, b.tx, now) });
      } catch (e) { send(res, 400, { error: String((e as Error).message).slice(0, 140) }); }
      return;
    }

    if (path === BASE + "/subs/switch" && method === "POST") {
      try {
        const b = JSON.parse(await readBody(req)) as { offeringId: string; toSeller: string };
        const plan = activePlan(home, now);
        if (!plan) { send(res, 402, { error: "no_active_plan" }); return; }
        send(res, 200, requestSwitch(home, plan, b.offeringId, b.toSeller, now));
      } catch (e) { send(res, 400, { error: String((e as Error).message).slice(0, 140) }); }
      return;
    }

    if (path === BASE + "/subs/expire" && method === "POST") {
      try {
        const b = JSON.parse((await readBody(req)) || "{}") as { planId?: string };
        const plans = (await import("./subs/journal.js")).readPlans(home);
        const plan = b.planId ? plans.find((p) => p.planId === b.planId) : plans[plans.length - 1];
        if (!plan) { send(res, 404, { error: "E_NO_PLAN" }); return; }
        send(res, 200, expirePeriod(home, plan, now));
      } catch (e) { send(res, 400, { error: String((e as Error).message).slice(0, 140) }); }
      return;
    }

    // ── OpenAI-compatible gateway (buyer side): one key, admission, forward
    // to THE chosen provider, count both sides, no fallback ────────────────
    if (path === BASE + "/gateway/v1/models" && method === "GET") {
      const plan = activePlan(home, now);
      const meters = plan ? allowances(home, plan) : [];
      send(res, 200, { object: "list", data: meters.filter((m) => m.state === "active" && m.unit === "tokens")
        .map((m) => ({ id: m.offeringId, object: "model", nsm: { seller: m.seller, pctLeft: Math.round((1 - m.consumedUnits / m.guaranteedUnits) * 100) } })) });
      return;
    }

    if ((path === BASE + "/gateway/v1/chat/completions" || path === BASE + "/gateway/v1/query") && method === "POST") {
      const bearer = String(ctx.req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const isQueryCall = path.endsWith("/query");
      const keyVerdict = isLocalOrToken(ctx) && !bearer.startsWith("nsm_k_")
        ? authorizeOperatorImplicit(home, { isQuery: isQueryCall, estCostMicroTrac: 0 })
        : authorizeKey(home, { presented: bearer, isQuery: isQueryCall, estCostMicroTrac: 0 });
      if (!keyVerdict.ok) { send(res, keyVerdict.status ?? 401, { error: keyVerdict.code }); return; }
      const keyId = keyVerdict.record.keyId;
      const bc = readBuyerCfg(home);
      if (!bc) { send(res, 503, { error: "E_NO_BUYER_CONFIG" }); return; }
      const plan = activePlan(home, now);
      let parsed: { model?: string; messages?: ChatMessage[]; max_tokens?: number; sparql?: string; offeringId?: string };
      try { parsed = JSON.parse(await readBody(req)); } catch { send(res, 400, { error: "E_BODY" }); return; }
      const offeringId = path.endsWith("/query") ? (parsed.offeringId ?? "") : (parsed.model ?? "");
      const adm = admit(home, { plan, offeringId });
      if (!adm.ok) { send(res, adm.status, adm.body); return; }
      const sellerBase = bc.sellers[adm.allowance.seller]?.apiBase;
      if (!sellerBase) { send(res, 503, { error: "E_SELLER_ENDPOINT_UNKNOWN" }); return; }
      const callId = "call_" + randomBytes(10).toString("hex");
      const wirePath = path.endsWith("/query") ? "/subs/serve/query" : "/subs/serve/chat";
      let up: Response;
      try {
        up = await fetch(sellerBase + BASE + wirePath, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ buyer: plan!.buyer, offeringId, callId, keyId,
            messages: parsed.messages, maxTokens: parsed.max_tokens ?? 256, sparql: parsed.sparql }),
          signal: AbortSignal.timeout(300_000),
        });
      } catch (e) {
        const failure = recordProviderFailure(home, { plan: plan!, allowance: adm.allowance, callId,
          unit: adm.allowance.unit, requestDigest: "sha256:unsent", now, reason: String((e as Error).message).slice(0, 80) });
        send(res, failure.status, failure.body);
        return;
      }
      const body = await up.json() as Record<string, unknown>;
      if (!up.ok) {
        // seller-side refusal or failure: NOTHING charged buyer-side
        const failure = recordProviderFailure(home, { plan: plan!, allowance: adm.allowance, callId,
          unit: adm.allowance.unit, requestDigest: "sha256:refused", now, reason: `upstream ${up.status}` });
        send(res, up.status === 402 ? 402 : failure.status, up.status === 402 ? body : failure.body);
        return;
      }
      // buyer-side count: recount from delivered bytes with our own engine
      // where we hold the bundle; otherwise record the delivered counts and
      // leave verification to spot-checks + checkpoints (both-sides metering
      // still holds: OUR journal entry is OUR count of THIS response).
      let buyerUnits = Number(body.units ?? 0);
      const off = bc.offerings.find((o) => o.offeringId === offeringId);
      if (!path.endsWith("/query") && off?.bundlePath) {
        try {
          const raw = readFileSync(off.bundlePath, "utf8");
          const eng: BpeEngine = off.bundleKind === "hf" ? hfEngine(raw) : tiktokenEngine(raw);
          const outTok = eng.encodeCount(String(body.completion ?? ""));
          buyerUnits = Number(body.inputTokens ?? 0) + outTok;   // input counted at admission parity
        } catch { /* engine unavailable → delivered counts + spot-checks */ }
      }
      recordDelivery(home, { plan: plan!, allowance: adm.allowance, callId, units: buyerUnits,
        unit: adm.allowance.unit, requestDigest: String(body.requestDigest ?? "sha256:na"),
        responseDigest: String(body.responseDigest ?? "sha256:na"), keyId, now });
      {
        const { recordKeyUsage } = await import("./gateway/keys.js");
        recordKeyUsage(home, { keyId, legId: callId, costMicroTrac: buyerUnits, kind: isQueryCall ? "query" : "inference" });
      }
      send(res, 200, path.endsWith("/query")
        ? { body: body.body, returnedRows: body.returnedRows, units: buyerUnits, servedBy: adm.allowance.seller, callId }
        : { id: callId, object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: body.completion }, finish_reason: "stop" }],
            usage: { prompt_tokens: body.inputTokens, completion_tokens: body.outputTokens },
            nsm: { servedBy: adm.allowance.seller, units: buyerUnits, offeringId } });
      return;
    }

    // ── key mint (operator loopback; carried from v3.5 keys machinery) ─────
    if (path === BASE + "/gateway/v1/keys" && method === "POST") {
      if (!isLocalOrToken(ctx)) { send(res, 401, { error: "E_TOKEN" }); return; }
      try {
        const b = JSON.parse((await readBody(req)) || "{}") as { label?: string; budgetMicroTrac?: number };
        send(res, 200, mintKey(home, { label: b.label ?? "key", budgetMicroTrac: b.budgetMicroTrac ?? 1_000_000, expiresAt: null, modelAllowlist: null, allowQuery: true, rps: 5 }));
      } catch (e) { send(res, 400, { error: String((e as Error).message).slice(0, 140) }); }
      return;
    }

    // ── operator status (drives Operate + Plans surfaces) ──────────────────
    if (path === BASE + "/operate/status") {
      if (!isLocalOrToken(ctx)) { send(res, 401, { error: "E_TOKEN" }); return; }
      const enrollments = readEnrollments(home).filter((e) => now < new Date(e.plan.expiresAt));
      const plan = activePlan(home, now);
      send(res, 200, {
        sellerActive: !!mounted.seller && mounted.seller.offerings.size > 0,
        offerings: mounted.seller ? [...new Map([...mounted.seller.offerings.values()].map((o) => [o.offering.id, o])).values()].map((ob) => ({
          id: ob.offering.id,
          modelId: ob.binding.kind === "llamacpp" ? ob.binding.modelId : ob.binding.model,
          tokenizerBundleRef: ob.tokenizerBundleRef,
          offeringUal: ob.offeringUal ?? null,
          ask: askInForce(home, ob.offering.id, mounted!.seller!.providerAddress, plan?.cycle ?? 1),
          queuedAsk: queuedAsk(home, ob.offering.id, mounted!.seller!.providerAddress, plan?.cycle ?? 1),
        })) : [],
        asks: readAsks(home),
        subscribers: enrollments.map((e) => ({
          buyer: e.plan.buyer, periodId: e.plan.periodId, expiresAt: e.plan.expiresAt,
          offerings: e.plan.allocations.filter((a) => a.seller.toLowerCase() === (mounted!.seller?.providerAddress ?? "").toLowerCase()).map((a) => a.offeringId),
          paymentIdentity: e.verifiedPaymentIdentity,
        })),
        revenueWallet: cfg.revenueWallet ?? null,
        statements: readStatements(home).slice(-10),
        checkpointChains: enrollments.map((e) => {
          const pair = `${e.plan.buyer.toLowerCase()}~${(mounted!.seller?.providerAddress ?? "").toLowerCase()}`;
          return { pair, length: checkpointChain(home, pair).length, freshness: freshness(home, pair, now) };
        }),
        buyerPlan: plan ? { planId: plan.planId, periodId: plan.periodId, summaryPct: planSummaryPct(home, plan) } : null,
        keys: listKeys(home).map((k) => ({ ...k, spentMicroTrac: keySpent(home, k.keyId) })),
      });
      return;
    }

    // anything else under /marketplace — including every tab-rail path —
    // falls through unanswered: the daemon 404s it (probe-enforced).
  },
};

export default plugin;
void canonicalize; // referenced to keep the canonical module in the build graph
